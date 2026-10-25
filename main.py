#!/usr/bin/env python3
"""
Elite Pricelist Crawler & Ingestion Engine - CLI Entrypoint.
Orchestrates workbook extractions, layered PDF parsing, reconciliation,
corrections review loop, deduplication, and atomic pipeline exports.
"""

import sys
import json
import asyncio
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict, Any, Optional

import click
from rich.console import Console
from rich.table import Table
from rich.prompt import Prompt

from crawler.config import settings
from crawler.extractors.excel_extractor import ExcelPricelistExtractor
from crawler.extractors.pdf_extractor import LayeredPdfExtractor
from crawler.extractors.web_spider import WebPricelistSpider
from crawler.models import (
    CrawlRequest,
    ProcedureItem,
    BuildManifest,
    SourceInventory,
)
from crawler.pipelines.deduplication import DeduplicationPipeline
from crawler.pipelines.exporters import JsonExporter
from crawler.pipelines.source_inventory import SourceInventoryScanner
from crawler.pipelines.validation import PricelistValidator
from crawler.pipelines.reconcile import PricelistReconciler
from crawler.pipelines.corrections import CorrectionsManager
from crawler.pipelines.yoy_diff import YoYDiffReporter
from crawler.utils.logger import logger

console = Console()

WORKBOOK_MAPPINGS = {
    "2023": "2023 Cash.xlsx",
    "2024": "2024 Pricelist extracted.xlsx",
    "2025": "2025 Cash.xlsx",
    "2026": "2026 Elite Cash PL 12-1 (1).xlsx",
}

PDF_MAPPINGS = {
    "2023": "public/2023.pdf",
    "2024": "public/2024.pdf",
    "2025": "public/2025.pdf",
}


@click.group()
def cli():
    """Elite Hospital Pricelist Crawler & Data Pipeline."""
    pass


@cli.command(name="inventory")
def inventory_cmd():
    """Scans and catalogs all Excel and PDF sources into data/source_inventory.json."""
    scanner = SourceInventoryScanner()
    inv = scanner.scan_all()

    table = Table(title="Pricelist Source Inventory", style="cyan")
    table.add_column("Type", style="bold white")
    table.add_column("Year", style="bold yellow")
    table.add_column("Filename", style="magenta")
    table.add_column("Pages/Sheets", justify="right", style="green")
    table.add_column("SHA-256 (Prefix)", style="dim")
    table.add_column("Text Layer", justify="center", style="cyan")

    for s in inv.sources:
        table.add_row(
            s.file_type.upper(),
            s.year,
            s.file_name,
            str(s.page_count),
            s.sha256[:12] + "...",
            "✓" if s.has_text_layer else "Scanned",
        )

    console.print(table)


