"""Tests run fully offline: every Discogs and eBay call is mocked with respx."""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from crate_digger.config import Settings
from crate_digger.discogs import DiscogsClient
from crate_digger.service import CrateDigger, catno_in_title, keywords_for
from crate_digger.models import Release
from crate_digger.web import create_app

D = "https://api.discogs.com"
E = "https://api.ebay.com"

RELEASE = {
    "id": 123,
    "title": "OK Computer",
    "artists": [{"name": "Radiohead"}],
    "year": 1997,
    "country": "UK",
    "labels": [{"name": "Parlophone", "catno": "NODATA 02"}],
    "formats": [{"name": "Vinyl", "descriptions": ["LP", "Album"]}],
    "identifiers": [{"type": "Barcode", "value": "7 24385 52291 1"}],
    "uri": "https://www.discogs.com/release/123",
}
STATS = {"num_for_sale": 42, "lowest_price": {"value": 55.0, "currency": "USD"}}


def summary(item_id, title, price, ship):
    return {
        "itemId": item_id,
        "title": title,
        "price": {"value": str(price), "currency": "USD"},
        "condition": "Used",
        "shippingOptions": [{"shippingCostType": "FIXED", "shippingCost": {"value": str(ship), "currency": "USD"}}],
        "itemLocation": {"country": "US"},
        "seller": {"username": "vinylshop", "feedbackPercentage": "99.8"},
        "buyingOptions": ["FIXED_PRICE"],
        "itemWebUrl": f"https://www.ebay.com/itm/{item_id}",
    }


ITEM_DETAIL = {
    "localizedAspects": [
        {"name": "Record Grading", "value": "Near Mint (NM or M-)"},
        {"name": "Sleeve Grading", "value": "Very Good Plus (VG+)"},
    ],
    "shippingOptions": [{"shippingCostType": "FIXED", "shippingCost": {"value": "5.00", "currency": "USD"}}],
    "returnTerms": {"returnsAccepted": True, "returnPeriod": {"value": 30, "unit": "DAY"}},
}


@pytest.fixture
def settings(tmp_path):
    return Settings(discogs_token="t", ebay_client_id="id", ebay_client_secret="secret", cache_dir=str(tmp_path))


def make(settings: Settings) -> CrateDigger:
    """CrateDigger with the rate limiter off so tests run fast."""
    return CrateDigger(settings, discogs=DiscogsClient(settings.discogs_token, "test", min_interval=0))


def mock_common(router):
    router.get(f"{D}/releases/123").respond(json=RELEASE)
    router.get(f"{D}/marketplace/stats/123").respond(json=STATS)
    router.post(f"{E}/identity/v1/oauth2/token").respond(json={"access_token": "tok", "expires_in": 7200})


def test_catno_matching():
    assert catno_in_title("NODATA 02", "Radiohead OK Computer LP NODATA02 1997")
    assert catno_in_title("7243 8 55229 1 1", "OK Computer 7243-8-55229-1-1 vinyl")
    assert not catno_in_title("NODATA 02", "Radiohead OK Computer 2016 reissue")
    assert not catno_in_title("none", "anything")


def test_keywords_strip_discogs_disambiguation():
    r = Release(id=1, title="Blue", artist="Joni Mitchell (2)")
    assert keywords_for(r) == "Joni Mitchell Blue"


@respx.mock
async def test_find_copies_by_barcode_sorted_and_enriched(settings):
    mock_common(respx)
    search = respx.get(f"{E}/buy/browse/v1/item_summary/search").respond(
        json={"itemSummaries": [summary("v1|A|0", "OK Computer LP", 80, 5), summary("v1|B|0", "OK Computer", 60, 4)]}
    )
    respx.get(url__regex=rf"{E}/buy/browse/v1/item/.*").respond(json=ITEM_DETAIL)

    digger = make(settings)
    out = await digger.find_copies(123)

    assert search.calls[0].request.url.params["gtin"] == "724385522911"
    assert out["matched_by"] == "barcode"
    assert out["discogs_market"]["num_for_sale"] == 42
    first = out["copies"][0]
    assert first["price"] == 60 and first["total"] == 65.0  # detail shipping (5.00) overrides summary
    assert first["record_grading"] == "Near Mint (NM or M-)"
    assert first["sleeve_grading"] == "Very Good Plus (VG+)"
    assert first["returns"] == "Returns accepted, 30 days"
    await digger.aclose()


