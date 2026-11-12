"""eBay Browse API client: live listings with price, condition and shipping."""

from __future__ import annotations

import asyncio
import base64
import time
from typing import Any

import httpx

from .models import Copy

VINYL_CATEGORY_ID = "176985"  # eBay US "Vinyl Records"
SCOPE = "https://api.ebay.com/oauth/api_scope"
HOSTS = {"production": "https://api.ebay.com", "sandbox": "https://api.sandbox.ebay.com"}


class EbayError(RuntimeError):
    pass


def _money(obj: dict[str, Any] | None) -> tuple[float | None, str | None]:
    if not obj or obj.get("value") is None:
        return None, None
    return float(obj["value"]), obj.get("currency")


class EbayClient:
    def __init__(
        self,
        client_id: str,
        client_secret: str,
        env: str = "production",
        marketplace: str = "EBAY_US",
        http: httpx.AsyncClient | None = None,
    ):
        if env not in HOSTS:
            raise ValueError(f"EBAY_ENV must be one of {list(HOSTS)}")
        self._id = client_id
        self._secret = client_secret
        self._host = HOSTS[env]
        self._marketplace = marketplace
        self._http = http or httpx.AsyncClient(timeout=20)
        self._token: str | None = None
        self._token_expires = 0.0
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(self._id and self._secret)

    async def _access_token(self) -> str:
        """Application token via the OAuth client-credentials grant, cached until expiry."""
        if not (self._id and self._secret):
            raise EbayError("Set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to search eBay.")
        async with self._lock:
            if self._token and time.time() < self._token_expires - 60:
                return self._token
            basic = base64.b64encode(f"{self._id}:{self._secret}".encode()).decode()
            resp = await self._http.post(
                f"{self._host}/identity/v1/oauth2/token",
                headers={
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={"grant_type": "client_credentials", "scope": SCOPE},
            )
            if resp.status_code != 200:
                raise EbayError(f"eBay auth failed ({resp.status_code}): {resp.text[:200]}")
            body = resp.json()
            self._token = body["access_token"]
            self._token_expires = time.time() + int(body.get("expires_in", 7200))
            return self._token

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        token = await self._access_token()
        resp = await self._http.get(
            f"{self._host}/buy/browse/v1{path}",
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "X-EBAY-C-MARKETPLACE-ID": self._marketplace,
            },
        )
        if resp.status_code >= 400:
            raise EbayError(f"eBay request failed ({resp.status_code}): {resp.text[:200]}")
        return resp.json()

    async def search(
        self,
        *,
        keywords: str | None = None,
        gtin: str | None = None,
        limit: int = 50,
        max_price: float | None = None,
    ) -> list[Copy]:
        """Search vinyl listings by UPC barcode or keywords (eBay won't combine the two)."""
        params: dict[str, Any] = {"category_ids": VINYL_CATEGORY_ID, "limit": min(limit, 200)}
        if gtin:
            params["gtin"] = gtin
        elif keywords:
            params["q"] = keywords
        else:
            raise ValueError("Provide keywords or gtin")
        if max_price is not None:
            params["filter"] = f"price:[..{max_price}],priceCurrency:USD"
        data = await self._get("/item_summary/search", params)
        return [self._summary_to_copy(item) for item in data.get("itemSummaries", [])]

    async def get_item(self, item_id: str) -> dict[str, Any]:
        return await self._get(f"/item/{item_id}")

    async def enrich(self, copy: Copy) -> Copy:
        """Fill in record/sleeve grading, exact shipping and return terms from item details."""
        item = await self.get_item(copy.item_id)
        aspects = {a.get("name", "").lower(): a.get("value") for a in item.get("localizedAspects", [])}
        copy.record_grading = aspects.get("record grading") or aspects.get("vinyl grading")
        copy.sleeve_grading = aspects.get("sleeve grading")
        if item.get("conditionDescription"):
            copy.condition = f"{copy.condition or ''} - {item['conditionDescription']}".strip(" -")
        if item.get("shippingOptions"):
            self._apply_shipping(copy, item["shippingOptions"])
        terms = item.get("returnTerms") or {}
        if terms:
            if terms.get("returnsAccepted"):
                period = terms.get("returnPeriod") or {}
                n, unit = period.get("value"), str(period.get("unit", "DAY")).lower()
                copy.returns = f"Returns accepted, {n} {unit}{'s' if n != 1 else ''}" if n else "Returns accepted"
            else:
                copy.returns = "No returns"
        return copy

    @staticmethod
    def _apply_shipping(copy: Copy, options: list[dict[str, Any]]) -> None:
        opt = options[0]
        copy.shipping_type = opt.get("shippingCostType")
        cost, _ = _money(opt.get("shippingCost"))
        copy.shipping_cost = cost
        copy.total = round(copy.price + cost, 2) if copy.price is not None and cost is not None else None

    @classmethod
    def _summary_to_copy(cls, item: dict[str, Any]) -> Copy:
        price, currency = _money(item.get("price") or item.get("currentBidPrice"))
        seller = item.get("seller") or {}
        location = item.get("itemLocation") or {}
        copy = Copy(
            source="ebay",
            item_id=item.get("itemId", ""),
            title=item.get("title", ""),
            price=price,
            currency=currency,
            shipping_cost=None,
            shipping_type=None,
            total=None,
            condition=item.get("condition"),
            ships_from=location.get("country"),
            seller=seller.get("username"),
            seller_feedback_pct=seller.get("feedbackPercentage"),
            buying_options=item.get("buyingOptions", []),
            url=item.get("itemWebUrl"),
            image=(item.get("image") or {}).get("imageUrl"),
        )
        if item.get("shippingOptions"):
            cls._apply_shipping(copy, item["shippingOptions"])
        return copy

    async def aclose(self) -> None:
        await self._http.aclose()
