# Architectural Redesign Specification: Inpatient Approvals & Normalization Pipeline

## 1. Executive Summary & Purpose

The **Elite Pricelist & Inpatient Approvals** platform is being upgraded from an unstable, monolithic, in-memory polling script (`approvals-watcher.ts`) to a high-reliability, two-stage decoupled architecture.

### Root Causes Solved:
1. **Unreliable Email Sync:** The previous in-memory watcher attempted EWS/IMAP polling, HTML parsing, AI inference, contractor matching, and database updates in a single fragile loop. Network glitches or Exchange timeouts caused complete sync freezes, dropped emails, and memory leaks.
2. **Inaccurate Normalizations:** Procedure matching previously attempted regex heuristics or unanchored full-prompt LLM lookups across 10,000+ catalog rows, leading to false-positive matches, missed billing codes, and hallucinated prices.

---

## 2. Understanding Lock & Assumptions

### Understanding Summary:
* **What is being built:** A decoupled, database-first architecture separating EWS ingestion into a raw staging layer, followed by a resilient multi-stage normalization engine combining PostgreSQL `pg_trgm` candidate retrieval, Gemini reranking, and an explicit contractor alias dictionary.
* **Who it is for:** Elite Hospital insurance coordinators, billing clerks, and clinical administrators.
* **Key Constraints:** 
  * On-premise Exchange server (`wmail.elitehospital.org` via EWS / NTLM).
  * High-variability bilingual (Arabic/English) clinical terminology.
  * Realtime dashboard requirements on desktop and hospital mobile tablets.

### Assumptions:
1. **Database-first Staging:** All incoming emails are persisted immediately into a relational `raw_email_staging` table before any processing occurs.
2. **Idempotent Ingestion:** The `ews_item_id` serves as a natural unique constraint. Duplicate emails or re-runs are no-ops.
3. **Decoupled Workers:** Email sync runs independently of NLP normalization. Mail server drops do not affect UI data, and LLM rate limits do not block email ingestion.
4. **Denormalized Realtime Layer:** Firestore acts as the presentation sink for the React web dashboard, providing single-document zero-join instant reads and real-time updates.

---

## 3. Decision Log

| # | Topic | Decision | Alternatives Considered | Rationale |
|---|---|---|---|---|
| 1 | Architecture | Decoupled 2-stage pipeline (Ingestion $\to$ Normalization) | Monolithic polling daemon | Prevents sync lockups; isolates network I/O from AI/parsing errors. |
| 2 | Raw Staging | Supabase PostgreSQL `raw_email_staging` with `ews_item_id` unique index | Local file/JSON | Guarantees atomic writes, queryability, and zero duplicate processing. |
| 3 | Procedure Search | PostgreSQL `pg_trgm` candidate retrieval + Gemini top-5 rerank | Full-catalog LLM prompting, pure regex | Sub-15ms candidate retrieval, eliminates hallucinations, guarantees valid catalog IDs. |
| 4 | Worker Lifecycle | Node.js clean worker with `SIGTERM` graceful shutdown (`/nodejs-best-practices`) | Unmanaged script in terminal loop | Ensures database connection pools and in-flight batches finish cleanly without state drift. |
| 5 | Presentation Storage | Firestore with denormalized document model (`/firebase`) | On-the-fly SQL joins in frontend | Ultra-fast single-document reads and zero-config realtime team updates. |
| 6 | Frontend Performance | React.memo card list + direct module imports (`/react-best-practices`) | Unmemoized large list with barrel imports | Prevents UI stutter during live syncs and keeps bundle size lean. |
| 7 | UI/UX & Accessibility | WCAG AA dual-encoding badges, confidence chips, 44px targets (`/ui-ux-pro-max`) | Text-only table, color-only badges | Fast, error-free clinical reviews on both desktop and hospital mobile devices. |
| 8 | Resilience & Fallback | Atomic claim pattern + heuristic fallback on AI 429 | Hard-fail or crash on AI error | Zero pipeline downtime; unblocked hospital operations even during network outages. |

---

## 4. Architectural Components & Data Flow

