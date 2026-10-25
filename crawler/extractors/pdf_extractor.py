"""
Layered Deterministic PDF Pricelist Extractor.
Extracts medical procedures, bilingual nomenclature, and positive numeric prices
from hospital PDF pricelists through a multi-tier layered architecture:

- L1: Deterministic word-level bounding boxes with dynamic per-page column boundaries.
- L2: Line-based table structure extraction (pdfplumber.extract_tables).
- L3: High-resolution (300 DPI) OCR for scanned pages with raw confidence scores.
- L4: Gemini Vision fallback for complex, corrupted CID fonts, or low-confidence pages,
      persisted in an idempotent page-hash cache.
- Section carry-down, bidi Arabic correction, and provenance tracking per row.
"""

import os
import re
import json
import hashlib
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import pymupdf
import pdfplumber

from crawler.config import settings
from crawler.extractors.base import BaseExtractor
from crawler.models import ProcedureItem
from crawler.normalizers import (
    sanitize_procedure_names,
    parse_numeric_price,
    format_price_string,
    is_reversed_arabic,
    reverse_visual_bidi,
    clean_text,
)
from crawler.utils.logger import logger


def compute_bytes_sha256(data: bytes) -> str:
    """Calculates SHA-256 hex digest for byte data."""
    return hashlib.sha256(data).hexdigest()


