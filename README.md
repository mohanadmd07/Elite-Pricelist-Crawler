# 🏥 Elite Pricelist Crawler & Data Pipeline

A production-grade, resilient crawler and ingestion pipeline for Egyptian healthcare medical pricelists, insurance approvals, and procedure catalogs.

---

## ⚡ Architectural Highlights

- **Modular Separation of Concerns:** Decoupled into `models` (Pydantic v2 schemas), `normalizers` (multilingual Arabic/English NLP), `evasion` (anti-bot fingerprinting), `extractors` (dynamic web and multi-sheet workbooks), and `pipelines` (deduplication and atomic exports).
- **Advanced Multilingual Normalization:**
  - Persian/Urdu character mapping (`ی` $\to$ `ي`, `ک` $\to$ `ك`, `ھ` $\to$ `ه`).
  - Eastern Arabic-Indic digits conversion (`٠-٩` $\to$ `0-9`).
  - Strips tatweel (`ـ`), diacritics/tashkeel, and non-breaking spaces.
  - Automatic column swap detection (Arabic names accidentally in English columns).
  - Outsource / Send-out test detection (`*` or `**` flags).
  - PDF/OCR hyphenation reconstruction (`un- der` $\to$ `under`).
- **Web Crawler Engine:**
  - Asynchronous HTTP/2 fetching via `httpx` with randomized humanized jitter.
  - Modern Client-Hints and browser TLS header spoofing to bypass WAFs.
  - Headless browser fallback via Playwright for JavaScript SPAs.
  - Full exponential backoff retry decorator with randomized jitter for handling HTTP 429 and transient 5xx errors.
- **Atomic Serialization:** Exports directly to application frontend targets (`public/{year}_cash.json`) using atomic temporary files, preventing partial writes during system interruptions.

---

## 📦 Directory Structure

```
Elite-Pricelist-Crawler/
├── crawler/
│   ├── config.py                 # Pydantic Settings, environment variables, timeouts, proxy specs
│   ├── models.py                 # Pydantic v2 schemas: ProcedureItem, CrawlRequest, BatchSummary
│   ├── normalizers.py            # Multilingual Arabic/English NLP, digit conversion, price cleaner
│   ├── evasion/
│   │   ├── anti_bot.py           # User-Agent rotation, TLS header spoofing, randomized jitter
│   │   └── proxy_manager.py      # Proxy rotation with health monitoring
│   ├── extractors/
│   │   ├── base.py               # Abstract Base Extractor interface
│   │   ├── web_spider.py         # Async httpx + Playwright browser crawler for SPAs/portals
│   │   └── excel_extractor.py    # Production-grade openpyxl workbook parser
│   ├── pipelines/
│   │   ├── deduplication.py      # Cross-year and intra-sheet deduplication & validation
│   │   └── exporters.py          # Multi-target exporter (atomic JSON, Excel, Firestore)
│   └── utils/
│       ├── logger.py             # Structured colorized logging
│       └── retry.py              # Exponential backoff decorator with jitter
├── main.py                       # Unified CLI with robust flags
├── requirements.txt              # Standardized modern dependencies
└── README.md                     # Comprehensive operational guide
```

---

## 🚀 Quickstart & Setup

### 1. Initialize Virtual Environment
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

*(Optional: Install browser binaries for dynamic JS crawling)*
```bash
playwright install chromium
```

---

## 💻 CLI Commands

### 1. Extract Local Excel Workbooks (All Years)
Extracts and validates procedures across 2023, 2024, 2025, and 2026 workbooks, prunes duplicates, and exports to `public/*_cash.json`:
```bash
python3 main.py extract-excel --year all
```

### 2. Extract a Specific Year (e.g. 2026)
```bash
python3 main.py extract-excel --year 2026
```

### 3. Dry-Run Extraction (Auditing without file modification)
```bash
python3 main.py extract-excel --dry-run
```

### 4. Crawl an External Medical Portal or Online Pricelist
```bash
# Static or Server-Rendered HTML
python3 main.py crawl-url https://example.com/medical-rates -o data/crawled_rates.json

# Dynamic React / Angular Single-Page Application (SPA)
python3 main.py crawl-url https://example.com/spa-portal --use-browser -o data/spa_rates.json
```

---

## 🛡️ Anti-Scraping Evasion Features

1. **User-Agent Pool:** Rotates between Chrome (macOS/Win), Safari, and Firefox.
2. **Client-Hints Emulation:** Automatically provisions modern `sec-ch-ua`, `sec-ch-ua-mobile`, and `sec-ch-ua-platform` headers matching the selected User-Agent.
3. **Randomized Delay (Jitter):** Simulates human interaction pacing between configurable minimum and maximum intervals (`DOWNLOAD_DELAY_MIN` and `DOWNLOAD_DELAY_MAX`).
4. **Proxy Rotation:** Automatically cycles requests through `settings.PROXIES` with failure counters.
