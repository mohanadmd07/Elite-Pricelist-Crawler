#!/usr/bin/env python3
"""
Elite Pricelist Crawler & Ingestion Engine - CLI Entrypoint.
Orchestrates workbook extractions, web crawling, deduplication, and pipeline exports.
"""

import sys
import asyncio
from pathlib import Path
import click
from rich.console import Console
from rich.table import Table

from crawler.config import settings
from crawler.extractors.excel_extractor import ExcelPricelistExtractor
from crawler.extractors.web_spider import WebPricelistSpider
from crawler.models import CrawlRequest
from crawler.pipelines.deduplication import DeduplicationPipeline
from crawler.pipelines.exporters import JsonExporter
from crawler.utils.logger import logger

console = Console()

WORKBOOK_MAPPINGS = {
    "2023": "2023 Cash.xlsx",
    "2024": "2024 Pricelist extracted.xlsx",
    "2025": "2025 Cash.xlsx",
    "2026": "2026 Elite Cash PL 12-1 (1).xlsx",
}


@click.group()
def cli():
    """Elite Hospital Pricelist Crawler & Data Pipeline."""
    pass


@cli.command(name="extract-excel")
@click.option("--year", "-y", type=click.Choice(["2023", "2024", "2025", "2026", "all"]), default="all", help="Target year to extract.")
@click.option("--dry-run", is_flag=True, help="Extract and report without writing to disk.")
@click.option("--indent", type=int, default=None, help="JSON output formatting indentation.")
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
                import json
                try:
                    with open(out_file, "r", encoding="utf-8") as f:
                        old_items = json.load(f)
                    custom = [
                        item for item in old_items
                        if item.get("sectionName") not in ("Sheet1", "General")
                    ]
                    from crawler.models import ProcedureItem
                    for c in custom:
                        try:
                            raw_items.append(ProcedureItem(**c))
                        except Exception:
                            pass
                except Exception as e:
                    logger.debug(f"Could not merge existing 2025 custom items: {e}")

        # Run through deduplication pipeline
        clean_items, summary = DeduplicationPipeline.process(raw_items, source_name=yr)

        if not dry_run:
            out_path = settings.PUBLIC_DIR / f"{yr}_cash.json"
            JsonExporter.export(clean_items, out_path, indent=indent)
            summary.output_path = str(out_path)

        results.append(summary)

    # Print summary table
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
