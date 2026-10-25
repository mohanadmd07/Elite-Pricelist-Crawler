"""
Unit and Integration Tests for Phase 5: Pricelist Pipeline (Excel + PDF).
Covers Arabic BiDi detection & repair, NFKC normalization, layered PDF extraction,
reconciliation precedence, validation gates, corrections idempotency,
and deterministic byte-identical JSON exports.
"""

import os
import json
import pytest
from pathlib import Path

from crawler.models import ProcedureItem, SourceInventory, BuildManifest
from crawler.normalizers import (
    is_reversed_arabic,
    fix_bidi_arabic,
    reverse_visual_bidi,
    normalize_nfkc,
    clean_text,
    normalize_arabic,
    normalize_text,
    sanitize_procedure_names,
    parse_numeric_price,
    format_price_string,
)
from crawler.extractors.pdf_extractor import LayeredPdfExtractor
from crawler.pipelines.source_inventory import SourceInventoryScanner
from crawler.pipelines.validation import PricelistValidator
from crawler.pipelines.reconcile import PricelistReconciler
from crawler.pipelines.corrections import CorrectionsManager
from crawler.pipelines.exporters import JsonExporter


def test_bidi_arabic_reversal():
    """Validates visual-order reversed Arabic detection and logical restoration."""
    # Classical reversed sample: "ىعضوم ريدخت تحت جارخ حتف" -> "فتح خراج تحت تخدير موضعى"
    reversed_sample = "ىعضوم ريدخت تحت جارخ حتف"
    assert is_reversed_arabic(reversed_sample) is True

    fixed = fix_bidi_arabic(reversed_sample)
    assert fixed == "فتح خراج تحت تخدير موضعى"

    # Already logical sample should NOT be reversed
    logical_sample = "فتح خراج تحت تخدير موضعى"
    assert is_reversed_arabic(logical_sample) is False
    assert fix_bidi_arabic(logical_sample) == logical_sample

    # Mixed text with embedded English/parentheses
    mixed_reversed = ")ER( ءىراوطلا تامدخ"
    fixed_mixed = reverse_visual_bidi(mixed_reversed)
    assert fixed_mixed == "خدمات الطوارىء (ER)"


def test_nfkc_and_tashkeel_normalization():
    """Validates NFKC presentation forms collapse, diacritics removal, and digit translation."""
    # Lam-Alef presentation form U+FEFB
    presentation_form = "\uFEFB"
    collapsed = normalize_nfkc(presentation_form)
    assert collapsed == "لا"

    # Tashkeel and tatweel removal
    with_tashkeel = "إِسْتِئْصَالُ الْمَرَارَةِ"
    cleaned = clean_text(with_tashkeel)
    assert "َ" not in cleaned
    assert "ْ" not in cleaned

    # Eastern Arabic-Indic digits conversion
    indic_digits = "١٥٠٠"
    assert clean_text(indic_digits) == "1500"


def test_arabic_normalizer_typescript_parity():
    """Validates that crawler/normalizers.py produces identical outputs to arabic-normalizer.ts."""
    sample = "إستئصال مَرارة بالمنظار"
    norm_py = normalize_arabic(sample)
    # Both normalizeAlef, taa marbuta -> haa, hamza -> isolated hamza
    assert norm_py == "استءصال مراره بالمنظار"

    # English medical query normalization
    med_sample = "E.E.G. - Investigation"
    assert normalize_text(med_sample) == "eeg"


def test_sanitize_procedure_names():
    """Tests cross-column swap, send-out asterisk detection, and hyphen repair."""
    en, ar, outsourced = sanitize_procedure_names(
        "* Abscess un- der local anaesthesia",
        "ىعضوم ريدخت تحت جارخ حتف"
    )
    assert en == "Abscess under local anaesthesia"
    assert ar == "فتح خراج تحت تخدير موضعي"
    assert outsourced is True


def test_source_inventory_scanner(tmp_path):
    """Verifies that SourceInventoryScanner correctly catalogs project assets."""
    scanner = SourceInventoryScanner()
    inv = scanner.scan_all()
    assert inv.schemaVersion == 1
    assert len(inv.sources) >= 5
    # Assert 2023, 2024, 2025 are present
    years = {s.year for s in inv.sources}
    assert "2023" in years
    assert "2024" in years
    assert "2025" in years
    assert "2026" in years


def test_layered_pdf_extractor_page_structure():
    """Verifies LayeredPdfExtractor extracts valid procedures with additive metadata."""
    pdf_path = Path("public/2023.pdf")
    if not pdf_path.exists():
        pytest.skip("public/2023.pdf not present in test environment")

    extractor = LayeredPdfExtractor(str(pdf_path), "2023", max_pages=5)
    items = extractor.extract()
    assert len(items) > 0

    first = items[0]
    assert first.price and float(first.price) > 0
    assert first.sectionName == "Emergency (ER) Services"
    assert first.extractor in ("L1", "L2", "L3", "L4")
    assert first.extractorVersion == "1.2.0"
    assert 0.0 <= first.confidence <= 1.0
    assert len(first.sources) >= 1
    assert first.sources[0]["file"] == "2023.pdf"


