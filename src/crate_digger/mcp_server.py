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
        "the Discogs release_id of the exact pressing, then call find_copies with that id."
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
    max_price: float | None = None,
    limit: int = 50,
    with_details: bool = True,
) -> dict[str, Any]:
    """List every copy of a Discogs release currently for sale on eBay.

    Each copy includes price, shipping cost and type, total, condition, record and
    sleeve grading (when the seller provided it), ships-from country, seller, return
    terms and a link. Exact matches (barcode or catalog number) are listed first.
    """
    return await _call(digger().find_copies(
        release_id, max_price=max_price, limit=limit, with_details=with_details
    ))


@mcp.tool()
async def get_copy_details(item_id: str) -> dict[str, Any]:
    """Full details for one eBay listing: grading, shipping and return terms."""
    return await _call(digger().copy_details(item_id))


def main() -> None:
    mcp.run("stdio")


if __name__ == "__main__":
    main()
