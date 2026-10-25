"""
Validation Gates and Quality Assurance Pipeline.
Enforces strict healthcare data integrity, schema compliance, and price plausibility:

- Positive numeric price > 0 in EGP.
- Non-empty procedure nomenclature (English or Arabic required).
- Catalog code sanity and duplicate detection.
- Year-over-year price jump/drop anomaly detection (flags > 300% jump or > 80% drop).
- Pydantic v2 validation before export; stops the build on blocking errors.
"""

import re
from typing import List, Dict, Tuple, Optional, Any, Set
from pydantic import ValidationError

from crawler.models import ProcedureItem
from crawler.normalizers import parse_numeric_price, clean_text
from crawler.utils.logger import logger

# Code regex: alphanumeric, optional hyphens or dots (e.g. "RAD-101", "LAB.04", "1002")
CODE_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,30}$")


class ValidationGateError(Exception):
    """Raised when a blocking validation gate fails."""
    pass


class PricelistValidator:
    """Enforces quality gates on extracted ProcedureItems."""

    def __init__(
        self,
        year: str,
        prior_year_prices: Optional[Dict[str, float]] = None,
        max_yoy_growth_ratio: float = 4.0,  # +300% max
        min_yoy_drop_ratio: float = 0.20,    # -80% max drop
    ):
        self.year = year
        self.prior_year_prices = prior_year_prices or {}
        self.max_yoy_growth_ratio = max_yoy_growth_ratio
        self.min_yoy_drop_ratio = min_yoy_drop_ratio

    def validate_row(self, item: ProcedureItem, seen_codes: Set[str]) -> Tuple[bool, List[str]]:
        """
        Validates an individual procedure item.
        Returns (is_valid, validation_errors_or_flags).
        """
        issues = []

        # 1. Price check
        price_num = parse_numeric_price(item.price)
        if price_num is None or price_num <= 0:
            return False, [f"Invalid or non-positive price: {item.price}"]

        # 2. Nomenclature check
        clean_en = clean_text(item.nameEnglish)
        clean_ar = clean_text(item.nameArabic)
        if not clean_en and not clean_ar:
            return False, ["Both English and Arabic names are empty"]

        # 3. Code format & duplicate check
        if item.code:
            code_str = str(item.code).strip()
            if not CODE_PATTERN.match(code_str):
                issues.append(f"Invalid code format: {code_str}")
            elif code_str in seen_codes:
                issues.append(f"Duplicate catalog code: {code_str}")
            else:
                seen_codes.add(code_str)

        # 4. Year-over-year outlier detection
        lookup_key = (clean_en.lower() if clean_en else "") or clean_ar
        if lookup_key in self.prior_year_prices:
            prior = self.prior_year_prices[lookup_key]
            if prior > 0:
                ratio = price_num / prior
                if ratio > self.max_yoy_growth_ratio:
                    issues.append(f"price_outlier_jump (YoY {ratio:.1f}x from {prior})")
                elif ratio < self.min_yoy_drop_ratio:
                    issues.append(f"price_outlier_drop (YoY {ratio:.2f}x from {prior})")

        return True, issues

    def validate_catalog(
        self, items: List[ProcedureItem], fail_fast: bool = False
    ) -> Tuple[List[ProcedureItem], List[ProcedureItem], Dict[str, Any]]:
        """
        Validates an entire catalog of extracted items.
        Returns (valid_items, review_queue_items, summary_stats).
        """
        valid_items: List[ProcedureItem] = []
        review_items: List[ProcedureItem] = []
        seen_codes: Set[str] = set()

        stats = {
            "total_evaluated": len(items),
            "passed_clean": 0,
            "routed_to_review": 0,
            "blocking_errors": 0,
            "flags_assigned": {},
        }

        for item in items:
            # Pydantic schema validation
            try:
                # Re-validate with Pydantic
                item = ProcedureItem.model_validate(item)
            except ValidationError as ve:
                stats["blocking_errors"] += 1
                if fail_fast:
                    raise ValidationGateError(f"Schema validation failure: {ve}")
                continue

            is_valid, row_issues = self.validate_row(item, seen_codes)
            if not is_valid:
                stats["blocking_errors"] += 1
                if fail_fast:
                    raise ValidationGateError(f"Row validation failed: {row_issues}")
                continue

            if row_issues:
                for issue in row_issues:
                    item.flags.append(issue)
                    stats["flags_assigned"][issue] = stats["flags_assigned"].get(issue, 0) + 1

            # If item has review flags or low confidence, route to review queue
            if "needs_review" in item.flags or item.confidence < 0.90 or any("outlier" in f for f in item.flags):
                review_items.append(item)
                stats["routed_to_review"] += 1
            else:
                valid_items.append(item)
                stats["passed_clean"] += 1

        logger.info(
            f"Validation Gate finished ({self.year}): {stats['passed_clean']} clean, "
            f"{stats['routed_to_review']} to review, {stats['blocking_errors']} dropped"
        )
        return valid_items, review_items, stats
