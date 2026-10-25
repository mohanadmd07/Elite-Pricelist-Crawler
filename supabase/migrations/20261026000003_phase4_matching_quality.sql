-- ==============================================================================
-- Supabase Migration: Phase 4 Matching Quality & Arabic Normalization
-- Enforces:
-- 1. Deterministic Arabic medical normalizer function in PostgreSQL.
-- 2. Normalized columns + GIN trigram indexes on public.procedures.
-- 3. Automatic trigger maintaining normalized columns.
-- 4. High-performance search_procedures RPC utilizing normalized trigrams.
-- 5. Semantic match cache table for JSON schema-constrained Gemini predictions.
-- ==============================================================================

-- 1. Ensure required extensions are available
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Deterministic Arabic Normalizer Function
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
    -- Remove non-alphanumeric punctuation and collapse whitespace
    res := regexp_replace(res, '[^a-zA-Z0-9\u0621-\u064A\s]', ' ', 'g');
    res := regexp_replace(res, '\s+', ' ', 'g');
    RETURN trim(res);
END;
$$;

-- 3. Add normalized columns to public.procedures
ALTER TABLE public.procedures
    ADD COLUMN IF NOT EXISTS name_arabic_normalized TEXT,
    ADD COLUMN IF NOT EXISTS name_english_normalized TEXT;

-- Trigger function to automatically maintain normalized columns
CREATE OR REPLACE FUNCTION public.trg_maintain_procedure_normalized()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.name_arabic_normalized := public.normalize_arabic_medical(NEW.name_arabic);
    NEW.name_english_normalized := lower(unaccent(NEW.name_english));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_procedures_normalize ON public.procedures;
CREATE TRIGGER trg_procedures_normalize
    BEFORE INSERT OR UPDATE ON public.procedures
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_maintain_procedure_normalized();

-- Populate existing rows if any exist
UPDATE public.procedures
SET name_arabic_normalized = public.normalize_arabic_medical(name_arabic),
    name_english_normalized = lower(unaccent(name_english))
WHERE name_arabic_normalized IS NULL OR name_english_normalized IS NULL;

-- 4. GIN Trigram Indexes on Normalized Columns
CREATE INDEX IF NOT EXISTS idx_procedures_name_ar_norm_trgm 
    ON public.procedures USING gin (name_arabic_normalized gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_procedures_name_en_norm_trgm 
    ON public.procedures USING gin (name_english_normalized gin_trgm_ops);

-- 5. Updated High-Performance Search Procedures RPC
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
    norm_en := lower(unaccent(p_search_term));

    RETURN QUERY
    SELECT 
        p.id,
        p.code,
        p.name_english,
        p.name_arabic,
        p.price,
        COALESCE(s.name_ar, 'عام') as section_name,
        GREATEST(
            similarity(p.name_arabic_normalized, norm_ar),
            similarity(p.name_english_normalized, norm_en)
        ) as similarity
    FROM public.procedures p
    JOIN public.pricelists pl ON pl.id = p.pricelist_id
    LEFT JOIN public.sections s ON s.id = p.section_id
    WHERE pl.year = p_pricelist_year
      AND (
          p.name_arabic_normalized % norm_ar
          OR p.name_english_normalized % norm_en
          OR p.code ILIKE ('%' || p_search_term || '%')
      )
      AND GREATEST(
          similarity(p.name_arabic_normalized, norm_ar),
          similarity(p.name_english_normalized, norm_en)
      ) >= p_similarity_threshold
    ORDER BY similarity DESC
    LIMIT 30;
END;
$$;

-- 6. Semantic Match Cache Table (Caches Gemini Structured Predictions)
CREATE TABLE IF NOT EXISTS public.semantic_match_cache (
    query_hash TEXT PRIMARY KEY,
    query_normalized TEXT NOT NULL,
    matched_candidate_id TEXT,
    matched_code TEXT,
    matched_name TEXT,
    confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1.0),
    confidence_tier TEXT NOT NULL CHECK (confidence_tier IN ('auto_accept', 'needs_review', 'reject')),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_match_cache_norm_query ON public.semantic_match_cache (query_normalized);
CREATE INDEX IF NOT EXISTS idx_match_cache_code ON public.semantic_match_cache (matched_code);

ALTER TABLE public.semantic_match_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read semantic match cache"
    ON public.semantic_match_cache FOR SELECT
    TO public
    USING (true);

CREATE POLICY "Service role write semantic match cache"
    ON public.semantic_match_cache FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
