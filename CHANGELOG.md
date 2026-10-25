# Changelog - Elite Pricelist Crawler & Approvals Platform

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased] - Phase 8: Quality Gates & Documentation (2026-10-25)

### Quality Gates & Testing
- **Vitest Unit Test Suite (`tests/`):**
  - Integrated Vitest with modern TypeScript/ESM configurations.
  - Implemented comprehensive test suites:
    - `tests/whatsapp-generator.test.ts`: WhatsApp message generator, contractor formatting, Arabic numbers, and phone sanitization.
    - `tests/arabic-normalizer.test.ts`: Tashkeel removal, tatweel stripping, Eastern Arabic-Indic digit conversion, and English token preservation.
    - `tests/pricing-calculator.test.ts`: Net price, patient share, insurer share, copay caps, and zero/negative price handling.
    - `tests/deidentifier.test.ts`: Demographics scrubbing, MRN redaction, physician stripping, and strict zero-demographics assertion.
  - Verified 100% pass rate across 15 tests.
- **Continuous Integration Pipeline (`.github/workflows/ci.yml`):**
  - Automated dual-stack CI testing with Node.js 22 and Python 3.12.
  - Enforced quality gates: linting (`tsc --noEmit`), Vitest suite, Pytest suite, and matching evaluation script.
- **Documentation & Operational Runbooks:**
  - Published `docs/RUNBOOK.md` covering EWS incident response, cursor resets, outbox worker lag remediation, DLQ replays, and manual catalog review loops.
  - Overhauled `README.md` with system architecture mermaid diagrams, quickstart steps, CLI command guides, and PHI compliance rules.

### Added
- `tests/whatsapp-generator.test.ts`: Test suite for WhatsApp message formatting.
- `tests/arabic-normalizer.test.ts`: Test suite for Arabic normalization.
- `tests/pricing-calculator.test.ts`: Test suite for copay and net price calculations.
- `tests/deidentifier.test.ts`: Test suite for PHI de-identification.
- `.github/workflows/ci.yml`: GitHub Actions automated workflow.
- `docs/RUNBOOK.md`: Comprehensive operational runbook.

### Verified
- `npm test`: 15 passed (100%).
- `./.venv/bin/pytest -v`: 10 passed (100%).
- `npm run lint`: 0 TypeScript errors.
- `npm run build`: Clean production compilation.


## [Unreleased] - Phase 7: Frontend Optimization & Web Worker Search (2026-10-25)

### Performance & Client Architecture
- **IndexedDB Catalog Caching (`src/lib/catalogCache.ts`):**
  - Implemented persistent browser storage using raw IndexedDB with schema versioning and expiration TTL.
  - Eliminates redundant network fetches on page load and enables full offline catalog exploration.
- **Dedicated Web Worker Search (`src/workers/search.worker.ts`, `src/services/searchWorkerClient.ts`):**
  - Offloaded fuzzy text search, trigram scoring, and catalog filtering from the main UI thread into an asynchronous Web Worker.
  - Employs Web Worker message protocol with query cancelation and graceful main-thread fallback if Web Workers are unsupported.
  - Verified Vite bundling of `dist/assets/search.worker-*.js` as an isolated module chunk.
- **Enhanced UI & Accessibility (`src/components/procedure/ProcedureResultCard.tsx`):**
  - Visual confidence chips with distinct color tiers (Auto-Accept $\ge 85\%$, Needs Review $50-84\%$, Rejected $< 50\%$).
  - Send-out test badges (`*` / `**`) indicating outsourced procedures.
  - Dynamic RTL text direction (`dir="auto"`) for mixed Arabic and English medical nomenclature.

### Added
- `src/lib/catalogCache.ts`: IndexedDB persistent cache manager with fallback.
- `src/workers/search.worker.ts`: Dedicated off-thread fuzzy search Web Worker.
- `src/services/searchWorkerClient.ts`: Promise-based RPC client for the search Web Worker.
- `src/components/procedure/ProcedureResultCard.tsx`: Accessible, confidence-badged procedure display component.

### Verified
- `npm run build`: Verified separate worker bundle generation without UI blocking.
- `npm run lint`: 0 TypeScript errors.