def test_reconciliation_excel_vs_pdf():
    """Verifies dual confirmation, price conflict detection, and Excel precedence."""
    ex_item = ProcedureItem(
        nameEnglish="Chest X-Ray",
        nameArabic="أشعة على الصدر",
        price="400",
        sectionName="Radiology",
        sourceFile="2023 Cash.xlsx",
        sources=[{"file": "2023 Cash.xlsx", "sheet": "Radiology"}],
    )
    pdf_item_matching = ProcedureItem(
        nameEnglish="Chest X-Ray",
        nameArabic="أشعة على الصدر",
        price="400",
        sectionName="Radiology",
        sourceFile="2023.pdf",
        sources=[{"file": "2023.pdf", "page": 10}],
    )
    pdf_item_mismatch = ProcedureItem(
        nameEnglish="Chest X-Ray",
        nameArabic="أشعة على الصدر",
        price="450",
        sectionName="Radiology",
        sourceFile="2023.pdf",
        sources=[{"file": "2023.pdf", "page": 10}],
    )

    reconciler = PricelistReconciler("2023")

    # Match test: confidence boosts to 1.0, both sources merged
    aligned, records = reconciler.reconcile([ex_item], [pdf_item_matching])
    assert len(aligned) == 1
    assert aligned[0].confidence == 1.0
    assert len(aligned[0].sources) == 2
    assert records[0].match_status == "match"

    # Mismatch test: Excel price wins, flagged, confidence reduced
    aligned_mis, records_mis = reconciler.reconcile([ex_item], [pdf_item_mismatch])
    assert len(aligned_mis) == 1
    assert aligned_mis[0].price == "400"  # Excel precedence
    assert records_mis[0].match_status == "price_mismatch"
    assert any("price_mismatch" in f for f in aligned_mis[0].flags)


def test_corrections_manager_idempotency(tmp_path):
    """Verifies that human corrections are persisted and applied idempotently."""
    corr_file = tmp_path / "pdf_corrections.json"
    mgr = CorrectionsManager(corrections_path=corr_file)

    test_item = ProcedureItem(
        nameEnglish="Old Name",
        nameArabic="اسم قديم",
        price="200",
        sectionName="General",
        sourceFile="test.pdf",
        sources=[{"file": "test.pdf", "sha256": "abc1234", "page": 1}],
        confidence=0.75,
        flags=["needs_review"],
    )

    # 1. Edit decision
    mgr.record_decision(
        sha256="abc1234",
        page=1,
        row_or_code="Old Name",
        action="edit",
        corrected_name_en="Fixed Procedure Name",
        corrected_price="250",
    )

    retained, rejected = mgr.apply_corrections([test_item])
    assert len(retained) == 1
    assert len(rejected) == 0
    assert retained[0].nameEnglish == "Fixed Procedure Name"
    assert retained[0].price == "250"
    assert retained[0].confidence == 1.0
    assert "needs_review" not in retained[0].flags

    # 2. Reject decision on fresh item
    mgr.record_decision(
        sha256="abc1234",
        page=1,
        row_or_code="Old Name",
        action="reject",
    )
    test_item_fresh = ProcedureItem(
        nameEnglish="Old Name",
        nameArabic="اسم قديم",
        price="200",
        sectionName="General",
        sourceFile="test.pdf",
        sources=[{"file": "test.pdf", "sha256": "abc1234", "page": 1}],
        confidence=0.75,
        flags=["needs_review"],
    )
    retained2, rejected2 = mgr.apply_corrections([test_item_fresh])
    assert len(retained2) == 0
    assert len(rejected2) == 1


def test_validation_gates_and_pydantic_schema():
    """Verifies validation gates enforce positive prices and detect YoY outliers."""
    valid_item = ProcedureItem(
        nameEnglish="CBC",
        nameArabic="صورة دم كاملة",
        price="150",
        sectionName="Laboratory",
        sourceFile="test.xlsx",
    )
    outlier_item = ProcedureItem(
        nameEnglish="Brain MRI",
        nameArabic="رنين مغناطيسي على المخ",
        price="15000",  # Massive jump from prior year 2000
        sectionName="Radiology",
        sourceFile="test.xlsx",
    )

    validator = PricelistValidator(
        year="2024",
        prior_year_prices={"cbc": 140.0, "brain mri": 2000.0},
    )

    clean, review, stats = validator.validate_catalog([valid_item, outlier_item])
    assert len(clean) == 1
    assert clean[0].nameEnglish == "CBC"
    assert len(review) == 1
    assert review[0].nameEnglish == "Brain MRI"
    assert any("price_outlier_jump" in f for f in review[0].flags)


def test_deterministic_byte_identical_export(tmp_path):
    """Verifies that JsonExporter produces byte-identical JSON checksums across calls."""
    out_file = tmp_path / "test_export.json"
    items = [
        ProcedureItem(nameEnglish="Zeta Test", price="500", sectionName="Special", sourceFile="src.xlsx"),
        ProcedureItem(nameEnglish="Alpha Test", price="100", sectionName="General", sourceFile="src.xlsx"),
    ]

    chk1 = JsonExporter.export(items, out_file, indent=2)
    chk2 = JsonExporter.export(items, out_file, indent=2)

    assert chk1 == chk2

    # Check sort keys and section sorting
    with open(out_file, "r", encoding="utf-8") as f:
        data = json.load(f)

    assert data[0]["nameEnglish"] == "Alpha Test"
    assert data[1]["nameEnglish"] == "Zeta Test"
