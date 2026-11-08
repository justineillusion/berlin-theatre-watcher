"""Petit client HTTP partagé (UA navigateur, retries légers, politesse)."""
from __future__ import annotations

import time
from typing import Any, Optional

import httpx

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

_client: Optional[httpx.Client] = None


def client() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(
            follow_redirects=True,
            timeout=30.0,
            headers={"User-Agent": _UA, "Accept-Language": "de,en;q=0.8,fr;q=0.6"},
        )
    return _client


def get_text(url: str, retries: int = 2) -> str:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = client().get(url)
            resp.raise_for_status()
            return resp.text
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code < 500:
                raise
            last = exc
        except httpx.RequestError as exc:
            last = exc
        time.sleep(1.5 * (attempt + 1))
    raise last  # type: ignore[misc]


def post_json(url: str, payload: dict, headers: Optional[dict] = None, retries: int = 2) -> Any:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            resp = client().post(url, json=payload, headers=headers or {})
            if resp.status_code >= 500:
                raise httpx.HTTPStatusError("5xx", request=resp.request, response=resp)
            return resp.json()
        except (httpx.HTTPStatusError, httpx.RequestError, ValueError) as exc:
            last = exc
        time.sleep(1.5 * (attempt + 1))
    raise last  # type: ignore[misc]