```
                      [On-Prem EWS / Exchange]
                                 │
                   (Fetch Delta via SyncState Token)
                                 ▼
     ┌─────────────────────────────────────────────────────────┐
     │ Stage 1: Ingestion Worker (Node.js / Python)            │
     │ - Exponential backoff with jitter on network 5xx        │
     │ - Graceful shutdown on SIGTERM                          │
     │ - Idempotent upsert via ews_item_id                     │
     └───────────────────────────┬─────────────────────────────┘
                                 ▼
     ┌─────────────────────────────────────────────────────────┐
     │ Supabase PostgreSQL (Staging & Master Data Layer)       │
     │ 1. raw_email_staging (Status: pending -> completed)     │
     │ 2. contractor_aliases (Deterministic map -> Officer)    │
     │ 3. procedures (10k+ rows with pg_trgm GIN index)        │
     └───────────────────────────┬─────────────────────────────┘
                                 ▼
     ┌─────────────────────────────────────────────────────────┐
     │ Stage 2: Normalization & Matching Engine                │
     │ 1. HTML & HIS Parser (Clean table extraction)           │
     │ 2. Exact Contractor/Officer Alias Resolver              │
     │ 3. Two-Step Hybrid Procedure Matcher:                   │
     │    - Step A: pg_trgm candidate retrieval (top 5, <15ms) │
     │    - Step B: Gemini reranking & verification            │
     │ 4. Draft Reply & WhatsApp CM Message Builder            │
     └───────────────────────────┬─────────────────────────────┘
                                 │
                  (writeBatch <= 500 ops)
                                 ▼
     ┌─────────────────────────────────────────────────────────┐
     │ Presentation Sink (Firestore `inpatient_approvals`)     │
     │ - Denormalized JSON document per approval               │
     │ - Realtime listener (onSnapshot) for live dashboard     │
     └───────────────────────────┬─────────────────────────────┘
                                 │
                   (SWR + Virtualized Memoized Cards)
                                 ▼
     ┌─────────────────────────────────────────────────────────┐
     │ React / Vite Frontend Dashboard                         │
     │ - WCAG 2.1 AA Compliant Indicators                      │
     │ - One-click procedure override modal                    │
     │ - 44px tap targets for mobile hospital tablets          │
     └─────────────────────────────────────────────────────────┘
```

---

## 5. Database Schema Specifications

### PostgreSQL / Supabase Staging Tables

```sql
-- 1. Raw Email Staging
CREATE TABLE IF NOT EXISTS public.raw_email_staging (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ews_item_id TEXT NOT NULL UNIQUE,
    ews_change_key TEXT,
    conversation_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    raw_html TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_raw_email_status ON public.raw_email_staging (status, retry_count);
CREATE INDEX IF NOT EXISTS idx_raw_email_conversation ON public.raw_email_staging (conversation_id);

-- 2. Contractor Aliases Dictionary
CREATE TABLE IF NOT EXISTS public.contractor_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias_name TEXT NOT NULL UNIQUE,
    canonical_company_name TEXT NOT NULL,
    default_price_list_year SMALLINT NOT NULL DEFAULT 2025,
    assigned_officer TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_contractor_alias_search ON public.contractor_aliases (alias_name);

-- 3. Procedure Fuzzy Search Index (pg_trgm)
CREATE INDEX IF NOT EXISTS idx_procedures_name_en_trgm ON public.procedures USING gin (name_english gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_procedures_name_ar_trgm ON public.procedures USING gin (name_arabic gin_trgm_ops);
```

---

## 6. UI/UX Specifications (`/ui-ux-pro-max`)

1. **Card Hierarchy & Scannability:**
   * Patient Banner: Full Name, MRN, Bed/Room, Admission Type.
   * Dual-Encoding Status Chips:
     * **Approved**: Emerald (`#059669`) + CheckCircle
     * **In-Review**: Amber (`#D97706`) + Clock
     * **Rejected / Non-Covered**: Rose (`#DC2626`) + XCircle
     * **Partial / Co-Pay**: Indigo (`#4F46E5`) + Percent
2. **Confidence Scores & Manual Override:**
   * Procedure matches display confidence chips (e.g., `96% Match`).
   * Clicking a procedure opens an instant autocomplete dropdown pre-filtered via `search_procedures` RPC, allowing insurance staff to manually override the match in one keystroke.
3. **Ergonomics & Mobile Tablet Readiness:**
   * Minimum 44×44px hit-targets for buttons.
   * `Cairo` / `Inter` font pairings with `line-height: 1.6` to prevent Arabic vowel clipping.

---

## 7. Migration & Rollout Strategy

1. **Phase 1: Database Migration:** Apply `raw_email_staging` and `contractor_aliases` tables to Supabase. Seed existing contractor names and aliases from `data/contractors.json`.
2. **Phase 2: Ingestion Service:** Deploy the lightweight EWS staging fetcher with watermark persistence.
3. **Phase 3: Hybrid Normalizer:** Implement the 2-step candidate retrieval (`search_procedures` RPC + Gemini top-5 rerank) and pipeline sink to Firestore.
4. **Phase 4: Frontend Polish:** Add confidence chips, override autocomplete, and memoized card components per `/react-best-practices` and `/ui-ux-pro-max`.