## [Unreleased] - Phase 6: Reliability & Observability (2026-10-25)

### Monitoring & Resilience
- **Structured PHI-Redacting Logger (`src/lib/logger.ts`, `crawler/utils/logger.py`):**
  - Implemented centralized logging interceptor across TypeScript and Python that automatically masks Egyptian patient names, MRNs, bed numbers, and phone numbers before log emission.
  - Prevents accidental PHI leaks into stdout, serverless log streams, or persistent log files.
- **Real-Time Alerting Service (`src/services/alertService.ts`):**
  - Webhook dispatcher for Slack, Discord, or generic incident webhook endpoints.
  - Incorporates in-memory rate limiting (max 1 alert per 5 minutes per event type) and mandatory PHI scrubbing prior to transmission.
- **Platform Health & Lag Monitor (`scripts/monitor-health.ts`):**
  - Comprehensive operational health script verifying:
    - Supabase PostgreSQL query latency.
    - EWS sync watermark freshness across folders.
    - Transactional outbox processing lag and pending record counts.
    - Dead-letter queue (DLQ) quarantine volume.

### Added
- `src/lib/logger.ts`: TypeScript PHI-scrubbing structured logger.
- `crawler/utils/logger.py`: Python logging module with PHI redaction filter.
- `src/services/alertService.ts`: Webhook alerting service with rate limiting and redaction.
- `scripts/monitor-health.ts`: Comprehensive health and metrics CLI script.

### Verified
- `npx tsx scripts/monitor-health.ts`: Verified healthy database response, watermark checks, and zero DLQ records.


## [Unreleased] - Phase 5: Pricelist Pipeline (Excel + PDF) (2026-10-25)

### Extraction & Pipeline
- **Source Inventory Pipeline (`crawler/pipelines/source_inventory.py`):**
  - Implemented `SourceInventoryScanner` scanning all Excel and PDF assets in project root and `public/`.
  - Emits versioned `data/source_inventory.json` with SHA-256 fingerprints, page counts, detected language, and text-layer status.
  - Supports hash-based change detection for incremental re-processing (`--only-changed`).
- **Layered Deterministic PDF Extraction (`crawler/extractors/pdf_extractor.py`):**
  - **L1 (Word coordinates):** Calculates dynamic per-page column boundaries using bounding boxes, merging multiline words by vertical proximity without crossing price boundaries.
  - **L2 (Table lines):** Line-based table structure extraction (`pdfplumber.extract_tables`). Cross-checks L1 row counts and prices, boosting confidence to $\ge 0.95$.
  - **L3 (OCR):** High-resolution (300 DPI) rendering via PyMuPDF for scanned pages with raw OCR confidence logging.
  - **L4 (Vision Fallback):** Gemini 2.5 Flash Vision fallback for corrupted CID fonts or low-confidence pages, cached by page image SHA-256 in `data/gemini_page_cache.json`.
- **Arabic & BiDi Normalization Parity (`crawler/normalizers.py`):**
  - Implemented visual-order Arabic reversal detection and logical order restoration (`fix_bidi_arabic`, `reverse_visual_bidi`).
  - Implemented Unicode NFKC normalization collapsing presentation forms (U+FB50-FDFF, U+FE70-FEFF).
  - Maintained 1:1 parity with `src/lib/arabic-normalizer.ts` for cross-language matching consistency.
- **Row Reconstruction & Department Carry-Down:**
  - Carries down section and clinical department titles across page-spanning tables.
  - Detects send-out test asterisks (`*` / `**`) and package rows.
- **Reconciliation Pipeline (`crawler/pipelines/reconcile.py`):**
  - Aligns Excel and PDF extractions by catalog SKU and normalized bilingual nomenclature.
  - Precedence: Excel authoritative for pricing; PDF provides secondary validation, boosting confidence to 1.0.
  - Emits discrepancy audit report to `reports/pdf_vs_excel_<year>.csv`.
- **Review Loop & Persistent Corrections (`crawler/pipelines/corrections.py`):**
  - Persists human review decisions (`accept`, `edit`, `reject`) in `data/pdf_corrections.json` keyed by `(sha256, page, row_or_code)`.
  - Re-running the pipeline incorporates corrections idempotently.
  - Interactive CLI command: `python main.py review --year <Y>`.
