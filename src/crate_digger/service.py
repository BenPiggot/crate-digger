"""Core logic shared by the MCP server and the web UI."""

from __future__ import annotations

import asyncio
import re
from typing import Any

from pathlib import Path

from .config import Settings
from .discogs import DiscogsClient
from .ebay import EbayClient
from .inventory import InventoryIndex
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


def discogs_copy(match: dict[str, Any], detail: dict[str, Any] | None = None) -> Copy:
    """Build a Copy from a cached inventory match, enriched with the full listing if available."""
    detail = detail or {}
    seller = detail.get("seller") or {}
    price = detail.get("price") or {}
    ship = detail.get("shipping_price") or {}
    price_value = price.get("value", match.get("price"))
    ship_value = ship.get("value")
    return Copy(
        source="discogs",
        item_id=str(match["listing_id"]),
        title=match.get("description") or "",
        price=float(price_value) if price_value is not None else None,
        currency=price.get("currency") or match.get("currency"),
        shipping_cost=float(ship_value) if ship_value is not None else None,
        shipping_type=None if ship_value is not None else "SELLER_POLICY",
        total=round(float(price_value) + float(ship_value), 2) if price_value is not None and ship_value is not None else None,
        condition=None,
        record_grading=detail.get("condition") or match.get("condition"),
        sleeve_grading=detail.get("sleeve_condition") or match.get("sleeve_condition"),
        ships_from=detail.get("ships_from") or match.get("ships_from"),
        seller=seller.get("username") or match.get("seller"),
        seller_rating=str((seller.get("stats") or {}).get("rating")) if (seller.get("stats") or {}).get("rating") else None,
        shipping_policy=(seller.get("shipping") or None),
        comments=detail.get("comments") or match.get("comments"),
        url=match.get("uri"),
        catno_match=True,  # inventory listings are tied to the exact Discogs release
    )


def _sort_key(c: Copy) -> tuple[bool, float]:
    return (not c.catno_match, c.total if c.total is not None else (c.price if c.price is not None else 1e9))


class CrateDigger:
    def __init__(
        self,
        settings: Settings,
        discogs: DiscogsClient | None = None,
        ebay: EbayClient | None = None,
        inventory: InventoryIndex | None = None,
    ):
        self.settings = settings
        self.discogs = discogs or DiscogsClient(settings.discogs_token, settings.user_agent)
        self.ebay = ebay or EbayClient(
            settings.ebay_client_id,
            settings.ebay_client_secret,
            env=settings.ebay_env,
            marketplace=settings.ebay_marketplace,
        )
        self.inventory = inventory or InventoryIndex(
            self.discogs,
            Path(settings.cache_dir).expanduser(),
            ttl_seconds=settings.inventory_ttl_hours * 3600,
            max_pages=settings.max_inventory_pages,
        )

    async def search_releases(self, query: str, **filters: Any) -> list[dict[str, Any]]:
        return await self.discogs.search(query, **filters)

    async def market_overview(self, release_id: int) -> dict[str, Any]:
        release, stats = await asyncio.gather(
            self.discogs.get_release(release_id),
            self.discogs.get_market_stats(release_id, self.settings.currency),
        )
        return {"release": release.to_dict(), "discogs_market": stats.to_dict()}

    async def _discogs_seller_copies(
        self, release_id: int, sellers: list[str], refresh: bool, with_details: bool, details_limit: int
    ) -> tuple[list[Copy], list[dict[str, Any]]]:
        matches, summaries = await self.inventory.find(release_id, sellers, refresh=refresh)
        copies: list[Copy] = []
        for i, m in enumerate(matches):
            detail = None
            if with_details and i < details_limit:
                try:
                    detail = await self.discogs.get_listing(m["listing_id"], self.settings.currency)
                except Exception:  # sold since the scan, or a transient error: keep the cached data
                    detail = None
            copies.append(discogs_copy(m, detail))
        return copies, summaries

    async def _ebay_copies(
        self, release: Release, max_price: float | None, limit: int, with_details: bool, details_limit: int
    ) -> tuple[list[Copy], str]:
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
        return results, matched_by

    async def find_copies(
        self,
        release_id: int,
        *,
        sellers: list[str] | None = None,
        refresh: bool = False,
        max_price: float | None = None,
        limit: int = 50,
        with_details: bool = True,
        details_limit: int = 20,
    ) -> dict[str, Any]:
        """Every copy of this pressing for sale from the chosen Discogs sellers (and eBay, if configured)."""
        release, stats = await asyncio.gather(
            self.discogs.get_release(release_id),
            self.discogs.get_market_stats(release_id, self.settings.currency),
        )
        sellers = list(sellers) if sellers else list(self.settings.discogs_sellers)

        copies: list[Copy] = []
        seller_summaries: list[dict[str, Any]] = []
        if sellers:
            found, seller_summaries = await self._discogs_seller_copies(
                release_id, sellers, refresh, with_details, details_limit
            )
            copies.extend(found)

        matched_by = None
        if self.ebay.configured:
            found, matched_by = await self._ebay_copies(release, max_price, limit, with_details, details_limit)
            copies.extend(found)

        if max_price is not None:
            copies = [c for c in copies if c.price is None or c.price <= max_price]
        copies.sort(key=_sort_key)

        notes = []
        if sellers:
            notes.append(f"Searched {len(sellers)} Discogs seller inventor{'y' if len(sellers) == 1 else 'ies'}; those copies are this exact pressing.")
        else:
            notes.append("No Discogs sellers chosen. Add seller usernames to search their inventories for this pressing.")
        if not self.ebay.configured:
            notes.append("eBay isn't configured, so eBay listings aren't included.")
        elif matched_by == "keywords":
            notes.append("eBay listings were matched by artist and title and may include other pressings.")

        return {
            "release": release.to_dict(),
            "discogs_market": stats.to_dict(),
            "sellers_searched": seller_summaries,
            "ebay_configured": self.ebay.configured,
            "matched_by": matched_by,
            "count": len(copies),
            "copies": [c.to_dict() for c in copies],
            "note": " ".join(notes),
        }

    async def refresh_sellers(self, sellers: list[str]) -> list[dict[str, Any]]:
        """Rescan seller inventories now (e.g. to warm the cache before searching)."""
        return [(await self.inventory.scan(s, refresh=True)).summary() for s in sellers if s.strip()]

    async def copy_details(self, item_id: str) -> dict[str, Any]:
        if item_id.isdigit():  # Discogs listing ids are numeric; eBay ids look like v1|123|0
            detail = await self.discogs.get_listing(int(item_id), self.settings.currency)
            match = {
                "listing_id": detail.get("id", int(item_id)),
                "description": (detail.get("release") or {}).get("description"),
                "uri": detail.get("uri"),
            }
            return discogs_copy(match, detail).to_dict()
        item = await self.ebay.get_item(item_id)
        copy = EbayClient._summary_to_copy(item)
        await self.ebay.enrich(copy)
        return copy.to_dict()

    async def aclose(self) -> None:
        await asyncio.gather(self.discogs.aclose(), self.ebay.aclose())
