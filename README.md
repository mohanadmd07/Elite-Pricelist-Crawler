# 🏥 Elite Pricelist Crawler & Inpatient Approvals Platform

A production-grade, enterprise healthcare platform combining an intelligent multi-tier medical pricelist extraction pipeline (Excel + PDF with BiDi Arabic restoration), cloud-native email ingestion for inpatient insurance approvals, hybrid clinical semantic search (PostgreSQL GIN trigrams + Gemini JSON Schema-constrained matching), and an offline-first React 19 web application.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph DataIngestion ["1. Cloud Mail & Catalog Ingestion"]
        EWS["Hospital EWS / TLS<br/>(wmail.elitehospital.org)"] -->|Poll every 20m / Vercel Cron| SyncEngine["Sync Engine<br/>(src/mail/syncEngine.ts)"]
        Excel["Pricelist Workbooks<br/>(.xlsx 2023-2026)"] --> Crawler["Python Pipeline<br/>(L1-L4 Extractors)"]
        PDF["Scanned & Digital PDFs"] --> Crawler
        Crawler -->|Deterministic Export| CashCatalog["public/*_cash.json<br/>(Additive Schemas)"]
    end

    subgraph Storage ["2. Source of Truth (Supabase Postgres)"]
        SyncEngine -->|Deduplicated Insert| InpatientTable["public.inpatient_approvals<br/>(State Machine + RLS)"]
        SyncEngine -->|Persist Checkpoints| Checkpoints["public.sync_checkpoints"]
        InpatientTable -->|Postgres Trigger| Outbox["public.outbox"]
        AuditLog["public.audit_log<br/>(Append-Only)"]
        Overrides["public.procedure_overrides<br/>(Clinician Overrides)"]
        MatchCache["public.semantic_match_cache<br/>(SHA-256 Hashes)"]
    end

    subgraph SyncWorker ["3. Eventual Consistency Worker"]
        Outbox -->|Poll & Exponential Backoff| OutboxWorker["Outbox Worker<br/>(scripts/outbox-worker.ts)"]
        OutboxWorker -->|Replicate Read Model| Firestore["Cloud Firestore<br/>(Domain-Restricted Rules)"]
        OutboxWorker -->|Failures (>5 retries)| DLQ["public.dead_letter_queue"]
    end

    subgraph SearchMatching ["4. Hybrid Clinical Matching Engine"]
        ClinicianQuery["Clinical Procedure Query"] --> OverrideCheck{"Manual Override<br/>Exists?"}
        OverrideCheck -->|Yes| DirectMatch["Instant Priority Return"]
        OverrideCheck -->|No| TrigramSearch["PostgreSQL GIN Trigram<br/>(search_procedures RPC)"]
        TrigramSearch -->|Confidence < 0.85| GeminiAI["Gemini 2.5 Flash<br/>(De-identified + JSON Schema)"]
        GeminiAI -->|Strict Bounds Check| MatchResult["Matched Catalog SKU"]
    end

    subgraph FrontendApp ["5. Client Application (React 19 + Vite)"]
        CashCatalog --> IndexedDB["IndexedDB Cache<br/>(src/lib/catalogCache.ts)"]
        IndexedDB --> SearchWorker["Web Worker<br/>(Off-Thread Fuzzy Search)"]
        SearchWorker --> UI["Modern Dashboard UI<br/>(Confidence Chips + RTL auto)"]
        Firestore -->|Real-Time Snapshot| UI
    end
```

---

## ⚡ Key Highlights & Capabilities

### 1. Security & PHI Protection
- **Zero-Demographics AI Guardrail (`src/lib/deidentifier.ts`):** Automatically scrubs Egyptian full names, medical record numbers (MRNs), hospital bed numbers, national IDs, and physician identities before queries reach external AI models.
- **Row-Level Security (RLS):** Enabled across all Supabase PostgreSQL tables with strict isolation between the service role (worker) and authenticated staff users.
- **Domain-Restricted Firestore (`firestore.rules`):** Reads and writes restricted to authenticated `@elitehospital.org` staff accounts.
- **Sanitized Public Assets:** Confidential contractor discounts (`Consumables.xlsx`, `Sales 2027.xlsx`) have been completely purged from public web bundles.

### 2. Multi-Tier Layered Pricelist Crawler (Excel + PDF)
- **L1 (Word Coordinates):** Dynamic per-page column boundary detection using bounding boxes, preventing multi-line name merges across price boundaries.
- **L2 (Table Line Vectors):** Grid-based cross-checks via `pdfplumber` to verify row counts and boost confidence scores ($\ge 0.95$).
- **L3 (300 DPI OCR):** Scanned page extraction via PyMuPDF rendering with Tesseract/PaddleOCR confidence tracking.
- **L4 (Vision Fallback):** Targeted Gemini 2.5 Flash Vision for complex CID font corruption, cached by page image SHA-256 hash in `data/gemini_page_cache.json`.
- **Arabic BiDi & Unicode Normalization:** Detects and reverses visual-order LTR glyph streams back to logical RTL order (`reverse_visual_bidi`), collapses presentation forms (NFKC), and strips diacritics with 1:1 parity between Python (`crawler/normalizers.py`) and TypeScript (`src/lib/arabic-normalizer.ts`).
- **Reconciliation & Review Queue:** Aligns Excel and PDF extractions, routes conflicting rows to human review (`data/review_queue_<year>.json`), and records review decisions in `data/pdf_corrections.json`.

### 3. Cloud Mail Ingestion (EWS over Public TLS)
- **Zero On-Premises Footprint:** Connects directly from managed cloud workers to `https://wmail.elitehospital.org/EWS/Exchange.asmx` over public TLS on port 443.
- **Dual Execution Models:**
  - **Serverless Vercel Cron:** Triggers every 20 minutes (`*/20 * * * *`) via `/api/approvals/sync` with `CRON_SECRET` authentication.
  - **Docker Container Worker:** Long-lived polling worker with health check server on port 8080 (`Dockerfile` and `docker-compose.yml`).
