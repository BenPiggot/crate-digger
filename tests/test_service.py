"""Tests run fully offline: every Discogs and eBay call is mocked with respx."""

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from crate_digger.config import Settings
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
def settings():
    return Settings(discogs_token="t", ebay_client_id="id", ebay_client_secret="secret")


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

    digger = CrateDigger(settings)
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
    digger = CrateDigger(settings)
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

    with TestClient(create_app(CrateDigger(settings))) as client:
        assert "crate-digger" in client.get("/").text
        rels = client.get("/api/releases", params={"q": "ok computer"}).json()
        assert rels[0]["release_id"] == 123
        copies = client.get("/api/releases/123/copies").json()
        assert copies["count"] == 0


def test_missing_credentials_give_clear_error():
    app = create_app(CrateDigger(Settings(discogs_token="", ebay_client_id="", ebay_client_secret="")))
    with TestClient(app) as client:
        r = client.get("/api/releases", params={"q": "x"})
        assert r.status_code == 400 and "DISCOGS_TOKEN" in r.json()["detail"]
