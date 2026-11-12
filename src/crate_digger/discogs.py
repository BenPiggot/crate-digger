"""Discogs client: identify the exact pressing and read aggregate market stats.

Note: the Discogs API does not expose the list of marketplace listings for a
release, which is why per-copy data comes from eBay instead.
"""

from __future__ import annotations

from typing import Any

import httpx

from .models import MarketStats, Release

BASE_URL = "https://api.discogs.com"


class DiscogsError(RuntimeError):
    pass


class DiscogsClient:
    def __init__(self, token: str, user_agent: str, http: httpx.AsyncClient | None = None):
        self._token = token
        self._http = http or httpx.AsyncClient(timeout=20)
        self._headers = {"User-Agent": user_agent}
        if token:
            self._headers["Authorization"] = f"Discogs token={token}"

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        resp = await self._http.get(f"{BASE_URL}{path}", params=params, headers=self._headers)
        if resp.status_code == 404:
            raise DiscogsError(f"Not found on Discogs: {path}")
        if resp.status_code == 429:
            raise DiscogsError("Discogs rate limit hit; wait a minute and retry.")
        resp.raise_for_status()
        return resp.json()

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

    async def aclose(self) -> None:
        await self._http.aclose()