@cli.command(name="rebuild")
@click.option("--years", "-y", default="all", help="Target years to rebuild (e.g. '2023,2024,2025,2026' or 'all').")
@click.option("--sources", "-s", default="excel,pdf", help="Source types to process: 'excel', 'pdf', or 'excel,pdf'.")
@click.option("--only-changed", is_flag=True, help="Only reprocess sources whose SHA-256 changed in source inventory.")
@click.option("--max-pdf-pages", type=int, default=None, help="Limit PDF pages extracted (for fast test runs).")
@click.option("--dry-run", is_flag=True, help="Extract and validate without writing public/*.json.")
def rebuild_cmd(years: str, sources: str, only_changed: bool, max_pdf_pages: Optional[int], dry_run: bool):
    """
    Complete reproducible pipeline rebuild:
    Extracts Excel & PDF -> Reconciles -> Applies Review Decisions -> Validates ->
    Deterministically exports to public/*_cash.json -> Emits YoY Diffs & Build Manifest.
    """
    scanner = SourceInventoryScanner()
    inventory = scanner.scan_all()

    corrections_mgr = CorrectionsManager()
    selected_sources = [s.strip().lower() for s in sources.split(",")]

    if years == "all":
        target_years = ["2023", "2024", "2025", "2026"]
    else:
        target_years = [y.strip() for y in years.split(",")]

    manifest_input_hashes = {}
    manifest_checksums = {}
    total_extracted_all = 0
    total_clean_all = 0
    total_review_all = 0
    flag_summary_all: Dict[str, int] = {}

    prior_year_data: Dict[str, List[ProcedureItem]] = {}

    report_table = Table(title="Pricelist Rebuild & Provenance Summary", style="cyan")
    report_table.add_column("Year", style="bold white")
    report_table.add_column("Excel Rows", justify="right", style="green")
    report_table.add_column("PDF Rows", justify="right", style="green")
    report_table.add_column("Clean Exported", justify="right", style="bold green")
    report_table.add_column("Review Queue", justify="right", style="yellow")
    report_table.add_column("Public Checksum", style="magenta")

    for yr in sorted(target_years):
        excel_items: List[ProcedureItem] = []
        pdf_items: List[ProcedureItem] = []

        # 1. Process Excel Source
        if "excel" in selected_sources and yr in WORKBOOK_MAPPINGS:
            fname = WORKBOOK_MAPPINGS[yr]
            fpath = settings.BASE_DIR / fname
            if fpath.exists():
                h = hashlib.sha256(fpath.read_bytes()).hexdigest()
                manifest_input_hashes[f"excel_{yr}"] = h
                if only_changed and not scanner.has_file_changed(fpath):
                    logger.info(f"Skipping unchanged Excel source: {fname}")
                else:
                    extractor = ExcelPricelistExtractor(str(fpath), yr)
                    excel_items = extractor.extract()

        # 2. Process PDF Source
        if "pdf" in selected_sources and yr in PDF_MAPPINGS:
            pdf_rel = PDF_MAPPINGS[yr]
            pdf_path = settings.BASE_DIR / pdf_rel
            if pdf_path.exists():
                h = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
                manifest_input_hashes[f"pdf_{yr}"] = h
                if only_changed and not scanner.has_file_changed(pdf_path):
                    logger.info(f"Skipping unchanged PDF source: {pdf_rel}")
                else:
                    pdf_extractor = LayeredPdfExtractor(str(pdf_path), yr, max_pages=max_pdf_pages)
                    pdf_items = pdf_extractor.extract()

        # 3. Reconciliation
        if excel_items and pdf_items:
            reconciler = PricelistReconciler(yr)
            aligned_items, _ = reconciler.reconcile(excel_items, pdf_items)
        elif excel_items:
            aligned_items = excel_items
        elif pdf_items:
            aligned_items = pdf_items
        else:
            logger.warning(f"No source items found for year {yr}")
            continue

        total_extracted_all += len(aligned_items)

        # 4. Deduplication
        deduped_items, _ = DeduplicationPipeline.process(aligned_items, source_name=yr)

        # 5. Apply Manual Corrections & Overrides from data/pdf_corrections.json
        retained_items, rejected_items = corrections_mgr.apply_corrections(deduped_items)

        # 6. Validation Gates & Quality Control
        prior_year_int = str(int(yr) - 1)
        prior_prices = {}
        if prior_year_int in prior_year_data:
            for it in prior_year_data[prior_year_int]:
                p = float(it.price) if it.price else 0.0
                if p > 0:
                    k = (it.nameEnglish.strip().lower() if it.nameEnglish else "") or it.nameArabic.strip()
                    prior_prices[k] = p

        validator = PricelistValidator(year=yr, prior_year_prices=prior_prices)
        clean_items, review_items, vstats = validator.validate_catalog(retained_items)

        total_clean_all += len(clean_items)
        total_review_all += len(review_items)
        for flag, cnt in vstats["flags_assigned"].items():
            flag_summary_all[flag] = flag_summary_all.get(flag, 0) + cnt

        # Save review queue for this year
        if review_items:
            rev_path = settings.BASE_DIR / "data" / f"review_queue_{yr}.json"
            rev_path.parent.mkdir(parents=True, exist_ok=True)
            with open(rev_path, "w", encoding="utf-8") as f:
                json.dump([it.model_dump() for it in review_items], f, indent=2, ensure_ascii=False)

        # 7. Atomic Public JSON Export
        checksum = "DRY-RUN"
        if not dry_run:
            out_path = settings.PUBLIC_DIR / f"{yr}_cash.json"
            checksum = JsonExporter.export(clean_items, out_path, indent=2)
            manifest_checksums[yr] = checksum

        # Keep current items in memory for subsequent year-over-year comparison
        prior_year_data[yr] = clean_items

        # 8. Year-over-Year Diff Report
        if prior_year_int in prior_year_data:
            reporter = YoYDiffReporter(yr, prior_year_int)
            reporter.generate_report(clean_items, prior_year_data[prior_year_int])

        report_table.add_row(
            yr,
            str(len(excel_items)),
            str(len(pdf_items)),
            str(len(clean_items)),
            str(len(review_items)),
            checksum[:12] if checksum != "DRY-RUN" else checksum,
        )

    console.print(report_table)

    # 9. Emit Build Manifest
    if not dry_run:
        manifest = BuildManifest(
            schemaVersion=2,
            buildTimestamp=datetime.now(timezone.utc).isoformat(),
            targetYears=target_years,
            inputHashes=manifest_input_hashes,
            extractorVersions={
                "excel": "1.2.0",
                "pdf_layered": "1.2.0",
            },
            totalExtractedRows=total_extracted_all,
            totalCleanExportedRows=total_clean_all,
            totalReviewQueueRows=total_review_all,
            flagSummary=flag_summary_all,
            exportChecksums=manifest_checksums,
        )
        manifest_path = settings.BASE_DIR / "data" / "build_manifest.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest.model_dump(), f, indent=2)
        logger.info(f"Build manifest emitted to {manifest_path}")


