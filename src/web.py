"""Small web UI + JSON API over the same core as the MCP server.

Run with:  crate-digger-web   then open http://127.0.0.1:8000
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from .crate_digger.config import Settings
from .crate_digger.discogs import DiscogsError
from .crate_digger.ebay import EbayError
from .crate_digger.service import CrateDigger

STATIC = Path(__file__).parent / "static"


def create_app(digger: CrateDigger | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.digger = digger or CrateDigger(Settings.from_env())
        yield
        await app.state.digger.aclose()

    app = FastAPI(title="crate-digger", lifespan=lifespan)

    async def run(coro):
        try:
            return await coro
        except (DiscogsError, EbayError, ValueError) as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    @app.get("/api/releases")
    async def releases(q: str = "", catno: str | None = None, barcode: str | None = None):
        return await run(app.state.digger.search_releases(q, catno=catno, barcode=barcode))

    @app.get("/api/config")
    async def config():
        d = app.state.digger
        return {"default_sellers": list(d.settings.discogs_sellers), "ebay_configured": d.ebay.configured}

    @app.get("/api/releases/{release_id}/copies")
    async def copies(
        release_id: int,
        sellers: str | None = None,
        max_price: float | None = None,
        refresh: bool = False,
        with_details: bool = True,
    ):
        seller_list = [s.strip() for s in sellers.split(",") if s.strip()] if sellers else None
        return await run(
            app.state.digger.find_copies(
                release_id, sellers=seller_list, max_price=max_price, refresh=refresh, with_details=with_details
            )
        )

    return app


def main() -> None:
    import uvicorn

    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))


if __name__ == "__main__":
    main()