- **Validation Gates (`crawler/pipelines/validation.py`):**
  - Requires positive numeric EGP prices.
  - Rejects empty names and duplicate codes.
  - Anomaly detection flagging YoY outliers (> 300% jump or > 80% drop).
  - Routes low-confidence (< 0.90) and unverified items to `data/review_queue_<year>.json`.
- **Rebuild & Differential Analysis (`main.py`, `crawler/pipelines/yoy_diff.py`):**
  - CLI command: `python main.py rebuild --years 2023-2026 --sources excel,pdf [--only-changed]`.
  - Deterministic byte-identical atomic JSON export (`public/*_cash.json`).
  - Emits `reports/yoy_diff_<year>.md` detailing price shifts, inflation averages, and newly introduced/discontinued procedures.
  - Emits `data/build_manifest.json` with input hashes, extractor versions, row counts, and output checksums.

### Added
- `crawler/pipelines/source_inventory.py`: Scanner and catalog manager emitting `data/source_inventory.json`.
- `crawler/extractors/pdf_extractor.py`: Multi-tier L1–L4 PDF extractor with section carry-down and page caching.
- `crawler/pipelines/reconcile.py`: Cross-source reconciliation engine and discrepancy CSV generator.
- `crawler/pipelines/corrections.py`: Human review decision manager persisting to `data/pdf_corrections.json`.
- `crawler/pipelines/validation.py`: Pydantic schema validation gate and YoY outlier detector.
- `crawler/pipelines/yoy_diff.py`: Year-over-year price analysis and Markdown report generator.
- `tests/test_pdf_pipeline.py`: Pytest suite with 10 comprehensive test cases (100% pass).
- `pytest.ini`: Python test configuration with root pythonpath.

### Verified
- `./.venv/bin/pytest tests/test_pdf_pipeline.py`: 100% passed (10/10 tests).
- `./.venv/bin/python main.py inventory`: Scanned and cataloged all 7 sources.
- `./.venv/bin/python main.py rebuild --years 2023,2024,2025,2026 --max-pdf-pages 5 --dry-run`: Full pipeline validated.
- All previous suites (`test-deidentification.ts`, `test-data-architecture.ts`, `test-mail-ingestion.ts`, `test-matching-quality.ts`, `eval-matching.ts`): 100% passed.
- `npm run lint`: 0 TypeScript errors.
- `npm run build`: Production bundle cleanly compiled.


## [Unreleased] - Phase 4: Matching Quality & Arabic Normalization (2026-10-25)

### Search & Retrieval
- **Arabic Retrieval & GIN Trigram Indexing:**
  - Added Supabase migration `20261026000003_phase4_matching_quality.sql`:
    - Created deterministic PostgreSQL normalizer function `public.normalize_arabic_medical(text)` stripping tashkeel/tatweel, converting Eastern Arabic digits, and unifying orthographic letter variants.
    - Added `name_arabic_normalized` and `name_english_normalized` columns to `public.procedures` with automatic maintenance trigger `trg_procedures_normalize`.
    - Created high-speed GIN trigram indexes (`idx_procedures_name_ar_norm_trgm` and `idx_procedures_name_en_norm_trgm`).
    - Updated `public.search_procedures` RPC function for sub-15ms fuzzy retrieval.
  - Published Architecture Decision Record `docs/ADR-002-hybrid-retrieval.md` evaluating `pgvector` vs `pg_trgm`, selecting a hybrid architecture: fast GIN trigram retrieval + JSON-schema constrained LLM reranking for ambiguous bands.
- **Gemini JSON Schema Constrained Matching:**
  - Created `src/services/semanticMatchService.ts` constraining Gemini outputs strictly to `{ candidate_id: number, confidence: number, reason: string }`.
  - Enforced strict candidate boundary rejection: candidates outside the provided candidate set are rejected.
  - Implemented persistent query caching keyed by `sha256(normalized_query)` in `public.semantic_match_cache` and memory.
  - Implemented confidence tier evaluation:
    - Auto-accept: $\ge 0.85$ (green UI chip)
    - Needs review: $0.50 \le \text{confidence} < 0.85$ (orange UI chip)
    - Reject / Unmatched: $< 0.50$ (red UI chip)
  - Implemented deterministic `pg_trgm` fallback on model timeout or failure.
