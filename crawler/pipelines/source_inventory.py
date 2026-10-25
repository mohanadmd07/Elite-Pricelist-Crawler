"""
Source Inventory Pipeline.
Scans all hospital Excel workbooks and PDF pricelists, calculates SHA-256 fingerprints,
detects text layers vs scanned images, determines languages and layout types,
and outputs a versioned data/source_inventory.json manifest.
Supports incremental re-processing by checking changed file hashes.
"""

import os
import re
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Dict, Any

import pymupdf
import openpyxl

from crawler.config import settings
from crawler.models import SourceFileMetadata, SourceInventory
from crawler.utils.logger import logger


def calculate_sha256(file_path: Path) -> str:
    """Computes SHA-256 hash of a file."""
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def detect_year_from_name_or_content(file_name: str, sample_text: str = "") -> str:
    """Extracts year (2020-2030) from file name or sampled text."""
    # Check filename first
    m = re.search(r"\b(202[3-9])\b", file_name)
    if m:
        return m.group(1)
    # Check sample content
    m = re.search(r"\b(202[3-9])\b", sample_text)
    if m:
        return m.group(1)
    return "unknown"


def detect_language(text: str) -> str:
    """Determines if text is primarily arabic, english, or mixed."""
    has_ar = bool(re.search(r"[\u0600-\u06FF]", text))
    has_en = bool(re.search(r"[a-zA-Z]", text))
    if has_ar and has_en:
        return "mixed"
    elif has_ar:
        return "arabic"
    elif has_en:
        return "english"
    return "unknown"


class SourceInventoryScanner:
    """Scans and catalogs all pricelist source files in the project."""

    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or settings.BASE_DIR
        self.inventory_path = self.base_dir / "data" / "source_inventory.json"

    def scan_file(self, file_path: Path) -> Optional[SourceFileMetadata]:
        """Inspects an individual Excel or PDF file and generates metadata."""
        if not file_path.exists() or file_path.is_dir():
            return None

        # Exclude internal seed files or temp copies
        rel_str = str(file_path.relative_to(self.base_dir))
        if "secure_seeds" in rel_str or "dist/" in rel_str or "node_modules" in rel_str or ".venv" in rel_str:
            return None

        suffix = file_path.suffix.lower()
        if suffix not in (".xlsx", ".xls", ".pdf"):
            return None

        file_name = file_path.name
        sha256 = calculate_sha256(file_path)
        file_size = file_path.stat().st_size
        now_iso = datetime.now(timezone.utc).isoformat()

        if suffix in (".xlsx", ".xls"):
            try:
                wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
                page_count = len(wb.sheetnames)
                wb.close()
            except Exception as e:
                logger.warning(f"Failed to inspect openpyxl sheetnames for {file_name}: {e}")
                page_count = 1

            year = detect_year_from_name_or_content(file_name)
            return SourceFileMetadata(
                file_path=rel_str,
                file_name=file_name,
                file_type="excel",
                year=year,
                sha256=sha256,
                file_size_bytes=file_size,
                page_count=page_count,
                has_text_layer=True,
                is_scanned_only=False,
                detected_language="mixed",
                layout_type="table",
                last_scanned_at=now_iso,
            )

        elif suffix == ".pdf":
            try:
                doc = pymupdf.open(file_path)
                page_count = len(doc)
                total_text_len = 0
                sample_text = ""
                for i in range(min(5, page_count)):
                    t = doc[i].get_text() or ""
                    total_text_len += len(t)
                    sample_text += " " + t
                doc.close()
            except Exception as e:
                logger.warning(f"Failed to inspect PDF with pymupdf for {file_name}: {e}")
                page_count = 0
                total_text_len = 0
                sample_text = ""

            year = detect_year_from_name_or_content(file_name, sample_text)
            has_text_layer = total_text_len > 100
            is_scanned_only = total_text_len == 0
            lang = detect_language(sample_text)

            return SourceFileMetadata(
                file_path=rel_str,
                file_name=file_name,
                file_type="pdf",
                year=year,
                sha256=sha256,
                file_size_bytes=file_size,
                page_count=page_count,
                has_text_layer=has_text_layer,
                is_scanned_only=is_scanned_only,
                detected_language=lang,
                layout_type="table",
                last_scanned_at=now_iso,
            )

        return None

    def scan_all(self, extra_paths: Optional[List[Path]] = None) -> SourceInventory:
        """Discovers all source workbooks and PDFs, writing data/source_inventory.json."""
        discovered: List[SourceFileMetadata] = []

        # Canonical search targets:
        # 1. Project root *.xlsx, *.xls, *.pdf
        # 2. public/ *.xlsx, *.pdf
        search_dirs = [self.base_dir, self.base_dir / "public"]
        if extra_paths:
            search_dirs.extend(extra_paths)

        seen_paths = set()
        for sdir in search_dirs:
            if not sdir.exists():
                continue
            for entry in sdir.iterdir():
                if entry.is_file() and entry.suffix.lower() in (".xlsx", ".xls", ".pdf"):
                    # Ignore non-pricelist files like contacts or comparison
                    if "contact" in entry.name.lower() or "comparison" in entry.name.lower():
                        continue
                    canonical = entry.resolve()
                    if canonical in seen_paths:
                        continue
                    seen_paths.add(canonical)
                    meta = self.scan_file(entry)
                    if meta:
                        discovered.append(meta)

        # Sort predictably by year then file_name
        discovered.sort(key=lambda x: (x.year, x.file_name))

        inventory = SourceInventory(
            schemaVersion=1,
            generatedAt=datetime.now(timezone.utc).isoformat(),
            sources=discovered,
        )

        # Write to data/source_inventory.json atomically
        self.inventory_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.inventory_path.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(inventory.model_dump(), f, indent=2, ensure_ascii=False)
        temp_path.replace(self.inventory_path)

        logger.info(f"Source inventory updated with {len(discovered)} files at {self.inventory_path}")
        return inventory

    def load_inventory(self) -> Optional[SourceInventory]:
        """Loads existing source_inventory.json if present."""
        if not self.inventory_path.exists():
            return None
        try:
            with open(self.inventory_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return SourceInventory(**data)
        except Exception as e:
            logger.warning(f"Could not load source inventory from {self.inventory_path}: {e}")
            return None

    def has_file_changed(self, file_path: Path) -> bool:
        """Returns True if the file is new or its SHA-256 differs from the catalog."""
        inv = self.load_inventory()
        if not inv:
            return True
        current_hash = calculate_sha256(file_path)
        rel_str = str(file_path.relative_to(self.base_dir))
        for s in inv.sources:
            if s.file_path == rel_str or s.file_name == file_path.name:
                return s.sha256 != current_hash
        return True
