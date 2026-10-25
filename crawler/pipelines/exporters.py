"""
Multi-target exporters: JSON, Excel, and CSV with deterministic atomic writes.
"""

import json
import hashlib
from pathlib import Path
from typing import List, Optional
from crawler.models import ProcedureItem
from crawler.utils.logger import logger


class JsonExporter:
    """Exports items to clean, atomic, byte-identical JSON compatible with the frontend application."""

    @staticmethod
    def export(items: List[ProcedureItem], output_path: Path, indent: Optional[int] = 2) -> str:
        """
        Writes items to disk atomically with sorted keys for reproducible builds.
        Returns the SHA-256 hex digest of the written file.
        """
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        temp_path = output_path.with_suffix(".tmp")

        # Deterministic sort order
        sorted_items = sorted(
            items,
            key=lambda x: (
                str(x.sectionName or "").strip().lower(),
                str(x.nameEnglish or "").strip().lower(),
                str(x.nameArabic or "").strip(),
                str(x.price),
            ),
        )

        serialized = [item.model_dump(exclude_none=True, by_alias=True) for item in sorted_items]

        with open(temp_path, "w", encoding="utf-8") as f:
            if indent is not None:
                json.dump(serialized, f, ensure_ascii=False, indent=indent, sort_keys=True)
            else:
                json.dump(serialized, f, ensure_ascii=False, sort_keys=True)
            f.write("\n")

        temp_path.replace(output_path)

        with open(output_path, "rb") as f:
            checksum = hashlib.sha256(f.read()).hexdigest()

        logger.info(
            f"Successfully exported [cyan]{len(items)}[/cyan] records to "
            f"[green]{output_path}[/green] (sha256: {checksum[:12]}...)"
        )
        return checksum