@cli.command(name="review")
@click.option("--year", "-y", required=True, help="Year of the review queue (e.g. '2024').")
def review_cmd(year: str):
    """Interactive CLI to review low-confidence extractions and save decisions."""
    rev_path = settings.BASE_DIR / "data" / f"review_queue_{year}.json"
    if not rev_path.exists():
        console.print(f"[green]No review items found for year {year} at {rev_path}[/green]")
        return

    with open(rev_path, "r", encoding="utf-8") as f:
        items = json.load(f)

    if not items:
        console.print(f"[green]Review queue for year {year} is empty![/green]")
        return

    mgr = CorrectionsManager()
    console.print(f"[bold cyan]Review Queue for Year {year} ({len(items)} items)[/bold cyan]")
    console.print("[dim]Options: [a]ccept, [e]dit, [r]eject, [s]kip, [q]uit[/dim]\n")

    for idx, raw_it in enumerate(items, 1):
        item = ProcedureItem(**raw_it)
        console.print(f"[bold]Item {idx}/{len(items)}:[/bold]")
        console.print(f"  English : [green]{item.nameEnglish}[/green]")
        console.print(f"  Arabic  : [cyan]{item.nameArabic}[/cyan]")
        console.print(f"  Price   : [yellow]{item.price} EGP[/yellow]")
        console.print(f"  Section : {item.sectionName}")
        console.print(f"  Flags   : {item.flags}")
        console.print(f"  Conf    : {item.confidence:.2f}")

        choice = Prompt.ask("Action", choices=["a", "e", "r", "s", "q"], default="a")
        if choice == "q":
            break
        elif choice == "s":
            continue

        sha256 = item.sources[0].get("sha256", "") if item.sources else ""
        page = item.sources[0].get("page", 0) if item.sources else 0
        ident = item.code or item.nameEnglish or item.nameArabic

        if choice == "a":
            mgr.record_decision(sha256, page, ident, action="accept")
            console.print("[green]Accepted.[/green]\n")
        elif choice == "r":
            mgr.record_decision(sha256, page, ident, action="reject")
            console.print("[red]Rejected.[/red]\n")
        elif choice == "e":
            new_en = Prompt.ask("New English Name", default=item.nameEnglish)
            new_ar = Prompt.ask("New Arabic Name", default=item.nameArabic)
            new_price = Prompt.ask("New Price (EGP)", default=item.price)
            mgr.record_decision(
                sha256, page, ident, action="edit",
                corrected_name_en=new_en, corrected_name_ar=new_ar, corrected_price=new_price
            )
            console.print("[green]Saved edit.[/green]\n")

    console.print("[bold green]Review session finished.[/bold green]")


