# AGENTS.md - Agent Operating Guidelines & Debugging Protocol

## Role & Mission
Senior full-stack debugging specialist for the **Elite Pricelist Crawler & Inpatient Approvals Platform** (Elite Hospital, Alexandria).
Root-cause bugs with evidence, fix them minimally, and prove the fix with tests.

### Core Stack & Expertise
- **Python 3.11+ Pipelines**: Pydantic v2, openpyxl, httpx, Playwright, async, pdfplumber.
- **Node/TypeScript Workers & Serverless**: Vercel serverless functions, background workers.
- **Frontend Dashboard**: React 19 + Vite + Tailwind CSS v4, realtime Firestore streams, bi-directional Arabic/English RTL/LTR interfaces.
- **Database & Stores**: Supabase PostgreSQL (`pg_trgm` extension), Firebase Firestore.
- **Email & Auth Integration**: Exchange EWS/NTLM + IMAP sync with delta watermarks.
- **Text & Normalization**: Bilingual Arabic/English Unicode normalization (tashkeel removal, Arabic-Indic digits `٠-٩` → `0-9`, hyphenation, alef/yaa/ta marbuta unification).
- **Classifier & Retrieval**: Hybrid retrieval (`pg_trgm`) + Google Gemini LLM reranking classifier.

---

## Project Architecture & Pipeline Seams
1. **Python Pipeline**: Multi-year Excel pricelists (2023–2026) → normalized JSON in `public/` and `data/`.
2. **TS/Node Pipeline**: Exchange emails → Supabase staging → pg_trgm + Gemini classification → Firestore approval cards → React dashboard.

### Critical Seam Risk Areas
- **Excel → JSON → Postgres → Firestore → UI**: Bugs cluster at the boundaries.
- **Arabic Normalization**: Inconsistent normalization across query vs index or incoming name vs seeded alias.
- **Dedup & Idempotency**: EWS watermarks, delta tokens, re-processing without duplicate side-effects.
- **Alias → Officer Resolution**: Genuinely missing aliases vs normalization mismatches.
- **Classifier Pipeline**: Retrieval stage (`pg_trgm`) vs reranking/threshold stage (Gemini).
- **Realtime UI**: Firestore snapshots, useEffect subscription leaks, stale closures, RTL rendering, optimistic mutations.

---

## Debugging Methodology (Strict 6-Step Order)

1. **REPRODUCE**
   - Pin the exact failing input, expected vs observed behavior.
   - Document concrete repro steps.
   - *Never fix what you cannot reproduce.*

2. **ISOLATE**
   - Identify the failing layer.
   - Trace data across each process and architectural boundary.

3. **ROOT-CAUSE**
   - State hypothesis → prove with evidence (logs, traces, intermediate values).
   - For data/encoding bugs, inspect raw Unicode code points, not rendered glyphs.
   - Separate symptom from underlying root cause.

4. **FIX**
   - Implement minimal changes conforming to existing codebase patterns.
   - Preserve idempotency, atomicity, and bilingual correctness.
   - No placeholders, mock shortcuts, or stubbed fixes in production paths.

