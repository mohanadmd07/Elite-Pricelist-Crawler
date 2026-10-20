-- ==============================================================================
-- Elite Pricelist Explorer - Supabase PostgreSQL Schema Migration
-- Designed per /supabase-postgres-best-practices
-- ==============================================================================

-- 1. Enable Required Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- Trigram GIN indexing for fast fuzzy search
CREATE EXTENSION IF NOT EXISTS unaccent;      -- Stripping diacritics / accents

-- 2. User Profiles & Staff Roles
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'sales_rep', 'billing_clerk', 'staff')),
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 3. Sales Representatives
CREATE TABLE IF NOT EXISTS public.sales_reps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_ar TEXT NOT NULL,
    name_en TEXT,
    email TEXT,
    phone TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 4. Corporate Companies & Contractors
CREATE TABLE IF NOT EXISTS public.companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    normalized_name TEXT NOT NULL,
    sales_rep_id UUID REFERENCES public.sales_reps(id) ON DELETE SET NULL,
    price_list_year SMALLINT NOT NULL CHECK (price_list_year BETWEEN 2020 AND 2035),
    discount_percentage NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (discount_percentage >= 0 AND discount_percentage <= 100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 5. Hospital Pricelists (Master years: 2023, 2024, 2025, etc.)
CREATE TABLE IF NOT EXISTS public.pricelists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    year SMALLINT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 6. Hospital Clinical Sections / Departments
CREATE TABLE IF NOT EXISTS public.sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    code TEXT UNIQUE
);

-- 7. Medical Procedures Catalog
CREATE TABLE IF NOT EXISTS public.procedures (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pricelist_id UUID NOT NULL REFERENCES public.pricelists(id) ON DELETE CASCADE,
    section_id UUID REFERENCES public.sections(id) ON DELETE SET NULL,
    code TEXT,
    name_english TEXT NOT NULL,
    name_arabic TEXT NOT NULL,
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 8. User Search History / Audit Logs
CREATE TABLE IF NOT EXISTS public.search_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
    query_text TEXT NOT NULL,
    matched_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- ==============================================================================
-- Strategic Indexes (query-composite-indexes, query-index-types)
-- ==============================================================================

-- Trigram GIN indexes for sub-15ms fuzzy search on procedure names in English and Arabic
CREATE INDEX IF NOT EXISTS idx_procedures_name_en_trgm ON public.procedures USING gin (name_english gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_procedures_name_ar_trgm ON public.procedures USING gin (name_arabic gin_trgm_ops);

-- Compound index for filtered queries by pricelist and price
CREATE INDEX IF NOT EXISTS idx_procedures_pricelist_lookup ON public.procedures (pricelist_id, price);

-- Foreign Key B-Tree indexes (prevents full table locks and scans)
CREATE INDEX IF NOT EXISTS idx_procedures_section_id ON public.procedures (section_id);
CREATE INDEX IF NOT EXISTS idx_companies_sales_rep_id ON public.companies (sales_rep_id);
CREATE INDEX IF NOT EXISTS idx_companies_normalized_name ON public.companies (normalized_name);
CREATE INDEX IF NOT EXISTS idx_search_logs_user_created ON public.search_logs (user_id, created_at DESC);

-- Partial index for active pricelists
CREATE INDEX IF NOT EXISTS idx_pricelists_active ON public.pricelists (year) WHERE is_active = true;

-- ==============================================================================
-- High-Performance Search Procedures RPC Function
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.search_procedures(
    p_pricelist_year SMALLINT,
    p_search_term TEXT,
    p_similarity_threshold REAL DEFAULT 0.25
)
RETURNS TABLE (
    id UUID,
    name_english TEXT,
    name_arabic TEXT,
    price NUMERIC,
    section_name TEXT,
    source_file TEXT,
    similarity REAL
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.name_english,
        p.name_arabic,
        p.price,
        COALESCE(s.name_ar, 'عام') AS section_name,
        pl.title AS source_file,
        GREATEST(
            similarity(p.name_english, p_search_term),
            similarity(p.name_arabic, p_search_term)
        ) AS similarity
    FROM public.procedures p
    JOIN public.pricelists pl ON p.pricelist_id = pl.id
    LEFT JOIN public.sections s ON p.section_id = s.id
    WHERE pl.year = p_pricelist_year
      AND (
          p.name_english ILIKE '%' || p_search_term || '%'
          OR p.name_arabic ILIKE '%' || p_search_term || '%'
          OR similarity(p.name_english, p_search_term) > p_similarity_threshold
          OR similarity(p.name_arabic, p_search_term) > p_similarity_threshold
      )
    ORDER BY similarity DESC, p.price ASC
    LIMIT 50;
END;
$$;

-- ==============================================================================
-- Row-Level Security (RLS) Policies
-- Optimizing auth.uid() using (SELECT auth.uid()) subquery caching per Supabase rules
-- ==============================================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_reps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pricelists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procedures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_logs ENABLE ROW LEVEL SECURITY;

-- Master Data Read Access (All authenticated hospital staff)
CREATE POLICY "Staff can view pricelists" 
    ON public.pricelists FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can view companies" 
    ON public.companies FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can view procedures" 
    ON public.procedures FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can view sections" 
    ON public.sections FOR SELECT TO authenticated USING (true);

CREATE POLICY "Staff can view sales_reps" 
    ON public.sales_reps FOR SELECT TO authenticated USING (true);

-- User Isolation on Search Logs
CREATE POLICY "Users can view own search history" 
    ON public.search_logs FOR SELECT TO authenticated 
    USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert own search history" 
    ON public.search_logs FOR INSERT TO authenticated 
    WITH CHECK (user_id = (SELECT auth.uid()));

-- User Profile Security
CREATE POLICY "Users can view staff profiles" 
    ON public.profiles FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can update own profile" 
    ON public.profiles FOR UPDATE TO authenticated 
    USING (id = (SELECT auth.uid()))
    WITH CHECK (id = (SELECT auth.uid()));
