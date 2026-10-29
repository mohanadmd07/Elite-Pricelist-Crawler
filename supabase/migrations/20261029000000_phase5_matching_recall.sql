-- ==============================================================================
-- Supabase Migration: Phase 5 Matching Recall & Determinism
-- Follow-up to 20261026000003_phase4_matching_quality.sql
--
-- 1. VOLATILITY FIX: normalize_arabic_medical() calls unaccent(), which is a
--    STABLE function, so declaring the wrapper IMMUTABLE is incorrect and can
--    poison expression-index results after dictionary changes. The Arabic rule
--    set itself is pure; only the Latin unaccent step is not. We split it:
--      - normalize_arabic_medical()   -> IMMUTABLE, no unaccent (pure rules)
--      - name_english_normalized      -> generated with lower(unaccent(...))
--                                         in a STABLE generated column instead
--                                         of a trigger (same semantics, less
--                                         machinery).
-- 2. RECALL: pg_trgm similarity() is order-sensitive; token subsets such as
--    "سكر تراكمي" inside "تحليل سكر تراكمي بالدم" score below threshold even
--    though they are containment matches. word_similarity() is designed for
--    exactly that direction. GREATEST(similarity, word_similarity) raises
--    recall without changing ranking semantics for full-string queries.
-- 3. ALIGNMENT: client-side normalization keeps Latin letters inside Arabic
--    names too (parity test: tests/normalizer-parity.test.ts mirrors these
--    SQL rules against src/lib/arabic-normalizer.ts output).
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ------------------------------------------------------------------------------
-- 1. Pure, IMMUTABLE Arabic/Latin normalizer (no unaccent dependency)
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_arabic_medical(input_text TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    res TEXT;
BEGIN
    IF input_text IS NULL OR input_text = '' THEN
        RETURN '';
    END IF;

    res := lower(input_text);
    -- Strip Tashkeel, Tatweel, and diacritics
    res := regexp_replace(res, '[\u064B-\u065F\u0670\u0640]', '', 'g');
    -- Eastern Arabic-Indic digits to ASCII
    res := translate(res, '٠١٢٣٤٥٦٧٨٩', '0123456789');
    -- Unify Alefs
    res := regexp_replace(res, '[أإآا]', 'ا', 'g');
    -- Unify Yaa & Alef Maqsura
    res := regexp_replace(res, '[ىيی]', 'ي', 'g');
    -- Unify Kaf
    res := regexp_replace(res, '[كک]', 'ك', 'g');
    -- Unify Taa Marbuta & Haa
    res := regexp_replace(res, '[ةهھۀ]', 'ه', 'g');
    -- Unify Hamzas
    res := regexp_replace(res, '[ئؤ]', 'ء', 'g');
    -- Remove punctuation, KEEP latin+digits+arabic letters, collapse whitespace
    res := regexp_replace(res, '[^a-zA-Z0-9\u0621-\u064A\s]', ' ', 'g');
    res := regexp_replace(res, '\s+', ' ', 'g');
    RETURN trim(res);
END;
$$;

-- ------------------------------------------------------------------------------
-- 1b. Immutable wrapper around unaccent() for generated columns & indexes
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.immutable_unaccent(input_text TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
SELECT public.unaccent('unaccent', input_text);
$$;

-- ------------------------------------------------------------------------------
-- 2. Normalized columns: switch to GENERATED STORED (deterministic, declarative)
--    name_arabic_normalized : pure IMMUTABLE rule set
--    name_english_normalized: immutable unaccent wrapper
-- ------------------------------------------------------------------------------
ALTER TABLE public.procedures
    DROP COLUMN IF EXISTS name_arabic_normalized,
    DROP COLUMN IF EXISTS name_english_normalized;

ALTER TABLE public.procedures
    ADD COLUMN name_arabic_normalized TEXT
        GENERATED ALWAYS AS (public.normalize_arabic_medical(name_arabic)) STORED,
    ADD COLUMN name_english_normalized TEXT
        GENERATED ALWAYS AS (lower(public.immutable_unaccent(name_english))) STORED;

DROP TRIGGER IF EXISTS trg_procedures_normalize ON public.procedures;
DROP FUNCTION IF EXISTS public.trg_maintain_procedure_normalized();

-- Rebuild GIN trigram indexes over the regenerated columns
DROP INDEX IF EXISTS idx_procedures_name_ar_norm_trgm;
DROP INDEX IF EXISTS idx_procedures_name_en_norm_trgm;
CREATE INDEX idx_procedures_name_ar_norm_trgm
    ON public.procedures USING gin (name_arabic_normalized gin_trgm_ops);
CREATE INDEX idx_procedures_name_en_norm_trgm
    ON public.procedures USING gin (name_english_normalized gin_trgm_ops);

-- ------------------------------------------------------------------------------
-- 4. Overrides: one live record per normalized query (upsert conflict target
--    used by logProcedureOverride). Without uniqueness every re-save inserts a
--    duplicate row and lookup order decides which wins.
-- ------------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_overrides_norm_query;
CREATE UNIQUE INDEX idx_overrides_norm_query ON public.procedure_overrides (query_text_normalized);

-- ------------------------------------------------------------------------------
-- 5. search_procedures RPC: containment-aware scoring + pass-through code
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.search_procedures(SMALLINT, TEXT, REAL);

CREATE OR REPLACE FUNCTION public.search_procedures(
    p_pricelist_year SMALLINT,
    p_search_term TEXT,
    p_similarity_threshold REAL DEFAULT 0.25
)
RETURNS TABLE (
    id UUID,
    code TEXT,
    name_english TEXT,
    name_arabic TEXT,
    price NUMERIC,
    section_name TEXT,
    similarity REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    norm_ar TEXT;
    norm_en TEXT;
BEGIN
    norm_ar := public.normalize_arabic_medical(p_search_term);
    norm_en := lower(public.immutable_unaccent(p_search_term));

    RETURN QUERY
    SELECT
        p.id,
        p.code,
        p.name_english,
        p.name_arabic,
        p.price,
        COALESCE(s.name_ar, 'عام') AS section_name,
        GREATEST(
            similarity(p.name_arabic_normalized, norm_ar),
            similarity(p.name_english_normalized, norm_en),
            word_similarity(norm_ar, p.name_arabic_normalized),
            word_similarity(norm_en, p.name_english_normalized)
        ) AS similarity
    FROM public.procedures p
    JOIN public.pricelists pl ON pl.id = p.pricelist_id
    LEFT JOIN public.sections s ON s.id = p.section_id
    WHERE pl.year = p_pricelist_year
      AND (
          p.name_arabic_normalized % norm_ar
          OR p.name_english_normalized % norm_en
          OR norm_ar <% p.name_arabic_normalized
          OR norm_en <% p.name_english_normalized
          OR p.code ILIKE ('%' || p_search_term || '%')
      )
      AND GREATEST(
          similarity(p.name_arabic_normalized, norm_ar),
          similarity(p.name_english_normalized, norm_en),
          word_similarity(norm_ar, p.name_arabic_normalized),
          word_similarity(norm_en, p.name_english_normalized)
      ) >= p_similarity_threshold
    ORDER BY similarity DESC
    LIMIT 30;
END;
$$;
