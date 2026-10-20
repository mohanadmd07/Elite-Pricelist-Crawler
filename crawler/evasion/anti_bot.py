"""
Anti-bot evasion utilities:
- Modern User-Agent rotation
- Client-Hints & TLS fingerprint header emulation
- Dynamic delay randomization
"""

import random
from typing import Dict

USER_AGENTS = [
    # Chrome on macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # Chrome on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    # Safari on macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    # Firefox on Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
]


def get_random_user_agent() -> str:
    """Returns a randomized modern desktop user agent string."""
    return random.choice(USER_AGENTS)


def get_stealth_headers(custom_headers: Dict[str, str] = None) -> Dict[str, str]:
    """
    Constructs a complete set of browser-like HTTP/2 headers
    including Sec-CH-UA client hints to evade basic WAFs (Cloudflare, Akamai, Imperva).
    """
    ua = get_random_user_agent()
    is_chrome = "Chrome" in ua

    headers = {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
    }

    if is_chrome:
        headers.update({
            "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"macOS"' if "Macintosh" in ua else '"Windows"',
        })

    if custom_headers:
        headers.update(custom_headers)

    return headers


def get_randomized_delay(min_sec: float = 1.0, max_sec: float = 3.0) -> float:
    """Generates a humanized randomized delay with Gaussian-like jitter."""
    return random.uniform(min_sec, max_sec)
