# Elite Pricelist Crawler & Approvals Platform - Operations Runbook

## 1. System Topology & Architecture Overview

The Elite Pricelist Crawler and Inpatient Approvals platform operates as a hybrid healthcare intelligence system:

```mermaid
flowchart TD
    EWS["Hospital Exchange Server (wmail.elitehospital.org)"] -->|TLS / NTLM| CloudWorker["Cloud Mail Ingestion Worker (Docker / Vercel Cron)"]
    CloudWorker -->|De-identified & Sanitized| Postgres["Supabase PostgreSQL (Authoritative Source of Truth)"]
    Postgres -->|Transactional Outbox Trigger| Outbox["public.outbox"]
    Outbox -->|Outbox Worker (scripts/outbox-worker.ts)| Firestore["Cloud Firestore (Derived Read Model)"]
    Outbox -. Poison Message .-> DLQ["public.dead_letter_queue"]
    
    ExcelFiles["Excel Workbooks (2023-2026)"] --> Rebuild["Pricelist Rebuild Pipeline (main.py)"]
    PDFFiles["PDF Catalogs (2023-2025)"] --> LayeredPDF["Layered PDF Extractor (L1-L4)"]
    LayeredPDF --> Reconcile["Reconciliation & Validation"]
    Rebuild --> Reconcile
    Reconcile --> PublicJSON["public/*_cash.json (Byte-Identical Export)"]
    PublicJSON --> Frontend["React 19 + Vite Frontend (IndexedDB + Web Worker)"]
    Firestore -. Realtime Updates .-> Frontend
```

---

## 2. Ingestion Operations & Mail Transport

### Automated Schedulers
- **Vercel Cron:** Configured in `vercel.json` to trigger `/api/approvals/sync` every 20 minutes (`*/20 * * * *`).
- **Managed Container:** `src/mail/worker.ts` packaged via `Dockerfile` with embedded HTTP health checks on port 8080.

### Manual Ingestion Sync
To trigger an immediate one-off ingestion pass:
```bash
node --env-file=.env.local node_modules/.bin/tsx scripts/sync-now.ts
```

### Historical Backfill Operation
To re-ingest and re-parse approvals across a specific historical date range without creating duplicate records:
```bash
node --env-file=.env.local node_modules/.bin/tsx scripts/backfill-approvals.ts --since 2026-01-01 --until 2026-10-25
```
*Note:* The unique constraint `idx_approvals_unique_delivery` guarantees idempotency. Re-running on existing message IDs updates existing records in-place without duplicating rows.

### Cursor & Watermark Reset
Ingestion cursors are stored in `public.sync_checkpoints`. To reset a folder cursor:
```sql
UPDATE public.sync_checkpoints
SET sync_state_token = NULL, last_synced_at = '1970-01-01 00:00:00+00'
WHERE folder_name = 'InApprovals';
```

---

## 3. Transactional Outbox & Dead-Letter Queue (DLQ)

### Outbox Drain
To process pending outbox events from Postgres to Firestore:
```bash
# Continuous daemon
node --env-file=.env.local node_modules/.bin/tsx scripts/outbox-worker.ts

# One-shot batch drain
node --env-file=.env.local node_modules/.bin/tsx scripts/outbox-worker.ts --once
```

### Poison Message Inspection & Replay
When a message fails 5 consecutive delivery attempts with exponential backoff, it is quarantined in `public.dead_letter_queue`.

1. **Inspect quarantined messages:**
   ```sql
   SELECT id, queue_name, error_message, retry_count, quarantined_at
   FROM public.dead_letter_queue
   ORDER BY quarantined_at DESC;
   ```
2. **Replay quarantined messages:**
   ```bash
   node --env-file=.env.local node_modules/.bin/tsx scripts/outbox-worker.ts --replay
   ```

---

## 4. Pricelist Pipeline (Excel + PDF Rebuild)

### 1. Catalog Source Inventory
Scan all workbook and PDF assets:
```bash
./.venv/bin/python main.py inventory
```

### 2. Full Rebuild
Re-extract, reconcile, validate, and emit byte-identical JSON catalogs:
```bash
# All years (2023-2026)
./.venv/bin/python main.py rebuild --years all --sources excel,pdf

# Single year incremental
./.venv/bin/python main.py rebuild --years 2026 --sources excel --only-changed
```

### 3. Review Queue Loop
To review low-confidence extractions or price discrepancy candidates:
```bash
./.venv/bin/python main.py review --year 2024
```
Decisions (`accept`, `edit`, `reject`) are saved to `data/pdf_corrections.json` and automatically applied on the next rebuild.

### 4. Differential Reports
Year-over-year pricing trend reports and discrepancy comparisons are automatically generated in `reports/`:
- `reports/pdf_vs_excel_<year>.csv`: Row-by-row alignment between PDF and Excel.
- `reports/yoy_diff_<year>.md`: Price shift analysis, average inflation %, added and retired procedures.

---

## 5. Health Monitoring & Observability

Run the health check suite:
```bash
node --env-file=.env.local node_modules/.bin/tsx scripts/monitor-health.ts
```

Thresholds monitored:
- **Postgres Latency:** Alert if connection fails.
- **Heartbeat Age:** Alert if mail watermark is $> 30$ minutes old.
- **Dead-Letter Spikes:** Alert if `public.dead_letter_queue` count $> 0$.
- **Outbox Processing Lag:** Alert if pending events $> 25$ or oldest $> 15$ minutes old.

---

## 6. PHI Safeguards & Audit Compliance

1. **Zero Demographics Rule:**
   - Raw patient full names, national IDs, and phone numbers are never transmitted to LLM endpoints.
   - Run verification test:
     ```bash
     npm test tests/deidentifier.test.ts
     ```
2. **Automated PHI Retention Purge:**
   - Raw email bodies are nullified after 30 days while preserving anonymized clinical and financial metrics:
     ```sql
     SELECT public.purge_expired_raw_emails(30);
     ```
3. **Audit Log:**
   - All manual price overrides and clinical code selections are immutably logged to `public.audit_log`:
     ```sql
     SELECT * FROM public.audit_log ORDER BY created_at DESC LIMIT 20;
     ```