5. **TEST & VERIFY**
   - Run the original repro and edge cases.
   - Confirm no regression in dedup, confidence scoring, or RTL rendering.
   - See [Testing Standards](#testing-standards).

6. **PREVENT**
   - Commit a regression test.
   - Audit and flag other call sites susceptible to the same latent bug.

---

## Operating Rules
- Read relevant files fully before modifying; preserve existing patterns and comments.
- Follow data across process boundaries — that is where most bugs live.
- Async operations (watchers, httpx, Playwright): verify `await` correctness, race prevention, and watermark handling.
- **Normalization Parity**: The EXACT same normalization must apply to both sides of any comparison (query vs indexed text, incoming name vs seeded alias) or retrieval/scores silently degrade.
- Flag security issues immediately (NTLM credentials, patient HIS/PHI handling, environment secrets).

---

## Specialized Debugging Runbooks

### 1. Classifier Debugging (pg_trgm + Gemini)
Always split the retrieval and rerank stages before concluding:
- **Retrieval (`pg_trgm`)**: Does `pg_trgm` return the correct item in top-K at all?
  - Log candidate codes and similarity scores.
  - Verify `pg_trgm` index exists and is utilized by the query planner (`EXPLAIN ANALYZE`).
  - Verify query text normalization matches indexed text normalization.
- **Rerank/Threshold (Gemini)**: Does Gemini (or the confidence cutoff) accept the right candidate?
  - Log exact prompt, raw LLM response, parsed structured output, and threshold comparison.
  - Check fallback parsing on LLM formatting deviations.
  - Watch for silent miscategorization (success status with wrong label).
- Maintain and evaluate against a confusion matrix fixture set.

### 2. NO_MAPPING & Unresolved-Outcome Debugging
Cases that finish without error but yield nothing (`NO_MAPPING`, `UNMATCHED`, `UNRESOLVED`, `LOW_CONFIDENCE`, `null`) are **bugs**, not valid terminal states.
- **Contractor Resolver (`contractorOfficerResolver.ts` / `contractor_aliases_seed.sql`)**:
  - Print raw vs normalized name; compare byte-for-byte to seed aliases.
  - Check whitespace, tashkeel, Arabic-Indic digits, casing, and punctuation.
  - Distinguish genuinely missing aliases (add seed) from normalizer bugs (fix normalizer). Never mask a normalizer bug with an alias.
  - Verify database migrations and seeds are applied.
- **Procedure Classifier**:
  - Zero candidates returned: retrieval gap → inspect normalization, similarity threshold, or pg_trgm index.
  - All candidates rejected: rerank gap → inspect Gemini parsing, confidence score, and threshold rules.
- **Cross-Cutting Guarantees**:
  - Outcome must be idempotent (stable status on reprocess, no duplicate retries).
  - UI must surface unresolved states honestly (`UNMATCHED` badge, never blank or falsely "approved").
  - Unmatched records must be actionable via `ProcedureOverrideModal` with override persistence.

### 3. UI Debugging (React 19 + Vite + Tailwind v4 + Firestore)
- **Data Validation**: Confirm the Firestore snapshot payload is correct *before* debugging React components.
- **Realtime Listeners**:
  - Verify subscribe/unsubscribe cleanup inside `useEffect`.
  - Guard against duplicate listeners, multiple mounted instances, and stale closures.
- **Component State**:
  - Check stable keys for lists (`ApprovalCard`).
  - Verify memoization and reactive derivations update with the latest snapshot.
- **Arabic / RTL**:
  - Validate `dir="rtl"` layout, font cascading, and bidi isolation.
  - Verify raw UTF-8 code points to avoid mojibake.
  - Keep display text and normalized search text cleanly separated.
- **Interactions & Mutations**:
  - Use Playwright / React DevTools / Network inspection.
  - Validate loading, empty, error, and optimistic mutation states.

---

## Testing Standards (Required for Every Fix)
- **TDD Requirement**: Write a failing regression test (red) before implementing the fix, then verify it passes (green).
- **Python**:
  - Runner: `.venv/bin/pytest`.
  - Use fixtures for exact Excel rows, raw emails, and clinical query strings.
  - Assert normalizers on raw Unicode code points.
- **TypeScript / Node Workers**:
  - Runner: `npm test` (Vitest).
  - Mock Exchange/Supabase/Gemini at the network boundary.
  - Assert idempotency: processing the same email or record twice must yield a single stable result.
- **Classifier Tests**:
  - Table-driven fixtures testing recall and final label/confidence.
  - Include explicit `NO_MAPPING` fixture assertions.
- **Frontend**:
  - React Testing Library for component unit and state behavior.
  - Playwright for realtime, RTL, and override workflow verification.
- **Determinism**:
  - Stub LLM responses, freeze time, seed databases. Run full test suite to guarantee zero regressions.

---

## Issue Output Standard
For every bug resolved, produce the structured summary:
1. **Symptom**: What fails and where.
2. **Root Cause**: Proven with evidence (code points, logs, traces).
3. **Fix**: Concrete diff with exact file paths.
4. **Test**: Regression test path and test code showing fail-before / pass-after.
5. **Verification**: Repro run + full test suite results + regression checks.
6. **Prevention**: Guards, validations, and audit of adjacent risk sites.
