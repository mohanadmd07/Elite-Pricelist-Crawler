"""
Year-Over-Year Pricelist Differential Analysis.
Compares consecutive hospital pricelist catalogs and outputs a Markdown audit report
to reports/yoy_diff_<year>.md detailing price trends, newly introduced procedures,
and retired services.
"""

from pathlib import Path
from typing import List, Dict, Optional, Tuple
from crawler.config import settings
from crawler.models import ProcedureItem
from crawler.normalizers import parse_numeric_price, normalize_text, normalize_arabic


class YoYDiffReporter:
    """Generates analytical year-over-year comparison markdown reports."""

    def __init__(self, current_year: str, prior_year: str, reports_dir: Optional[Path] = None):
        self.current_year = current_year
        self.prior_year = prior_year
        self.reports_dir = reports_dir or (settings.BASE_DIR / "reports")
        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def _canonical_key(self, item: ProcedureItem) -> str:
        """Normalized key for procedure matching."""
        if item.code and str(item.code).strip():
            return f"code:{str(item.code).strip().lower()}"
        norm_en = normalize_text(item.nameEnglish)
        norm_ar = normalize_arabic(item.nameArabic)
        return f"name:{norm_en}|{norm_ar}"

    def generate_report(
        self, current_items: List[ProcedureItem], prior_items: List[ProcedureItem]
    ) -> Path:
        """Generates and writes the Markdown diff report."""
        prior_map = {self._canonical_key(it): it for it in prior_items}
        current_map = {self._canonical_key(it): it for it in current_items}

        added: List[ProcedureItem] = []
        removed: List[ProcedureItem] = []
        price_changes: List[Dict[str, Any]] = []
        unchanged = 0

        for key, curr in current_map.items():
            if key not in prior_map:
                added.append(curr)
            else:
                prev = prior_map[key]
                p_curr = parse_numeric_price(curr.price) or 0.0
                p_prev = parse_numeric_price(prev.price) or 0.0
                if abs(p_curr - p_prev) > 0.01:
                    diff = p_curr - p_prev
                    diff_pct = (diff / p_prev * 100.0) if p_prev > 0 else 0.0
                    price_changes.append({
                        "name": curr.nameEnglish or curr.nameArabic,
                        "arabic": curr.nameArabic,
                        "section": curr.sectionName,
                        "prior_price": p_prev,
                        "current_price": p_curr,
                        "diff": diff,
                        "diff_pct": diff_pct,
                    })
                else:
                    unchanged += 1

        for key, prev in prior_map.items():
            if key not in current_map:
                removed.append(prev)

        # Sort price changes by absolute percentage change descending
        price_changes.sort(key=lambda x: abs(x["diff_pct"]), reverse=True)

        avg_inflation = (
            sum(c["diff_pct"] for c in price_changes) / len(price_changes)
            if price_changes
            else 0.0
        )

        md_path = self.reports_dir / f"yoy_diff_{self.current_year}.md"
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(f"# Elite Hospital Pricelist YoY Differential: {self.prior_year} vs {self.current_year}\n\n")
            f.write(f"- **Generated:** {Path(__file__).name}\n")
            f.write(f"- **Total Procedures ({self.prior_year}):** {len(prior_items):,}\n")
            f.write(f"- **Total Procedures ({self.current_year}):** {len(current_items):,}\n")
            f.write(f"- **Unchanged Price Items:** {unchanged:,}\n")
            f.write(f"- **Price Altered Items:** {len(price_changes):,}\n")
            f.write(f"- **Newly Added Services:** {len(added):,}\n")
            f.write(f"- **Discontinued/Removed Services:** {len(removed):,}\n")
            f.write(f"- **Average Price Shift:** `{avg_inflation:+.1f}%`\n\n")

            f.write("## Top 15 Price Adjustments\n\n")
            f.write("| Procedure | Arabic Name | Department | Prior (EGP) | New (EGP) | Shift (%) |\n")
            f.write("| :--- | :--- | :--- | :---: | :---: | :---: |\n")
            for c in price_changes[:15]:
                f.write(
                    f"| {c['name']} | {c['arabic']} | {c['section']} | "
                    f"{c['prior_price']:,.0f} | {c['current_price']:,.0f} | "
                    f"`{c['diff_pct']:+.1f}%` |\n"
                )

            if added:
                f.write(f"\n## Sample Newly Introduced Procedures ({len(added)} total)\n\n")
                f.write("| Procedure | Arabic Name | Department | Price (EGP) |\n")
                f.write("| :--- | :--- | :--- | :---: |\n")
                for a in added[:10]:
                    f.write(f"| {a.nameEnglish} | {a.nameArabic} | {a.sectionName} | {a.price} |\n")

        return md_path