@respx.mock
async def test_falls_back_to_keywords_and_flags_catno(settings):
    mock_common(respx)

    def handler(request):
        if "gtin" in request.url.params:
            return httpx.Response(200, json={"total": 0})
        return httpx.Response(200, json={"itemSummaries": [
            summary("x", "Radiohead OK Computer 2016 reissue", 20, 4),
            summary("y", "Radiohead OK Computer NODATA 02 original", 150, 6),
        ]})

    respx.get(f"{E}/buy/browse/v1/item_summary/search").mock(side_effect=handler)
    digger = make(settings)
    out = await digger.find_copies(123, with_details=False)

    assert out["matched_by"] == "keywords"
    assert [c["item_id"] for c in out["copies"]] == ["y", "x"]  # exact pressing first despite price
    assert out["copies"][0]["catno_match"] is True
    await digger.aclose()


@respx.mock
def test_web_api(settings):
    mock_common(respx)
    respx.get(f"{D}/database/search").respond(json={"results": [
        {"id": 123, "title": "Radiohead - OK Computer", "year": "1997", "label": ["Parlophone"], "catno": "NODATA 02"}
    ]})
    respx.get(f"{E}/buy/browse/v1/item_summary/search").respond(json={"itemSummaries": []})

    with TestClient(create_app(make(settings))) as client:
        assert "crate-digger" in client.get("/").text
        rels = client.get("/api/releases", params={"q": "ok computer"}).json()
        assert rels[0]["release_id"] == 123
        copies = client.get("/api/releases/123/copies").json()
        assert copies["count"] == 0


def test_missing_credentials_give_clear_error():
    app = create_app(make(Settings(discogs_token="", ebay_client_id="", ebay_client_secret="")))
    with TestClient(app) as client:
        r = client.get("/api/releases", params={"q": "x"})
        assert r.status_code == 400 and "DISCOGS_TOKEN" in r.json()["detail"]


@respx.mock
async def test_works_with_only_discogs_token():
    respx.get(f"{D}/releases/123").respond(json=RELEASE)
    respx.get(f"{D}/marketplace/stats/123").respond(json=STATS)
    digger = make(Settings(discogs_token="t", ebay_client_id="", ebay_client_secret=""))
    out = await digger.find_copies(123)
    assert out["ebay_configured"] is False
    assert out["discogs_market"]["num_for_sale"] == 42 and out["copies"] == []
    await digger.aclose()


# ---------- Discogs seller inventories ----------

def inv_listing(listing_id, release_id, price, cond="Very Good Plus (VG+)", sleeve="Very Good (VG)"):
    return {
        "id": listing_id,
        "price": {"value": price, "currency": "USD"},
        "condition": cond,
        "sleeve_condition": sleeve,
        "ships_from": "United States",
        "comments": "",
        "uri": f"https://www.discogs.com/sell/item/{listing_id}",
        "release": {"id": release_id, "description": "Radiohead - OK Computer (2xLP, Album)"},
    }


def mock_inventory(router, seller="recordstore"):
    page1 = {"pagination": {"page": 1, "pages": 2}, "listings": [inv_listing(1, 123, 120.0), inv_listing(2, 999, 10.0)]}
    page2 = {"pagination": {"page": 2, "pages": 2}, "listings": [inv_listing(3, 123, 95.0, "Near Mint (NM or M-)")]}

    def handler(request):
        return httpx.Response(200, json=page2 if request.url.params["page"] == "2" else page1)

    return router.get(f"{D}/users/{seller}/inventory").mock(side_effect=handler)


def mock_listing_details(router):
    def handler(request):
        listing_id = int(request.url.path.rsplit("/", 1)[1])
        price, cond = {1: (120.0, "Very Good Plus (VG+)"), 3: (95.0, "Near Mint (NM or M-)")}[listing_id]
        detail = inv_listing(listing_id, 123, price, cond)
        detail["seller"] = {"username": "recordstore", "stats": {"rating": "99.6"}, "shipping": "US Media Mail $5, ships in 2 days"}
        return httpx.Response(200, json=detail)

    return router.get(url__regex=rf"{D}/marketplace/listings/\d+").mock(side_effect=handler)