- **Transactional Outbox Pattern (ADR-001):** PostgreSQL acts as the single source of truth; updates replicate asynchronously to Cloud Firestore for low-latency web client subscriptions.

### 4. Hybrid Clinical Matching Engine (ADR-002)
- **Bilingual GIN Trigram Search:** Normalized database columns (`name_arabic_normalized`, `name_english_normalized`) with GIN indexes executing sub-15ms fuzzy queries.
- **JSON Schema-Constrained Gemini AI:** Enforces strict structured responses (`candidate_id`, `confidence`, `reason`) and validates candidates against the candidate set to prevent hallucinations.
- **Confidence Tiers:** Visual UI indicator chips for Auto-Accept ($\ge 0.85$), Needs Review ($0.50 - 0.84$), and Rejected ($< 0.50$).
- **Manual Overrides:** Clinicians can override matches directly from the UI, persisting to `public.procedure_overrides` and generating priority aliases.

### 5. High-Performance Frontend (React 19 + Vite)
- **IndexedDB Catalog Caching (`src/lib/catalogCache.ts`):** Large yearly pricelists are cached in the browser's IndexedDB, enabling instant app startup and offline functionality.
- **Dedicated Web Worker Search (`src/workers/search.worker.ts`):** Offloads computationally heavy fuzzy text scoring and trigram matching from the main UI thread.
- **RTL & Bidi Polish:** Dynamic text direction handling (`dir="auto"`) across all medical descriptions, WhatsApp message generation templates, and search results.

---

## 📦 Directory Structure

```
Elite-Pricelist-Crawler/
├── api/                           # Serverless endpoints (Vercel)
│   ├── approvals/sync.ts          # Cron-triggered EWS sync endpoint
│   ├── approvals.ts               # Authenticated approvals retrieval
│   └── contractors.ts             # Authenticated contractor endpoints
├── crawler/                       # Python medical catalog pipeline
│   ├── extractors/
│   │   ├── pdf_extractor.py       # Multi-tier L1-L4 PDF parser
│   │   ├── excel_extractor.py     # Multi-sheet openpyxl parser
│   │   └── web_spider.py          # Playwright & httpx web crawler
│   ├── pipelines/
│   │   ├── source_inventory.py    # Source file hashing and inventory
│   │   ├── reconcile.py           # Cross-source reconciliation (Excel vs PDF)
│   │   ├── corrections.py         # Human review decision persistence
│   │   ├── validation.py          # Pydantic schema validation & YoY anomaly detection
│   │   └── yoy_diff.py            # Year-over-year pricing inflation reports
│   └── normalizers.py             # Multilingual Arabic/English NLP & BiDi reversal
├── docs/                          # Architecture & Operational Documentation
│   ├── ADR-001.md                 # Supabase as Source of Truth & Outbox Pattern
│   ├── ADR-002-hybrid-retrieval.md# Hybrid Trigram + LLM Matching Engine
│   └── RUNBOOK.md                 # Production troubleshooting & operations runbook
├── scripts/                       # Operational & Maintenance CLI Tools
│   ├── outbox-worker.ts           # Postgres-to-Firestore synchronization worker
│   ├── sync-now.ts                # Manual EWS approval sync trigger
│   ├── backfill-approvals.ts      # Historical approval backfill CLI
│   ├── eval-matching.ts           # Golden Precision@1/Precision@3 evaluation script
│   └── monitor-health.ts          # Platform health check and lag monitor
├── src/                           # React 19 Frontend & Client Services
│   ├── components/                # React UI components (ProcedureCard, Overrides, etc.)
│   ├── lib/                       # Utilities (catalogCache, logger, deidentifier, normalizer)
│   ├── mail/                      # Mail ingestion engine, EWS adapters, and parser
│   ├── services/                  # Business services (approvals, semantic matching, alerts)
│   └── workers/                   # Web Workers (search.worker.ts)
├── supabase/migrations/           # Versioned, reversible PostgreSQL migrations
├── tests/                         # Test suites (Vitest for TS/React, Pytest for Python)
├── Dockerfile                     # Production container for cloud mail worker
├── docker-compose.yml             # Local staging composition
├── main.py                        # Unified Python CLI entry point
└── package.json                   # Node.js dependencies and scripts
```

