"""Search chosen Discogs sellers' inventories for an exact release.

The Discogs API has no "all listings for a release" endpoint, but every seller's
inventory is public. Scanning an inventory costs one request per 100 listings,
so scans are cached on disk and reused until they expire.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .discogs import DiscogsClient, DiscogsError

_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def _compact(listing: dict[str, Any]) -> dict[str, Any]:
    """Keep only the fields we need so cache files stay small."""
    price = listing.get("price") or {}
    release = listing.get("release") or {}
    return {
        "listing_id": listing.get("id"),
        "release_id": release.get("id"),
        "description": release.get("description"),
        "price": price.get("value"),
        "currency": price.get("currency"),
        "condition": listing.get("condition"),
        "sleeve_condition": listing.get("sleeve_condition"),
        "ships_from": listing.get("ships_from"),
        "comments": listing.get("comments"),
        "uri": listing.get("uri"),
    }


@dataclass
class SellerScan:
    seller: str
    listings: list[dict[str, Any]]
    fetched_at: float
    from_cache: bool
    truncated: bool  # hit the page limit before the end of the inventory
    error: str | None = None

    def summary(self) -> dict[str, Any]:
        return {
            "seller": self.seller,
            "listings_scanned": len(self.listings),
            "from_cache": self.from_cache,
            "scanned_minutes_ago": round((time.time() - self.fetched_at) / 60),
            "truncated": self.truncated,
            "error": self.error,
        }


@dataclass
class InventoryIndex:
    discogs: DiscogsClient
    cache_dir: Path
    ttl_seconds: float = 12 * 3600
    max_pages: int = 100
    _memory: dict[str, SellerScan] = field(default_factory=dict)

    def _path(self, seller: str) -> Path:
        return self.cache_dir / f"inventory_{_SAFE.sub('_', seller.lower())}.json"

    def _load(self, seller: str) -> SellerScan | None:
        if seller.lower() in self._memory:
            return self._memory[seller.lower()]
        path = self._path(seller)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text())
            return SellerScan(seller, data["listings"], data["fetched_at"], True, data.get("truncated", False))
        except (OSError, ValueError, KeyError):
            return None  # corrupt cache: just rescan

    def _save(self, scan: SellerScan) -> None:
        self._memory[scan.seller.lower()] = scan
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._path(scan.seller).write_text(
                json.dumps({"fetched_at": scan.fetched_at, "truncated": scan.truncated, "listings": scan.listings})
            )
        except OSError:
            pass  # caching is best-effort

    async def scan(self, seller: str, refresh: bool = False) -> SellerScan:
        cached = None if refresh else self._load(seller)
        if cached and time.time() - cached.fetched_at < self.ttl_seconds:
            cached.from_cache = True
            return cached
        listings: list[dict[str, Any]] = []
        try:
            async for raw in self.discogs.iter_inventory(seller, self.max_pages):
                listings.append(_compact(raw))
        except DiscogsError as e:
            if cached:  # serve stale data rather than nothing
                cached.error = f"Refresh failed, using older scan: {e}"
                return cached
            return SellerScan(seller, [], time.time(), False, False, error=str(e))
        truncated = len(listings) >= self.max_pages * 100
        scan = SellerScan(seller, listings, time.time(), False, truncated)
        self._save(scan)
        return scan

    async def find(self, release_id: int, sellers: list[str], refresh: bool = False) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Listings of this exact release across the given sellers, plus a per-seller scan summary."""
        matches: list[dict[str, Any]] = []
        summaries: list[dict[str, Any]] = []
        # Sequential on purpose: all requests share one rate limit anyway.
        for seller in dict.fromkeys(s.strip() for s in sellers if s.strip()):
            scan = await self.scan(seller, refresh=refresh)
            summaries.append(scan.summary())
            matches.extend({**m, "seller": seller} for m in scan.listings if m.get("release_id") == release_id)
        return matches, summaries