@cli.command(name="extract-excel")
@click.option("--year", "-y", type=click.Choice(["2023", "2024", "2025", "2026", "all"]), default="all", help="Target year to extract.")
@click.option("--dry-run", is_flag=True, help="Extract and report without writing to disk.")
@click.option("--indent", type=int, default=2, help="JSON output formatting indentation.")
def extract_excel_cmd(year: str, dry_run: bool, indent: int):
    """Extract and normalize procedures from local hospital Excel pricelists."""
    targets = list(WORKBOOK_MAPPINGS.keys()) if year == "all" else [year]
    results = []

    for yr in targets:
        fname = WORKBOOK_MAPPINGS[yr]
        fpath = settings.BASE_DIR / fname

        if not fpath.exists():
            logger.warning(f"File {fname} not found in project root. Skipping.")
            continue

        extractor = ExcelPricelistExtractor(file_path=str(fpath), year=yr)
        raw_items = extractor.extract()

        # Handle 2025 custom non-default manual additions if file already exists
        if yr == "2025":
            out_file = settings.PUBLIC_DIR / "2025_cash.json"
            if out_file.exists():
                try:
                    with open(out_file, "r", encoding="utf-8") as f:
                        old_items = json.load(f)
                    custom = [
                        item for item in old_items
                        if item.get("sectionName") not in ("Sheet1", "General")
                    ]
                    for c in custom:
                        try:
                            raw_items.append(ProcedureItem(**c))
                        except Exception:
                            pass
                except Exception as e:
                    logger.debug(f"Could not merge existing 2025 custom items: {e}")

        clean_items, summary = DeduplicationPipeline.process(raw_items, source_name=yr)

        if not dry_run:
            out_path = settings.PUBLIC_DIR / f"{yr}_cash.json"
            JsonExporter.export(clean_items, out_path, indent=indent)
            summary.output_path = str(out_path)

        results.append(summary)

    table = Table(title="Pricelist Extraction Report", style="cyan")
    table.add_column("Year / Source", style="bold white")
    table.add_column("Items Retained", justify="right", style="green")
    table.add_column("Duplicates Removed", justify="right", style="yellow")
    table.add_column("Output File", style="magenta")

    for r in results:
        table.add_row(
            r.year_or_source,
            str(r.total_extracted),
            str(r.duplicates_removed),
            r.output_path or "(Dry Run - Not saved)",
        )

    console.print(table)


@cli.command(name="crawl-url")
@click.argument("url")
@click.option("--use-browser", is_flag=True, help="Use Playwright headless browser for JavaScript SPAs.")
@click.option("--output", "-o", default=None, help="Target JSON output path.")
def crawl_url_cmd(url: str, use_browser: bool, output: str):
    """Crawl an online medical pricelist URL and parse table items."""
    spider = WebPricelistSpider()
    request = CrawlRequest(url=url, use_browser=use_browser)

    logger.info(f"Initiating crawl on: {url} (browser={use_browser})")
    items = spider.extract(request)
    clean_items, summary = DeduplicationPipeline.process(items, source_name=url)

    if output:
        out_path = Path(output)
        JsonExporter.export(clean_items, out_path)
    else:
        console.print(f"[green]Successfully parsed {len(clean_items)} items from {url}[/green]")


if __name__ == "__main__":
    cli()
