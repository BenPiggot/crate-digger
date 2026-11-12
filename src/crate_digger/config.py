"""Settings loaded from environment variables (or a local .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path = Path(".env")) -> None:
    """Minimal .env loader so the project has no extra dependency for it."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class Settings:
    discogs_token: str
    ebay_client_id: str
    ebay_client_secret: str
    ebay_env: str = "production"  # or "sandbox"
    ebay_marketplace: str = "EBAY_US"
    currency: str = "USD"
    user_agent: str = "crate-digger/0.1 +https://github.com/BenPiggot/crate-digger"
    discogs_sellers: tuple[str, ...] = ()  # default sellers to search, e.g. favorite record stores
    cache_dir: str = "~/.cache/crate-digger"
    inventory_ttl_hours: float = 12
    max_inventory_pages: int = 100  # 100 listings per page

    @classmethod
    def from_env(cls) -> "Settings":
        _load_dotenv()
        return cls(
            discogs_token=os.environ.get("DISCOGS_TOKEN", ""),
            ebay_client_id=os.environ.get("EBAY_CLIENT_ID", ""),
            ebay_client_secret=os.environ.get("EBAY_CLIENT_SECRET", ""),
            ebay_env=os.environ.get("EBAY_ENV", "production"),
            ebay_marketplace=os.environ.get("EBAY_MARKETPLACE", "EBAY_US"),
            currency=os.environ.get("CURRENCY", "USD"),
            user_agent=os.environ.get("USER_AGENT", cls.user_agent),
            discogs_sellers=tuple(
                s.strip() for s in os.environ.get("DISCOGS_SELLERS", "").split(",") if s.strip()
            ),
            cache_dir=os.environ.get("CACHE_DIR", cls.cache_dir),
            inventory_ttl_hours=float(os.environ.get("INVENTORY_TTL_HOURS", cls.inventory_ttl_hours)),
            max_inventory_pages=int(os.environ.get("MAX_INVENTORY_PAGES", cls.max_inventory_pages)),
        )