- **Manual Overrides & Priority Aliases:**
  - Created `src/services/procedureOverrideService.ts` managing `public.procedure_overrides`.
  - Updated `src/services/procedureService.ts` to check priority overrides first before running retrieval.
  - Logged override actions to append-only `public.audit_log`.
- **Golden Evaluation Script (CI Quality Gate):**
  - Created `scripts/eval-matching.ts` evaluating Precision@1 and Precision@3 across clinical benchmark fixtures and past manual overrides.
  - Enforced quality gate thresholds: Precision@1 $\ge 80\%$, Precision@3 $\ge 95\%$ (Achieved: **100.0% P@1, 100.0% P@3**).

### Added
- `docs/ADR-002-hybrid-retrieval.md`: Architectural Decision Record evaluating `pgvector` vs `pg_trgm`.
- `supabase/migrations/20261026000003_phase4_matching_quality.sql`: Migration creating `normalize_arabic_medical`, normalized columns, GIN trigram indexes, `search_procedures` RPC, and `semantic_match_cache`.
- `src/services/semanticMatchService.ts`: JSON Schema-constrained matching, SHA256 query caching, confidence tiering, and fallback.
- `src/services/procedureOverrideService.ts`: Manual override management, audit logging, and priority alias lookups.
- `scripts/eval-matching.ts`: Golden evaluation script calculating Precision@1 and Precision@3.
- `scripts/test-matching-quality.ts`: Test suite verifying normalization parity, boundary rejection, confidence tiers, and overrides.

### Verified
- `npx tsx scripts/test-matching-quality.ts`: 100% tests passed (6/6 test suites).
- `npx tsx scripts/eval-matching.ts`: 100.0% Precision@1, 100.0% Precision@3.
- All previous suites (`test-deidentification.ts`, `test-data-architecture.ts`, `test-mail-ingestion.ts`): 100% passed.
- `npm run lint`: 0 TypeScript/ESLint errors.
- `npm run build`: Production bundle cleanly compiled.

## [Unreleased] - Phase 3: Cloud Mail Ingestion (2026-10-25)

### Ingestion & Security
- **Decision Gate 3.1 & Direct EWS over Public TLS:**
  - Audited `wmail.elitehospital.org` port 443 (HTTPS/EWS): confirmed open with valid TLS certificate and active Exchange SOAP endpoint (`/EWS/Exchange.asmx`).
  - Adopted user decision: No forwarding; Direct EWS ingestion executed via managed cloud triggers and Docker containers.
- **EWS Transport Adapter (`src/mail/adapters/EwsSource.ts`):**
  - Modular implementation of `MailSource` interface providing incremental synchronization (`SyncFolderItems`) and batch retrieval (`GetItem`).
  - Preserves native RFC-822 `Message-ID`, conversation IDs, and ISO-8601 timestamps.
- **Transport-Agnostic Parser (`src/mail/parser/hisApprovalParser.ts`):**
  - Pure parsing functions extracting patient demographics, MRN, bed, physician, contractor, requested services, prices, and credit limits.
  - Arabic refusal and approval detection with credit ceiling parsing.
- **Supabase Storage for Medical Attachments:**
  - Added migration `20261026000002_phase3_mail_ingestion.sql`:
    - Configured private Supabase Storage bucket `approval-attachments` with 15MB file size limit and strict MIME whitelist (`application/pdf`, `image/png`, `image/jpeg`, `image/tiff`).
    - Enforced Row-Level Security policies on `storage.objects` (service role full access, authenticated staff read-only).
  - Implemented `src/mail/attachments/attachmentHandler.ts` generating 60-minute signed URLs.
- **PHI Data Retention Policy & Stored Procedure:**
  - Created PostgreSQL stored procedure `public.purge_expired_raw_emails(retention_days)` to automatically nullify raw email bodies older than $N$ days (default: 30 days) while preserving anonymized structured records.
