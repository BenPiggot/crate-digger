"""Core logic shared by the MCP server and the web UI."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from .config import Settings
from .discogs import DiscogsClient
from .ebay import EbayClient
from .models import Copy, Release


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def catno_in_title(catno: str | None, title: str) -> bool:
    """True if the catalog number (ignoring spaces/dashes/case) appears in the title."""
    if not catno or catno.lower() == "none":
        return False
    return _norm(catno) in _norm(title)


def keywords_for(release: Release) -> str:
    # Discogs appends "(2)" etc. to disambiguate artist names; eBay sellers don't.
    artist = re.sub(r"\s*\(\d+\)", "", release.artist)
    return f"{artist} {release.title}".strip()


class CrateDigger:
    def __init__(self, settings: Settings, discogs: DiscogsClient | None = None, ebay: EbayClient | None = None):
        self.settings = settings
        self.discogs = discogs or DiscogsClient(settings.discogs_token, settings.user_agent)
        self.ebay = ebay or EbayClient(
            settings.ebay_client_id,
            settings.ebay_client_secret,
            env=settings.ebay_env,
            marketplace=settings.ebay_marketplace,
        )

    async def search_releases(self, query: str, **filters: Any) -> list[dict[str, Any]]:
        return await self.discogs.search(query, **filters)

    async def market_overview(self, release_id: int) -> dict[str, Any]:
        release, stats = await asyncio.gather(
            self.discogs.get_release(release_id),
            self.discogs.get_market_stats(release_id, self.settings.currency),
        )
        return {"release": release.to_dict(), "discogs_market": stats.to_dict()}

    async def find_copies(
        self,
        release_id: int,
        *,
        max_price: float | None = None,
        limit: int = 50,
        with_details: bool = True,
        details_limit: int = 20,
    ) -> dict[str, Any]:
        """Every copy of this pressing for sale on eBay, cheapest exact matches first."""
        release, stats = await asyncio.gather(
            self.discogs.get_release(release_id),
            self.discogs.get_market_stats(release_id, self.settings.currency),
        )

        copies: dict[str, Copy] = {}
        matched_by = "keywords"
        # 1) Barcode search is the most precise. eBay only supports UPC (12 digits).
        for upc in (b for b in release.barcodes if len(b) == 12):
            for c in await self.ebay.search(gtin=upc, limit=limit, max_price=max_price):
                copies.setdefault(c.item_id, c)
        if copies:
            matched_by = "barcode"
        # 2) Fall back to artist + title keywords (common for older records without barcodes).
        else:
            for c in await self.ebay.search(keywords=keywords_for(release), limit=limit, max_price=max_price):
                copies.setdefault(c.item_id, c)

        results = list(copies.values())
        for c in results:
            c.catno_match = matched_by == "barcode" or catno_in_title(release.catno, c.title)

        if with_details and results:
            sem = asyncio.Semaphore(5)

            async def enrich(c: Copy) -> None:
                async with sem:
                    try:
                        await self.ebay.enrich(c)
                    except Exception:  # one bad listing shouldn't sink the whole search
                        pass

            await asyncio.gather(*(enrich(c) for c in results[:details_limit]))

        results.sort(key=lambda c: (not c.catno_match, c.total if c.total is not None else (c.price or 1e9)))
        return {
            "release": release.to_dict(),
            "discogs_market": stats.to_dict(),
            "matched_by": matched_by,
            "count": len(results),
            "copies": [c.to_dict() for c in results],
            "note": (
                "Listings matched by keywords may include other pressings; "
                "catno_match=true means the listing title mentions this pressing's catalog number."
                if matched_by == "keywords"
                else "Listings matched by the pressing's UPC barcode."
            ),
        }

    async def copy_details(self, item_id: str) -> dict[str, Any]:
        item = await self.ebay.get_item(item_id)
        copy = EbayClient._summary_to_copy(item)
        await self.ebay.enrich(copy)
        return copy.to_dict()

    async def aclose(self) -> None:
        await asyncio.gather(self.discogs.aclose(), self.ebay.aclose())
