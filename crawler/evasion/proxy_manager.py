"""
Proxy management: pool rotation and cooldowns for dead/banned proxies.
"""

import itertools
from typing import List, Optional
from crawler.config import settings
from crawler.utils.logger import logger


class ProxyManager:
    """Manages an active pool of HTTP/HTTPS/SOCKS5 proxies."""

    def __init__(self, proxies: Optional[List[str]] = None):
        self._proxies = proxies if proxies is not None else settings.PROXIES
        self._cycle = itertools.cycle(self._proxies) if self._proxies else None
        self._failed_counts = {p: 0 for p in self._proxies}

    @property
    def has_proxies(self) -> bool:
        return bool(self._proxies)

    def get_proxy(self) -> Optional[str]:
        """Returns the next rotating proxy in the pool."""
        if not self._cycle:
            return None
        return next(self._cycle)

    def mark_failure(self, proxy: str):
        """Records a connection failure against a proxy."""
        if proxy in self._failed_counts:
            self._failed_counts[proxy] += 1
            logger.warning(f"Proxy failure recorded: {proxy} (fails: {self._failed_counts[proxy]})")


proxy_manager = ProxyManager()