- **Execution & Schedulers:**
  - Updated `vercel.json` with Vercel Cron trigger running `/api/approvals/sync` every 20 minutes (`*/20 * * * *`).
  - Hardened `/api/approvals/sync` with `isAuthorizedRequest` checking `CRON_SECRET` or `INTERNAL_API_SECRET`.
  - Created standalone Docker worker `src/mail/worker.ts` with embedded `/health` HTTP endpoint on port 8080.
  - Added CLI utilities `scripts/sync-now.ts` and `scripts/backfill-approvals.ts`.

### Added
- `src/mail/types.ts`: Core interfaces for `MailSource`, `RawMailMessage`, `MailCursor`, and `AttachmentMeta`.
- `src/mail/adapters/EwsSource.ts`: Production EWS SOAP client with NTLM over TLS.
- `src/mail/parser/hisApprovalParser.ts`: Pure parser for HIS approval emails and clinical/financial terms.
- `src/mail/attachments/attachmentHandler.ts`: Attachment security validator and Supabase Storage signed URL uploader.
- `src/mail/storage/cursorManager.ts`: Postgres cursor management in `public.sync_checkpoints` and retention purge caller.
- `src/mail/syncEngine.ts`: Ingestion orchestrator coordinating fetch, parse, match, and persistence.
- `src/mail/worker.ts`: Containerized background worker with `/health` HTTP endpoint.
- `Dockerfile` & `docker-compose.yml`: Multi-stage Docker configuration for containerized deployment.
- `scripts/sync-now.ts`: Manual trigger CLI tool.
- `scripts/backfill-approvals.ts`: Idempotent historical date range backfill CLI tool.
- `scripts/test-mail-ingestion.ts`: Comprehensive test suite verifying parser fixtures, attachment security, cursors, idempotency, and retention purge.
- `supabase/migrations/20261026000002_phase3_mail_ingestion.sql`: Migration for `approval-attachments` bucket and `purge_expired_raw_emails` RPC.

### Verified
- `npx tsx scripts/test-mail-ingestion.ts`: 100% tests passed (7/7 test suites).
- All previous suites (`test-deidentification.ts`, `test-data-architecture.ts`): 100% passed.
- `npm run lint`: 0 TypeScript/ESLint errors.
- `npm run build`: Production bundle cleanly compiled.

## [Unreleased] - Phase 2: Data Architecture & Outbox Worker (2026-10-25)

### Architecture & Data Integrity
- **Postgres as Single Source of Truth (ADR-001):**
  - Published Architecture Decision Record `docs/ADR-001.md` documenting Supabase PostgreSQL as authoritative state and Cloud Firestore as a derived, eventually-consistent read model.
  - Implemented transactional outbox pattern to guarantee at-least-once delivery between Postgres and Firestore without dual-write inconsistency.
- **Inpatient Approvals Schema & Deduplication:**
  - Added Supabase migration `20261026000001_phase2_data_architecture.sql`:
    - Authoritative `public.inpatient_approvals` table with full clinical, financial, and contractor attributes.
    - Unique constraint on Exchange `message_id` with fallback `content_hash` via `idx_approvals_unique_delivery` to guarantee idempotent message processing.
    - Deterministic UUID derivation (`toDeterministicUuid`) mapping external identifiers to PostgreSQL UUID keys.
    - Strict state machine DB check constraint: `status IN ('received', 'parsed', 'matched', 'needs_review', 'draft_created', 'answered', 'refused')`.
    - Automated PostgreSQL trigger `trg_approval_outbox` capturing all inserts/updates into `public.outbox`.
- **EWS Sync Watermarks in PostgreSQL:**
  - Migrated EWS/IMAP synchronization checkpoint tokens from uncommitted disk files (`sync_state.json`) to database-backed `public.sync_checkpoints`.
- **Outbox Worker & Dead-Letter Queue:**
  - Created standalone background worker `scripts/outbox-worker.ts`:
    - Exponential backoff with jitter (2s, 4s, 8s, 16s, 32s up to 300s cap).
    - Poison message quarantine: messages exceeding 5 retry attempts are moved to `public.dead_letter_queue` with error traces and payload snapshots.
    - Full disaster recovery replay capability via `--replay` flag.
  - Updated `scripts/approvals-watcher.ts` to persist directly to Supabase PostgreSQL and let the outbox pattern sync downstream.