---

## 🚀 Quickstart & Setup

### 1. Prerequisites
- **Node.js:** v20.x or higher (v26 tested)
- **Python:** v3.12 or higher (v3.13 tested)
- **Docker & Docker Compose** (Optional, for containerized worker)

### 2. Environment Configuration
Copy `.env.example` to `.env.local` and provide the required credentials:
```bash
cp .env.example .env.local
```

Key variables:
```ini
# Supabase PostgreSQL
SUPABASE_URL="https://omnjiudiaajzxnvgraum.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="ey..."
DATABASE_URL="postgresql://postgres:[PASSWORD]@db.omnjiudiaajzxnvgraum.supabase.co:5432/postgres"

# Hospital Mail (EWS)
EWS_ENDPOINT="https://wmail.elitehospital.org/EWS/Exchange.asmx"
EWS_USERNAME="inpatient.approvals"
EWS_PASSWORD="[PASSWORD]"
EWS_DOMAIN="ELITEHOSPITAL"

# Google Gemini AI
GEMINI_API_KEY="AIza..."

# Internal Security
CRON_SECRET="your-secure-cron-secret"
SERVICE_ROLE_SECRET="your-internal-service-secret"
```

### 3. Install Dependencies
```bash
# Node.js dependencies
npm install

# Python virtual environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

---

## 💻 Operational CLI Commands

### 🐍 Python Pricelist Pipeline

#### 1. Scan and Inventory Source Files
Scans all Excel workbooks and PDF catalogs, calculating SHA-256 fingerprints, page counts, and text-layer status:
```bash
python main.py inventory
```

#### 2. Rebuild All Catalog Years (2023–2026)
Executes extraction, reconciliation, validation, and atomic export to `public/*_cash.json`:
```bash
python main.py rebuild --years 2023,2024,2025,2026 --sources excel,pdf
```

*Options:*
- `--only-changed`: Process only files whose SHA-256 checksum has changed.
- `--dry-run`: Validate without writing files to disk.
- `--max-pdf-pages <N>`: Limit PDF processing for fast testing.

#### 3. Interactive Review Queue
Review flagged discrepancies, unverified prices, or low-confidence PDF extractions:
```bash
python main.py review --year 2026
```

---

### ⚡ TypeScript & Cloud Services CLI

#### 1. Start Outbox Sync Worker (Postgres $\to$ Firestore)
```bash
npm run outbox:worker
```
*To replay all historical approvals into Firestore:*
```bash
npx tsx scripts/outbox-worker.ts --replay
```

#### 2. Trigger On-Demand EWS Mail Ingestion
```bash
npm run mail:sync
```

#### 3. Backfill Approvals for a Specific Date Range
```bash
npx tsx scripts/backfill-approvals.ts --days 30
```

#### 4. Run Golden Matching Evaluation (CI Quality Gate)
Computes Precision@1 and Precision@3 against clinical benchmarks and historical overrides:
```bash
npm run eval:matching
```

#### 5. Check System Health & Lag
Inspects database latency, outbox processing lag, watermark staleness, and DLQ entries:
```bash
npm run health:check
```

---

## 🧪 Testing & Verification

Run the comprehensive test suites across both TypeScript and Python:

```bash
# Run Vitest test suite (15 tests: de-identification, normalizer, pricing, WhatsApp)
npm test

# Run Pytest suite (10 tests: L1-L4 extractors, bidi repair, validation gates)
./.venv/bin/pytest -v

# Run TypeScript typecheck
npm run lint

# Build production bundle
npm run build
```

---

## 🛡️ Security & PHI Governance Rules

1. **Strictly Cash Catalog:** `public/*_cash.json` contains solely retail cash rates and procedure metadata. Contractor rates and corporate discounts are strictly forbidden from public assets.
2. **De-identification Mandatory:** All external LLM requests must be routed through `src/lib/deidentifier.ts`. Prompt inputs containing raw patient identifiers will throw an assertion error and be blocked.
3. **Audit Log Append-Only:** Manual overrides and pricing edits record immutable entries in `public.audit_log` with operator identity and timestamp.
4. **Automated Log Scrubbing:** `src/lib/logger.ts` and `crawler/utils/logger.py` automatically redact Egyptian names, MRNs, bed numbers, and phone numbers before emitting log strings.

---

## 📄 License & Maintainer
Maintained by the Elite Hospital Engineering Team. Proprietary and confidential. Unauthorized copying or redistribution is strictly prohibited.
