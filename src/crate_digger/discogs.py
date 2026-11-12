"""Discogs client: identify the exact pressing and read aggregate market stats.

Note: the Discogs API does not expose the list of marketplace listings for a
release, which is why per-copy data comes from eBay instead.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncIterator

import httpx

from .models import MarketStats, Release

BASE_URL = "https://api.discogs.com"


class DiscogsError(RuntimeError):
    pass


class DiscogsClient:
    """Async Discogs client that stays under the rate limit.

    Discogs allows 60 requests/minute with a token and 25 without, so requests are
    spaced out by default and 429 responses are retried after a pause.
    """

    def __init__(
        self,
        token: str,
        user_agent: str,
        http: httpx.AsyncClient | None = None,
        min_interval: float | None = None,
        max_retries: int = 3,
    ):
        self._token = token
        self._http = http or httpx.AsyncClient(timeout=20)
        self._headers = {"User-Agent": user_agent}
        if token:
            self._headers["Authorization"] = f"Discogs token={token}"
        self._min_interval = min_interval if min_interval is not None else (1.0 if token else 2.4)
        self._max_retries = max_retries
        self._lock = asyncio.Lock()
        self._last_request = 0.0

    async def _throttle(self) -> None:
        async with self._lock:
            wait = self._last_request + self._min_interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request = time.monotonic()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        for attempt in range(self._max_retries + 1):
            await self._throttle()
            resp = await self._http.get(f"{BASE_URL}{path}", params=params, headers=self._headers)
            if resp.status_code == 429 and attempt < self._max_retries:
                # Back off: Discogs' window is a moving 60 seconds.
                await asyncio.sleep(float(resp.headers.get("Retry-After", 10 * (attempt + 1))))
                continue
            if resp.status_code == 404:
                raise DiscogsError(f"Not found on Discogs: {path}")
            if resp.status_code == 429:
                raise DiscogsError("Discogs rate limit hit; wait a minute and retry.")
            resp.raise_for_status()
            return resp.json()
        raise DiscogsError("Discogs request failed after retries.")  # pragma: no cover

    async def search(
        self,
        query: str = "",
        *,
        artist: str | None = None,
        title: str | None = None,
        catno: str | None = None,
        barcode: str | None = None,
        format: str | None = "Vinyl",
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        """Search the Discogs database for releases. Requires a token."""
        if not self._token:
            raise DiscogsError("Searching Discogs requires DISCOGS_TOKEN to be set.")
        params: dict[str, Any] = {"type": "release", "per_page": limit}
        for key, value in {
            "q": query,
            "artist": artist,
            "release_title": title,
            "catno": catno,
            "barcode": barcode,
            "format": format,
        }.items():
            if value:
                params[key] = value
        data = await self._get("/database/search", params)
        return [
            {
                "release_id": r.get("id"),
                "title": r.get("title"),
                "year": r.get("year"),
                "country": r.get("country"),
                "label": (r.get("label") or [None])[0],
                "catno": r.get("catno"),
                "formats": r.get("format", []),
                "thumb": r.get("thumb"),
            }
            for r in data.get("results", [])
        ]

    async def get_release(self, release_id: int) -> Release:
        r = await self._get(f"/releases/{release_id}")
        labels = r.get("labels") or [{}]
        formats = [
            ", ".join([f.get("name", "")] + f.get("descriptions", []))
            for f in r.get("formats", [])
        ]
        barcodes = [
            "".join(ch for ch in i.get("value", "") if ch.isdigit())
            for i in r.get("identifiers", [])
            if i.get("type") == "Barcode"
        ]
        return Release(
            id=r["id"],
            title=r.get("title", ""),
            artist=", ".join(a.get("name", "") for a in r.get("artists", [])),
            year=r.get("year") or None,
            country=r.get("country"),
            label=labels[0].get("name"),
            catno=labels[0].get("catno"),
            formats=formats,
            barcodes=[b for b in dict.fromkeys(barcodes) if b],
            thumb=r.get("thumb"),
            url=r.get("uri"),
        )

    async def get_market_stats(self, release_id: int, currency: str = "USD") -> MarketStats:
        data = await self._get(f"/marketplace/stats/{release_id}", {"curr_abbr": currency})
        lowest = data.get("lowest_price") or {}
        return MarketStats(
            num_for_sale=data.get("num_for_sale") or 0,
            lowest_price=lowest.get("value"),
            currency=lowest.get("currency"),
        )

    async def iter_inventory(self, username: str, max_pages: int = 100) -> AsyncIterator[dict[str, Any]]:
        """Yield every for-sale listing in a seller's public inventory, 100 per request."""
        page = 1
        while page <= max_pages:
            data = await self._get(
                f"/users/{username}/inventory",
                {"status": "For Sale", "per_page": 100, "page": page, "sort": "listed", "sort_order": "desc"},
            )
            for listing in data.get("listings", []):
                yield listing
            pages = (data.get("pagination") or {}).get("pages", 1)
            if page >= pages:
                return
            page += 1

    async def get_listing(self, listing_id: int, currency: str = "USD") -> dict[str, Any]:
        """One marketplace listing, including the seller's shipping policy."""
        return await self._get(f"/marketplace/listings/{listing_id}", {"curr_abbr": currency})

    async def aclose(self) -> None:
        await self._http.aclose()
