"""
Abstract Base Extractor interface for all file and web sources.
"""

from abc import ABC, abstractmethod
from typing import List, Any
from crawler.models import ProcedureItem


class BaseExtractor(ABC):
    """Abstract interface defining extractor behavior."""

    @abstractmethod
    def extract(self, source: Any) -> List[ProcedureItem]:
        """Extracts and validates a list of ProcedureItems from the source."""
        pass
