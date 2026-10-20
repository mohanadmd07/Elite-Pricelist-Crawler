"""
Retry utility providing exponential backoff with full jitter.
"""

import asyncio
import functools
import random
import time
from typing import Callable, Any, Type, Tuple
from crawler.utils.logger import logger


def retry_with_backoff(
    retries: int = 4,
    initial_delay: float = 1.0,
    backoff_factor: float = 2.0,
    max_delay: float = 30.0,
    exceptions: Tuple[Type[Exception], ...] = (Exception,)
):
    """
    Decorator for retrying functions with exponential backoff and jitter.
    Works seamlessly on both synchronous and asynchronous functions.
    """
    def decorator(func: Callable) -> Callable:
        if asyncio.iscoroutinefunction(func):
            @functools.wraps(func)
            async def async_wrapper(*args, **kwargs) -> Any:
                attempt = 0
                delay = initial_delay
                while True:
                    try:
                        return await func(*args, **kwargs)
                    except exceptions as err:
                        attempt += 1
                        if attempt > retries:
                            logger.error(f"[bold red]Retry limit reached ({retries}) for {func.__name__}: {err}[/bold red]")
                            raise err
                        
                        # Add jitter: random sleep between 0.5 * delay and 1.5 * delay
                        jittered_delay = min(delay * random.uniform(0.7, 1.3), max_delay)
                        logger.warning(
                            f"[yellow]Attempt {attempt}/{retries} failed for {func.__name__} ({err}). "
                            f"Retrying in {jittered_delay:.2f}s...[/yellow]"
                        )
                        await asyncio.sleep(jittered_delay)
                        delay *= backoff_factor
            return async_wrapper
        else:
            @functools.wraps(func)
            def sync_wrapper(*args, **kwargs) -> Any:
                attempt = 0
                delay = initial_delay
                while True:
                    try:
                        return func(*args, **kwargs)
                    except exceptions as err:
                        attempt += 1
                        if attempt > retries:
                            logger.error(f"[bold red]Retry limit reached ({retries}) for {func.__name__}: {err}[/bold red]")
                            raise err
                        
                        jittered_delay = min(delay * random.uniform(0.7, 1.3), max_delay)
                        logger.warning(
                            f"[yellow]Attempt {attempt}/{retries} failed for {func.__name__} ({err}). "
                            f"Retrying in {jittered_delay:.2f}s...[/yellow]"
                        )
                        time.sleep(jittered_delay)
                        delay *= backoff_factor
            return sync_wrapper

    return decorator