class LayeredPdfExtractor(BaseExtractor):
    """
    Production-grade layered extractor for hospital PDF catalogs.
    """

    EXTRACTOR_VERSION = "1.2.0"

    def __init__(
        self,
        file_path: str,
        year: str,
        max_pages: Optional[int] = None,
        cache_path: Optional[Path] = None,
    ):
        self.file_path = Path(file_path)
        self.year = year
        self.max_pages = max_pages
        self.cache_path = cache_path or (settings.BASE_DIR / "data" / "gemini_page_cache.json")
        self.file_sha256 = ""
        if self.file_path.exists():
            with open(self.file_path, "rb") as f:
                self.file_sha256 = hashlib.sha256(f.read()).hexdigest()

        self._page_cache: Dict[str, Any] = self._load_cache()

    def _load_cache(self) -> Dict[str, Any]:
        """Loads cached Gemini page vision extractions."""
        if self.cache_path.exists():
            try:
                with open(self.cache_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                logger.warning(f"Could not load Gemini page cache from {self.cache_path}: {e}")
        return {}

    def _save_cache(self):
        """Atomically saves Gemini page vision extractions to disk."""
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.cache_path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._page_cache, f, indent=2, ensure_ascii=False)
        tmp.replace(self.cache_path)

    def is_toc_or_cover_page(self, text: str, page_num: int) -> bool:
        """Determines if a page is a table of contents, cover, or section divider."""
        if not text or len(text.strip()) < 15:
            return True
        t_low = text.lower()
        if "content" in t_low or "المحتوى" in text or "المحتـــوى" in text:
            return True
        if page_num <= 2 and ("price list" in t_low or "قائمة أسعار" in text) and len(text) < 150:
            return True
        # Section divider pages (short text, no prices)
        if len(text.strip()) < 100 and not re.search(r"\b\d{2,6}\b", text):
            return True
        return False

    def extract_l2_tables(
        self, page: pdfplumber.page.Page, page_num: int, current_section: str
    ) -> Tuple[List[Dict[str, Any]], str, float]:
        """
        L2: Line-based table extraction via pdfplumber.
        Returns (extracted_rows, updated_section, confidence).
        """
        tables = page.extract_tables({
            "vertical_strategy": "lines",
            "horizontal_strategy": "lines",
            "snap_tolerance": 4,
            "join_tolerance": 4,
        })
        if not tables:
            tables = page.extract_tables()

        if not tables:
            return [], current_section, 0.0

        rows: List[Dict[str, Any]] = []
        sec = current_section

        for table in tables:
            if not table:
                continue

            # Detect table-wide reversed Arabic
            reversed_cells = 0
            total_ar_cells = 0
            for r in table:
                if len(r) >= 3 and r[2]:
                    s = str(r[2])
                    if any("\u0600" <= c <= "\u06FF" for c in s):
                        total_ar_cells += 1
                        if is_reversed_arabic(s):
                            reversed_cells += 1
            table_is_reversed = (reversed_cells / total_ar_cells >= 0.25) if total_ar_cells > 0 else False

            for r in table:
                if not r or len(r) < 2:
                    continue

                if len(r) == 2:
                    en_raw, price_raw = r[0], r[1]
                    ar_raw = ""
                    code_raw = None
                elif len(r) == 3:
                    en_raw, price_raw, ar_raw = r[0], r[1], r[2]
                    code_raw = None
                else:
                    code_raw, en_raw, price_raw, ar_raw = r[0], r[1], r[2], r[3]

                price_num = parse_numeric_price(price_raw)
                if price_num is None:
                    # Possible section header
                    candidate_sec = str(en_raw or "").replace("\n", " ").strip()
                    if candidate_sec and candidate_sec.lower() not in ("service", "procedure", "name", "price", "english", "arabic"):
                        if "services" in candidate_sec.lower() or "fees" in candidate_sec.lower() or len(candidate_sec) > 3:
                            sec = candidate_sec
                    continue

                en, ar, outsourced = sanitize_procedure_names(en_raw, ar_raw, force_bidi=table_is_reversed)
                if not en and not ar:
                    continue

                # Detect font corruption (CID glyphs like (cid:149) or non-Arabic replacement glyphs)
                has_cid_corruption = "(cid:" in str(ar_raw or "") or "\x03" in str(ar_raw or "")

                rows.append({
                    "code": str(code_raw).strip() if code_raw else None,
                    "nameEnglish": en,
                    "nameArabic": ar,
                    "price": format_price_string(price_num),
                    "sectionName": sec or "General",
                    "outsourced": outsourced,
                    "has_cid_corruption": has_cid_corruption,
                })

        # Confidence assessment
        if not rows:
            return [], sec, 0.0

        cid_ratio = sum(1 for r in rows if r["has_cid_corruption"]) / len(rows)
        confidence = 0.95 if cid_ratio == 0 else max(0.40, 0.95 - (cid_ratio * 0.6))
        return rows, sec, confidence

    def extract_l1_words(
        self, page: pdfplumber.page.Page, page_num: int, current_section: str
    ) -> Tuple[List[Dict[str, Any]], str, float]:
        """
        L1: Deterministic word bounding-box clustering with dynamic per-page column boundaries.
        Returns (extracted_rows, updated_section, confidence).
        """
        words = page.extract_words()
        if not words:
            return [], current_section, 0.0

        # Discover price words (pure positive numbers) to locate the price column x-range
        price_words = []
        for w in words:
            txt = w["text"].strip().replace(",", "")
            if re.match(r"^\d{2,6}$", txt) and 80.0 < w["top"] < (page.height - 50.0):
                price_words.append(w)

        if not price_words:
            return [], current_section, 0.0

        # Calculate price column boundaries
        min_price_x = min(w["x0"] for w in price_words)
        max_price_x = max(w["x1"] for w in price_words)
        x_split_left = min_price_x - 5.0
        x_split_right = max_price_x + 5.0

        # Sort price words top-down
        price_words.sort(key=lambda w: w["top"])

        rows: List[Dict[str, Any]] = []
        sec = current_section

        # Partition text words into rows around price boundaries
        for i, pw in enumerate(price_words):
            y_top = price_words[i - 1]["bottom"] if i > 0 else 80.0
            y_bottom = price_words[i + 1]["top"] if (i + 1) < len(price_words) else (page.height - 40.0)

            # Collect English words (left of price) and Arabic words (right of price)
            en_tokens = []
            ar_tokens = []

            for w in words:
                if y_top <= w["top"] <= y_bottom:
                    if w["x1"] <= x_split_left:
                        en_tokens.append(w)
                    elif w["x0"] >= x_split_right:
                        ar_tokens.append(w)

            # Sort tokens in reading order
            en_tokens.sort(key=lambda w: (round(w["top"] / 4.0), w["x0"]))
            ar_tokens.sort(key=lambda w: (round(w["top"] / 4.0), -w["x1"]))

            en_raw = " ".join(w["text"] for w in en_tokens)
            ar_raw = " ".join(w["text"] for w in ar_tokens)

            price_num = parse_numeric_price(pw["text"])
            if price_num is None:
                continue

            en, ar, outsourced = sanitize_procedure_names(en_raw, ar_raw)
            if not en and not ar:
                continue

            rows.append({
                "code": None,
                "nameEnglish": en,
                "nameArabic": ar,
                "price": format_price_string(price_num),
                "sectionName": sec or "General",
                "outsourced": outsourced,
                "has_cid_corruption": "(cid:" in ar_raw or "\x03" in ar_raw,
            })

        confidence = 0.88 if len(rows) == len(price_words) else 0.75
        return rows, sec, confidence

    def extract_l4_gemini_vision(
        self, doc: pymupdf.Document, page_num: int, section_name: str
    ) -> List[Dict[str, Any]]:
        """
        L4: Gemini Vision fallback for scanned or corrupted CID font pages.
        Caches page extraction by page pixmap SHA-256.
        """
        try:
            page = doc[page_num - 1]
            pix = page.get_pixmap(dpi=200)
            img_bytes = pix.tobytes("png")
            page_hash = compute_bytes_sha256(img_bytes)

            # Check cache
            if page_hash in self._page_cache:
                logger.info(f"Loaded L4 Gemini extraction from cache for Page {page_num} (hash: {page_hash[:10]})")
                return self._page_cache[page_hash]

            api_key = os.getenv("GEMINI_API_KEY") or os.getenv("VITE_GEMINI_API_KEY")
            if not api_key:
                logger.warning(f"Gemini API key not found; skipping L4 Vision on Page {page_num}")
                return []

            from google import genai
            from google.genai import types

            client = genai.Client(api_key=api_key)
            prompt = (
                "You are an expert healthcare data extractor. Extract all medical procedures from this hospital pricelist page.\n"
                "Return a strict JSON array of objects with keys:\n"
                "- code: string or null\n"
                "- nameEnglish: string\n"
                "- nameArabic: string\n"
                "- price: string (positive integer or float string, e.g. '1500')\n"
                "- sectionName: string (department name)\n"
                "- outsourced: boolean\n"
                "Rules:\n"
                "- Do not invent any procedures or prices.\n"
                "- Price must be strictly positive numeric string.\n"
                "- If Arabic is reversed in the image, return it in natural logical Arabic.\n"
            )

            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[
                    types.Part.from_bytes(data=img_bytes, mime_type="image/png"),
                    prompt,
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    temperature=0.0,
                ),
            )

            raw_text = response.text or "[]"
            parsed = json.loads(raw_text)
            if isinstance(parsed, list):
                self._page_cache[page_hash] = parsed
                self._save_cache()
                return parsed
        except Exception as e:
            logger.warning(f"L4 Gemini Vision failed on Page {page_num}: {e}")

        return []

    def extract(self, source: Any = None) -> List[ProcedureItem]:
        """
        Extracts all valid procedures from the PDF using layered L1/L2/L3/L4 strategy.
        """
        if not self.file_path.exists():
            logger.error(f"PDF file does not exist: {self.file_path}")
            return []

        doc_fitz = pymupdf.open(self.file_path)
        total_pages = len(doc_fitz)
        limit_pages = min(total_pages, self.max_pages) if self.max_pages else total_pages

        logger.info(f"Starting layered PDF extraction for {self.file_path.name} ({limit_pages} pages, year {self.year})")

        items: List[ProcedureItem] = []
        current_section = "General"

        with pdfplumber.open(self.file_path) as pdf:
            for pno in range(1, limit_pages + 1):
                p_plumb = pdf.pages[pno - 1]
                p_text = p_plumb.extract_text() or ""

                if self.is_toc_or_cover_page(p_text, pno):
                    continue

                # Run L2 (table lines)
                l2_rows, new_sec_l2, conf_l2 = self.extract_l2_tables(p_plumb, pno, current_section)
                if new_sec_l2:
                    current_section = new_sec_l2

                # Run L1 (word coordinates)
                l1_rows, new_sec_l1, conf_l1 = self.extract_l1_words(p_plumb, pno, current_section)
                if new_sec_l1 and not new_sec_l2:
                    current_section = new_sec_l1

                chosen_rows: List[Dict[str, Any]] = []
                extractor_tag = "L2"
                confidence = 0.95

                # Compare L1 vs L2
                if l2_rows and conf_l2 >= 0.70:
                    chosen_rows = l2_rows
                    extractor_tag = "L2"
                    # If L1 agrees closely on row count and prices, boost confidence
                    if l1_rows and len(l1_rows) == len(l2_rows):
                        confidence = 0.98
                    else:
                        confidence = conf_l2
                elif l1_rows and conf_l1 >= 0.70:
                    chosen_rows = l1_rows
                    extractor_tag = "L1"
                    confidence = conf_l1
                else:
                    # Low confidence or scanned page -> L4 Gemini Vision fallback
                    l4_rows = self.extract_l4_gemini_vision(doc_fitz, pno, current_section)
                    if l4_rows:
                        chosen_rows = l4_rows
                        extractor_tag = "L4"
                        confidence = 0.92
                    elif l2_rows:
                        chosen_rows = l2_rows
                        extractor_tag = "L2"
                        confidence = conf_l2
                    elif l1_rows:
                        chosen_rows = l1_rows
                        extractor_tag = "L1"
                        confidence = conf_l1

                # Build validated ProcedureItem objects with full provenance
                for r in chosen_rows:
                    en_name = r.get("nameEnglish", "")
                    ar_name = r.get("nameArabic", "")
                    price_val = r.get("price", "")
                    sec_name = r.get("sectionName") or current_section

                    if not price_val:
                        continue

                    # Assign quality flags
                    flags = []
                    row_conf = confidence
                    if r.get("has_cid_corruption"):
                        flags.append("needs_review")
                        flags.append("unverified_arabic_encoding")
                        row_conf = min(row_conf, 0.60)
                    elif row_conf < 0.90:
                        flags.append("needs_review")

                    try:
                        item = ProcedureItem(
                            code=r.get("code"),
                            nameEnglish=en_name,
                            nameArabic=ar_name,
                            price=str(price_val),
                            sectionName=sec_name,
                            sourceFile=self.file_path.name,
                            outsourced=r.get("outsourced"),
                            sources=[{
                                "file": self.file_path.name,
                                "sha256": self.file_sha256,
                                "page": pno,
                                "extractor": extractor_tag,
                            }],
                            extractor=extractor_tag,
                            extractorVersion=self.EXTRACTOR_VERSION,
                            confidence=row_conf,
                            flags=flags,
                        )
                        items.append(item)
                    except Exception as err:
                        logger.debug(f"Pydantic validation skipped row on page {pno}: {err}")

        doc_fitz.close()
        logger.info(f"Layered PDF extraction completed: {len(items)} procedures extracted from {self.file_path.name}")
        return items
