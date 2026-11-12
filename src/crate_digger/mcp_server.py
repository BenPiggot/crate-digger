"""MCP server exposing crate-digger as tools an LLM can call.

Run with:  crate-digger-mcp   (stdio transport, for Claude Desktop / Claude Code / any MCP client)
"""

from __future__ import annotations

from typing import Any, Awaitable, TypeVar

import httpx
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

from .config import Settings
from .discogs import DiscogsError
from .ebay import EbayError
from .service import CrateDigger

T = TypeVar("T")

mcp = MCPServer(
    "crate-digger",
    instructions=(
        "Find copies of a specific vinyl record for sale. First call search_releases to find "
        "the Discogs release_id of the exact pressing, then call find_copies with that id. "
        "find_copies searches the inventories of chosen Discogs sellers (pass `sellers`, or use "
        "the configured defaults) and eBay when it is configured. The first scan of a large "
        "store can take a few minutes; later searches use a cache."
    ),
)
_digger: CrateDigger | None = None


async def _call(coro: Awaitable[T]) -> T:
    """Turn expected failures into ToolErrors so the model sees a useful message."""
    try:
        return await coro
    except (DiscogsError, EbayError, ValueError) as e:
        raise ToolError(str(e)) from e
    except httpx.HTTPError as e:
        raise ToolError(f"Upstream request failed: {e}") from e


def digger() -> CrateDigger:
    global _digger
    if _digger is None:
        _digger = CrateDigger(Settings.from_env())
    return _digger


@mcp.tool()
async def search_releases(
    query: str = "",
    artist: str | None = None,
    title: str | None = None,
    catno: str | None = None,
    barcode: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Search Discogs for vinyl releases (specific pressings).

    Returns candidates with release_id, title, year, country, label and catalog number.
    Use catno or barcode to pin down an exact pressing.
    """
    return await _call(digger().search_releases(
        query, artist=artist, title=title, catno=catno, barcode=barcode, limit=limit
    ))


@mcp.tool()
async def get_market_overview(release_id: int) -> dict[str, Any]:
    """Release details plus Discogs' aggregate marketplace stats (copies for sale, lowest price)."""
    return await _call(digger().market_overview(release_id))


@mcp.tool()
async def find_copies(
    release_id: int,
    sellers: list[str] | None = None,
    max_price: float | None = None,
    refresh: bool = False,
    limit: int = 50,
    with_details: bool = True,
) -> dict[str, Any]:
    """List copies of a Discogs release for sale, with price, condition and shipping terms.

    Sources: the public inventories of the given Discogs `sellers` (usernames, e.g. record
    stores; defaults to the configured list), plus eBay if configured. Discogs copies are
    always the exact pressing and include media and sleeve grading, ships-from country,
    seller rating, the seller's shipping policy and a link. Set refresh=true to rescan
    inventories instead of using the cache. Exact matches are listed first, cheapest first.
    """
    return await _call(digger().find_copies(
        release_id, sellers=sellers, max_price=max_price, refresh=refresh, limit=limit, with_details=with_details
    ))


@mcp.tool()
async def refresh_seller_inventories(sellers: list[str]) -> list[dict[str, Any]]:
    """Rescan Discogs sellers' inventories now and cache them. Returns listings scanned per seller."""
    return await _call(digger().refresh_sellers(sellers))


@mcp.tool()
async def get_copy_details(item_id: str) -> dict[str, Any]:
    """Full details for one listing: a numeric Discogs listing id or an eBay item id."""
    return await _call(digger().copy_details(item_id))


def main() -> None:
    mcp.run("stdio")


if __name__ == "__main__":
    main()