### Added
- `docs/ADR-001.md`: Architectural Decision Record for authoritative PostgreSQL + derived Firestore outbox.
- `supabase/migrations/20261026000001_phase2_data_architecture.sql`: Migration creating `inpatient_approvals`, `outbox`, `dead_letter_queue`, and watermark checkpoints.
- `src/services/approvalPostgresService.ts`: PostgreSQL data access service for approvals, watermarks, and DLQ quarantine.
- `scripts/outbox-worker.ts`: Resilient outbox processor with exponential backoff and replay support.
- `scripts/test-data-architecture.ts`: Comprehensive test suite verifying deterministic UUIDs, backoff curves, watermarks, triggers, state machine constraints, and DLQ routing.

### Verified
- `npx tsx scripts/test-data-architecture.ts`: 100% tests passed (6/6 test suites).
- `npm run lint`: 0 TypeScript/ESLint errors.
- `npm run build`: Production build cleanly completed.

## [Unreleased] - Phase 1: Security & PHI Remediation (2026-10-25)

### Security & Compliance
- **PHI Purge & Git Tracking:**
  - Untracked `data/inpatient_approvals.json` and `data/sync_state.json` from Git index.
  - Added comprehensive ignore rules in `.gitignore` for raw emails, approval dumps, sync tokens, watcher logs, and PDF page crops.
  - Removed confidential contractor discount file `public/Consumables.xlsx` and sales officer mapping `public/Sales 2027.xlsx` from `public/` and `dist/`. Moved to private seeds.
- **API Protection:**
  - Hardened `/api/approvals` and `/api/contractors` with bearer token authentication (`isAuthorizedRequest`). Removed wildcard `Access-Control-Allow-Origin: *`.
  - Added authenticated header forwarding in `src/services/approvalsFirebaseService.ts` and `src/services/companyService.ts`.
- **Database & RLS Hardening:**
  - Added Supabase migration `20261026000000_phase1_security_and_rls.sql`:
    - Enforced Row-Level Security (RLS) on all tables.
    - Revoked broad public/staff `SELECT` on `public.raw_email_staging` to prevent PHI leaks.
    - Added append-only `public.audit_log` table with strict insert-only policy for staff.
    - Added `public.procedure_overrides` table for clinician and staff matching overrides.
  - Hardened `firestore.rules`:
    - Restricted `inpatient_approvals` to authenticated hospital staff (`@elitehospital.org` domain or admin).
    - Blocked anonymous/unauthenticated read/write to `companies_config` and `settings`.
- **AI De-identification Guardrail:**
  - Created `src/lib/deidentifier.ts` implementing `redactPhiFromText` and `assertZeroDemographics`.
  - Sanitized inputs to `analyzeThreadWithUnifiedAI` in `src/services/aiMatchService.ts`, stripping all patient names, MRNs, bed numbers, phone numbers, and physician names before transmitting prompts to Gemini.
  - Added zero-demographics assertion check before AI model invocations.
  - Replaced external AI call in `generateCmWhatsappWithAI` with safe local deterministic template formatting.
- **Environment & Secret Management:**
  - Standardized `.env.example` with documented keys for Gemini, Supabase (anon + service role), Firebase, EWS/IMAP, and internal service secret.
  - Untracked `firebase-applet-config.json` and converted `src/firebase.ts` to environment-driven initialization.

### Added
- `src/lib/deidentifier.ts`: Core PHI regex patterns, demographic masking, and security assertions.
- `scripts/test-deidentification.ts`: Unit test suite verifying demographic redaction and prompt guardrail interception.
- `api/_auth.ts`: Shared authentication check for serverless endpoints.
- `supabase/migrations/20261026000000_phase1_security_and_rls.sql`: RLS policies, audit log, and override tables.

### Verified
- `npm run lint` (`tsc --noEmit`): 0 errors.
- `npx tsx scripts/test-deidentification.ts`: 100% tests passed.
- `npm run build`: Production bundle built successfully with no exposed contractor assets.
