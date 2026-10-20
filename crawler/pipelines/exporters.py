"""
Multi-target exporters: JSON, Excel, and CSV with atomic writes.
"""

import json
from pathlib import Path
from typing import List
from crawler.models import ProcedureItem
from crawler.utils.logger import logger


class JsonExporter:
    """Exports items to clean, atomic JSON compatible with the frontend application."""

    @staticmethod
    def export(items: List[ProcedureItem], output_path: Path, indent: int = None) -> None:
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        temp_path = output_path.with_suffix(".tmp")
        # Dump using Pydantic model serialization, excluding None fields like code or outsourced if absent
        serialized = [item.model_dump(exclude_none=True, by_alias=True) for item in items]

        with open(temp_path, "w", encoding="utf-8") as f:
            if indent:
                json.dump(serialized, f, ensure_ascii=False, indent=indent)
            else:
                json.dump(serialized, f, ensure_ascii=False)

        temp_path.replace(output_path)
        logger.info(f"Successfully exported [cyan]{len(items)}[/cyan] records to [green]{output_path}[/green]")
