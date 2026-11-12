"""Plain data shapes shared by the MCP server and the web UI."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Release:
    """One specific pressing on Discogs."""

    id: int
    title: str
    artist: str
    year: int | None = None
    country: str | None = None
    label: str | None = None
    catno: str | None = None
    formats: list[str] = field(default_factory=list)
    barcodes: list[str] = field(default_factory=list)
    thumb: str | None = None
    url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MarketStats:
    """Discogs' aggregate marketplace numbers for a release."""

    num_for_sale: int
    lowest_price: float | None
    currency: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Copy:
    """One copy of a record for sale (currently: an eBay listing)."""

    source: str
    item_id: str
    title: str
    price: float | None
    currency: str | None
    shipping_cost: float | None  # None means unknown / calculated at checkout
    shipping_type: str | None  # e.g. FIXED, CALCULATED, NOT_SPECIFIED
    total: float | None
    condition: str | None  # eBay's coarse condition, e.g. "Used"
    record_grading: str | None = None  # e.g. "Near Mint (NM or M-)", from item details
    sleeve_grading: str | None = None
    ships_from: str | None = None
    seller: str | None = None
    seller_feedback_pct: str | None = None
    buying_options: list[str] = field(default_factory=list)
    returns: str | None = None
    shipping_policy: str | None = None  # seller's own shipping terms (Discogs)
    seller_rating: str | None = None
    comments: str | None = None
    url: str | None = None
    image: str | None = None
    catno_match: bool = False  # exact pressing: Discogs release match, eBay barcode, or catno in title

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
