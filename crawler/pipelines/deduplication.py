"""
Deduplication pipeline: ensures uniqueness across items based on canonical tuple key.
"""

from typing import List, Tuple, Set
from crawler.models import ProcedureItem, BatchSummary
from crawler.utils.logger import logger


class DeduplicationPipeline:
    """Filters duplicate procedure records and generates clean summaries."""

    @staticmethod
    def process(items: List[ProcedureItem], source_name: str) -> Tuple[List[ProcedureItem], BatchSummary]:
        seen: Set[tuple] = set()
        unique_items: List[ProcedureItem] = []

        for item in items:
            key = item.get_dedupe_key()
            if key in seen:
                continue
            seen.add(key)
            unique_items.append(item)

        duplicates_count = len(items) - len(unique_items)
        summary = BatchSummary(
            year_or_source=source_name,
            total_extracted=len(unique_items),
            duplicates_removed=duplicates_count,
        )

        logger.info(
            f"Pipeline [{source_name}]: [green]{len(unique_items)} items[/green] retained, "
            f"[yellow]{duplicates_count} duplicates pruned[/yellow]."
        )
        return unique_items, summary
