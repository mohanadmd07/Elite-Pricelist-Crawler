"""
Asynchronous Web Crawler / Spider with anti-bot evasion and dynamic JS rendering.
Fetches online pricelist portals, hospital directories, and medical insurance tables.
"""

import asyncio
from typing import List, Optional, Dict, Any
from bs4 import BeautifulSoup
import httpx

from crawler.config import settings
from crawler.extractors.base import BaseExtractor
from crawler.models import ProcedureItem, CrawlRequest, CrawlResponse
from crawler.normalizers import sanitize_procedure_names, parse_numeric_price, format_price_string, clean_text
from crawler.evasion.anti_bot import get_stealth_headers, get_randomized_delay
from crawler.evasion.proxy_manager import proxy_manager
from crawler.utils.logger import logger
from crawler.utils.retry import retry_with_backoff


class WebPricelistSpider(BaseExtractor):
    """
    High-performance asynchronous crawler with:
    - HTTP/2 & TLS header emulation via httpx
    - Playwright browser automation fallback for JavaScript SPAs
    - Automatic exponential retry on HTTP 429/5xx
    """

    def __init__(self):
        self.semaphore = asyncio.Semaphore(settings.CONCURRENT_REQUESTS)

    @retry_with_backoff(retries=settings.MAX_RETRIES, exceptions=(httpx.HTTPError, asyncio.TimeoutError))
    async def fetch_page_async(self, request: CrawlRequest) -> CrawlResponse:
        """Fetches a URL using async httpx with anti-bot evasion headers."""
        async with self.semaphore:
            delay = get_randomized_delay(settings.DOWNLOAD_DELAY_MIN, settings.DOWNLOAD_DELAY_MAX)
            await asyncio.sleep(delay)

            headers = get_stealth_headers(request.headers)
            proxy = proxy_manager.get_proxy() if settings.USE_PROXY else None

            transport_kwargs = {"verify": settings.VERIFY_SSL, "http2": True}
            if proxy:
                transport_kwargs["proxy"] = proxy

            async with httpx.AsyncClient(**transport_kwargs) as client:
                logger.info(f"Crawling URL: [blue]{request.url}[/blue]")
                response = await client.request(
                    method=request.method,
                    url=request.url,
                    headers=headers,
                    params=request.params,
                    timeout=request.timeout,
                    follow_redirects=True,
                )

                if response.status_code == 429:
                    logger.warning(f"Rate limited (429) on {request.url}")
                    raise httpx.HTTPStatusError("Rate limited", request=response.request, response=response)

                response.raise_for_status()

                return CrawlResponse(
                    url=str(response.url),
                    status_code=response.status_code,
                    html=response.text,
                    headers=dict(response.headers),
                    elapsed_seconds=response.elapsed.total_seconds(),
                )

    async def fetch_dynamic_browser_page(self, request: CrawlRequest) -> CrawlResponse:
        """Renders client-side dynamic pages using Playwright headless browser."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            raise ImportError("Playwright is not installed. Run `pip install playwright && playwright install chromium`.")

        logger.info(f"Rendering JS-heavy page with Playwright: [magenta]{request.url}[/magenta]")
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                user_agent=get_stealth_headers()["User-Agent"],
                viewport={"width": 1920, "height": 1080},
                locale="ar-EG,en-US",
            )
            page = await context.new_page()

            await page.goto(request.url, timeout=request.timeout * 1000, wait_until="networkidle")
            if request.wait_selector:
                await page.wait_for_selector(request.wait_selector, timeout=15000)

            content = await page.content()
            await browser.close()

            return CrawlResponse(
                url=request.url,
                status_code=200,
                html=content,
            )

    def parse_html_table(self, html: str, source_label: str, section_name: str = "Online Portal") -> List[ProcedureItem]:
        """
        Parses standard HTML table structures with bilingual procedure detection.
        Assumes standard table headers with 'name' / 'procedure' and 'price' / 'cost'.
        """
        soup = BeautifulSoup(html, "lxml")
        items: List[ProcedureItem] = []

        tables = soup.find_all("table")
        for table in tables:
            rows = table.find_all("tr")
            if not rows:
                continue

            for tr in rows:
                cols = [clean_text(td.get_text()) for td in tr.find_all(["td", "th"])]
                if len(cols) < 2:
                    continue

                # Locate numeric price in columns
                price = None
                price_idx = None
                for idx in reversed(range(len(cols))):
                    val = parse_numeric_price(cols[idx])
                    if val is not None:
                        price = val
                        price_idx = idx
                        break

                if price is None:
                    continue

                # Collect text parts
                text_cols = [cols[i] for i in range(len(cols)) if i != price_idx]
                if not text_cols:
                    continue

                raw_en = text_cols[0] if len(text_cols) > 0 else ""
                raw_ar = text_cols[1] if len(text_cols) > 1 else ""

                en, ar, outsourced = sanitize_procedure_names(raw_en, raw_ar)
                if not (en or ar):
                    continue

                try:
                    items.append(
                        ProcedureItem(
                            nameEnglish=en,
                            nameArabic=ar,
                            price=format_price_string(price),
                            sectionName=section_name,
                            sourceFile=source_label,
                            outsourced=True if outsourced else None,
                        )
                    )
                except Exception:
                    pass

        return items

    def extract(self, source: Any) -> List[ProcedureItem]:
        """Synchronous wrapper for web extraction."""
        if isinstance(source, CrawlRequest):
            req = source
        elif isinstance(source, str):
            req = CrawlRequest(url=source)
        else:
            raise ValueError("Source must be a URL string or CrawlRequest")

        loop = asyncio.get_event_loop()
        if req.use_browser:
            resp = loop.run_until_complete(self.fetch_dynamic_browser_page(req))
        else:
            resp = loop.run_until_complete(self.fetch_page_async(req))

        return self.parse_html_table(resp.html, source_label=req.url)
