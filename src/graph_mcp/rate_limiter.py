from __future__ import annotations

import asyncio
import time
from collections import deque

from graph_mcp.exceptions import RateLimitError


class RateLimiter:
    def __init__(self, max_requests: int = 10000, window: int = 600):
        self.max_requests = max_requests
        self.window = window
        self._timestamps: deque[float] = deque()
        self._backoff_until: float = 0.0
        self._backoff_count: int = 0

    def _clean_window(self) -> None:
        cutoff = time.monotonic() - self.window
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()

    async def acquire(self) -> None:
        now = time.monotonic()
        if now < self._backoff_until:
            wait = self._backoff_until - now
            await asyncio.sleep(wait)

        self._clean_window()
        if len(self._timestamps) >= self.max_requests:
            raise RateLimitError(
                f"Rate limit exceeded: {self.max_requests} requests "
                f"per {self.window}s window"
            )
        self._timestamps.append(time.monotonic())

    def handle_429(self, retry_after: float | None = None) -> float:
        self._backoff_count += 1
        delay = retry_after or min(2**self._backoff_count, 60)
        self._backoff_until = time.monotonic() + delay
        return delay

    def reset_backoff(self) -> None:
        self._backoff_count = 0
        self._backoff_until = 0.0


_rate_limiter: RateLimiter | None = None


def get_rate_limiter() -> RateLimiter:
    global _rate_limiter
    if _rate_limiter is None:
        from graph_mcp.config import settings

        _rate_limiter = RateLimiter(
            max_requests=settings.graph_rate_limit_max_requests,
            window=settings.graph_rate_limit_window,
        )
    return _rate_limiter