@respx.mock
async def test_seller_inventory_finds_exact_pressing_with_shipping_policy(tmp_path):
    respx.get(f"{D}/releases/123").respond(json=RELEASE)
    respx.get(f"{D}/marketplace/stats/123").respond(json=STATS)
    mock_inventory(respx)
    mock_listing_details(respx)
    digger = make(Settings(discogs_token="t", ebay_client_id="", ebay_client_secret="", cache_dir=str(tmp_path)))

    out = await digger.find_copies(123, sellers=["recordstore"])

    assert [c["item_id"] for c in out["copies"]] == ["3", "1"]  # other release (999) excluded, cheapest first
    best = out["copies"][0]
    assert best["source"] == "discogs" and best["catno_match"] is True
    assert best["record_grading"] == "Near Mint (NM or M-)" and best["sleeve_grading"] == "Very Good (VG)"
    assert best["shipping_policy"] == "US Media Mail $5, ships in 2 days"
    assert best["seller_rating"] == "99.6" and best["ships_from"] == "United States"
    assert out["sellers_searched"][0]["listings_scanned"] == 3
    assert out["sellers_searched"][0]["from_cache"] is False
    await digger.aclose()


@respx.mock
async def test_inventory_is_cached_between_searches(tmp_path):
    respx.get(f"{D}/releases/123").respond(json=RELEASE)
    respx.get(f"{D}/marketplace/stats/123").respond(json=STATS)
    inventory = mock_inventory(respx)
    settings = Settings(discogs_token="t", ebay_client_id="", ebay_client_secret="", cache_dir=str(tmp_path))

    first = make(settings)
    await first.find_copies(123, sellers=["recordstore"], with_details=False)
    assert inventory.call_count == 2  # two pages
    await first.aclose()

    second = make(settings)  # new process: reads the on-disk cache
    out = await second.find_copies(123, sellers=["recordstore"], with_details=False)
    assert inventory.call_count == 2
    assert out["sellers_searched"][0]["from_cache"] is True and out["count"] == 2

    await second.find_copies(123, sellers=["recordstore"], refresh=True, with_details=False)
    assert inventory.call_count == 4
    await second.aclose()


@respx.mock
async def test_unknown_seller_is_reported_not_fatal(tmp_path):
    respx.get(f"{D}/releases/123").respond(json=RELEASE)
    respx.get(f"{D}/marketplace/stats/123").respond(json=STATS)
    respx.get(f"{D}/users/nobody/inventory").respond(404, json={"message": "User does not exist."})
    mock_inventory(respx)
    digger = make(Settings(discogs_token="t", ebay_client_id="", ebay_client_secret="", cache_dir=str(tmp_path)))

    out = await digger.find_copies(123, sellers=["nobody", "recordstore"], with_details=False)
    assert "Not found" in out["sellers_searched"][0]["error"]
    assert out["count"] == 2
    await digger.aclose()


@respx.mock
async def test_rate_limit_is_retried():
    calls = respx.get(f"{D}/releases/123").mock(side_effect=[
        httpx.Response(429, headers={"Retry-After": "0"}),
        httpx.Response(200, json=RELEASE),
    ])
    client = DiscogsClient("t", "test", min_interval=0)
    release = await client.get_release(123)
    assert release.catno == "NODATA 02" and calls.call_count == 2
    await client.aclose()


@respx.mock
def test_web_passes_sellers_and_exposes_config(tmp_path):
    respx.get(f"{D}/releases/123").respond(json=RELEASE)
    respx.get(f"{D}/marketplace/stats/123").respond(json=STATS)
    mock_inventory(respx, seller="shop_a")
    settings = Settings(discogs_token="t", ebay_client_id="", ebay_client_secret="",
                        cache_dir=str(tmp_path), discogs_sellers=("shop_a",))
    with TestClient(create_app(make(settings))) as client:
        assert client.get("/api/config").json() == {"default_sellers": ["shop_a"], "ebay_configured": False}
        out = client.get("/api/releases/123/copies", params={"with_details": "false"}).json()
        assert out["count"] == 2 and out["sellers_searched"][0]["seller"] == "shop_a"
