/** Tests run fully offline: every Discogs call goes through a mocked fetch. */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSettings, parseSellers, type Settings } from "../src/core/config.js";
import { DiscogsClient, DiscogsError } from "../src/core/discogs.js";
import type { ListingSource } from "../src/core/listing-source.js";
import { emptyCopy } from "../src/core/models.js";
import { CrateDigger, InvalidInputError, catnoInTitle, keywordsFor } from "../src/core/service.js";
import { json, mockFetch } from "./helpers/mock-fetch.js";

const RELEASE = {
    id: 123,
    title: "OK Computer",
    artists: [{ name: "Radiohead" }],
    year: 1997,
    country: "UK",
    labels: [{ name: "Parlophone", catno: "NODATA 02" }],
    formats: [{ name: "Vinyl", descriptions: ["LP", "Album"] }],
    identifiers: [{ type: "Barcode", value: "7 24385 52291 1" }],
    uri: "https://www.discogs.com/release/123",
};
const STATS = { num_for_sale: 42, lowest_price: { value: 55.0, currency: "USD" } };

let cacheDir: string;
beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "crate-digger-test-"));
});
afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
});

/** Mocked fetch with the release and stats routes every find_copies call needs. */
function setup() {
    const http = mockFetch();
    http.on("/releases/123", RELEASE);
    http.on("/marketplace/stats/123", STATS);
    return http;
}

/** CrateDigger with the rate limiter off so tests run fast. */
function make(http: ReturnType<typeof mockFetch>, overrides: Partial<Settings> = {}) {
    const settings = makeSettings({ discogsToken: "t", cacheDir, ...overrides });
    const discogs = new DiscogsClient(settings.discogsToken, "test", {
        fetch: http.fetch,
        minIntervalMs: 0,
    });
    return new CrateDigger(settings, { discogs });
}

function version(id: number, country: string, released: string, formats: string[], inCollection: number) {
    return {
        id,
        country,
        released,
        major_formats: formats,
        format: formats.join(", "),
        label: "Parlophone",
        catno: `CAT-${id}`,
        stats: { community: { in_collection: inCollection } },
    };
}



function invListing(
    listingId: number,
    releaseId: number,
    price: number,
    cond = "Very Good Plus (VG+)",
    sleeve = "Very Good (VG)",
) {
    return {
        id: listingId,
        price: { value: price, currency: "USD" },
        condition: cond,
        sleeve_condition: sleeve,
        ships_from: "United States",
        comments: "",
        uri: `https://www.discogs.com/sell/item/${listingId}`,
        release: { id: releaseId, description: "Radiohead - OK Computer (2xLP, Album)" },
    };
}

function mockInventory(http: ReturnType<typeof mockFetch>, seller = "recordstore") {
    const page1 = {
        pagination: { page: 1, pages: 2 },
        listings: [invListing(1, 123, 120.0), invListing(2, 999, 10.0)],
    };
    const page2 = {
        pagination: { page: 2, pages: 2 },
        listings: [invListing(3, 123, 95.0, "Near Mint (NM or M-)")],
    };
    return http.on(`/users/${seller}/inventory`, (url) =>
        json(url.searchParams.get("page") === "2" ? page2 : page1),
    );
}

function mockListingDetails(http: ReturnType<typeof mockFetch>) {
    const details: Record<string, [number, string]> = {
        "1": [120.0, "Very Good Plus (VG+)"],
        "3": [95.0, "Near Mint (NM or M-)"],
    };
    return http.on(/^\/marketplace\/listings\/\d+$/, (url) => {
        const id = url.pathname.split("/").pop() ?? "";
        const entry = details[id];
        if (!entry) return json({ message: "Listing not found." }, { status: 404 });
        return json({
            ...invListing(Number(id), 123, entry[0], entry[1]),
            seller: {
                username: "recordstore",
                stats: { rating: "99.6" },
                shipping: "US Media Mail $5, ships in 2 days",
            },
        });
    });
}

function mockPressingsForSale(http: ReturnType<typeof mockFetch>) {
    http.on("/releases/123", { ...RELEASE, master_id: 555 });
    http.on("/masters/555/versions", {
        pagination: { page: 1, pages: 1 },
        versions: [
            version(123, "UK", "1997", ["Vinyl"], 300),
            version(201, "US", "1990", ["Vinyl"], 200),
            version(202, "US", "1990-05-01", ["Vinyl"], 100), // full date: tests startsWith
            version(203, "US", "1990", ["CD"], 50), // not vinyl: always filtered out
            version(204, "Germany", "2016", ["Vinyl"], 10), // nothing for sale
        ],
    });
    // [num_for_sale, lowest_price] per release
    const stats: Record<string, [number, number | null]> = {
        "123": [42, 55],
        "201": [3, 80],
        "202": [1, 150],
        "204": [0, null],
    };
    return http.on(/^\/marketplace\/stats\/\d+$/, (url) => {
        const [count, price] = stats[url.pathname.split("/").pop() ?? ""] ?? [0, null];
        return json({
            num_for_sale: count,
            lowest_price: price === null ? null : { value: price, currency: "USD" },
        });
    });
}

describe("matching helpers", () => {
    it("matches catalog numbers ignoring spaces, dashes and case", () => {
        expect(catnoInTitle("NODATA 02", "Radiohead OK Computer LP NODATA02 1997")).toBe(true);
        expect(catnoInTitle("7243 8 55229 1 1", "OK Computer 7243-8-55229-1-1 vinyl")).toBe(true);
        expect(catnoInTitle("NODATA 02", "Radiohead OK Computer 2016 reissue")).toBe(false);
        expect(catnoInTitle("none", "anything")).toBe(false);
    });

    it("strips Discogs artist disambiguation from keywords", () => {
        expect(keywordsFor({ title: "Blue", artist: "Joni Mitchell (2)" })).toBe(
            "Joni Mitchell Blue",
        );
    });

    it("parses comma-separated sellers", () => {
        expect(parseSellers(" shop_a, ,shop_b ")).toEqual(["shop_a", "shop_b"]);
        expect(parseSellers(undefined)).toEqual([]);
    });
});

describe("Discogs client", () => {
    it("parses a release, normalizing barcodes", async () => {
        const digger = make(setup());
        const { release, discogs_market } = await digger.marketOverview(123);
        expect(release).toMatchObject({
            artist: "Radiohead",
            label: "Parlophone",
            catno: "NODATA 02",
            formats: ["Vinyl, LP, Album"],
            barcodes: ["724385522911"],
        });
        expect(discogs_market).toEqual({ num_for_sale: 42, lowest_price: 55, currency: "USD" });
    });

    it("searches releases", async () => {
        const http = mockFetch();
        const search = http.on("/database/search", {
            results: [
                {
                    id: 123,
                    title: "Radiohead - OK Computer",
                    year: "1997",
                    label: ["Parlophone"],
                    catno: "NODATA 02",
                },
            ],
        });
        const results = await make(http).searchReleases("ok computer", { catno: "" });
        expect(results[0]).toMatchObject({ release_id: 123, label: "Parlophone" });
        const params = search.calls[0]?.searchParams;
        expect(params?.get("q")).toBe("ok computer");
        expect(params?.get("format")).toBe("Vinyl");
        expect(params?.has("catno")).toBe(false); // empty filters are dropped
    });

    it("requires a token to search", async () => {
        const digger = make(mockFetch(), { discogsToken: "" });
        await expect(digger.searchReleases("x")).rejects.toThrow(/DISCOGS_TOKEN/);
    });

    it("retries after a 429", async () => {
        const http = mockFetch();
        const route = http.on("/releases/123", (_url, call) =>
            call === 0
                ? new Response(null, { status: 429, headers: { "Retry-After": "0" } })
                : json(RELEASE),
        );
        const client = new DiscogsClient("t", "test", { fetch: http.fetch, minIntervalMs: 0 });
        const release = await client.getRelease(123);
        expect(release.catno).toBe("NODATA 02");
        expect(route.calls).toHaveLength(2);
    });

    it("spaces requests out to respect the rate limit", async () => {
        const http = mockFetch();
        http.on("/releases/123", RELEASE);
        const client = new DiscogsClient("t", "test", { fetch: http.fetch, minIntervalMs: 50 });
        const start = performance.now();
        await Promise.all([client.getRelease(123), client.getRelease(123), client.getRelease(123)]);
        expect(performance.now() - start).toBeGreaterThanOrEqual(95); // 3 requests: 0, 50, 100 ms
    });

    it("turns network failures into DiscogsError", async () => {
        const client = new DiscogsClient("t", "test", {
            fetch: () => Promise.reject(new TypeError("fetch failed")),
            minIntervalMs: 0,
        });
        await expect(client.getRelease(1)).rejects.toBeInstanceOf(DiscogsError);
    });
});

describe("findCopies over seller inventories", () => {
    it("works with only a Discogs token and no sellers", async () => {
        const out = await make(setup()).findCopies(123);
        expect(out.discogs_market.num_for_sale).toBe(42);
        expect(out.copies).toEqual([]);
        expect(out.sellers_searched).toEqual([]);
        expect(out.note).toMatch(/No Discogs sellers chosen/);
    });

    it("finds the exact pressing with the seller's shipping policy", async () => {
        const http = setup();
        mockInventory(http);
        mockListingDetails(http);

        const out = await make(http).findCopies(123, { sellers: ["recordstore"] });

        // Other release (999) excluded, cheapest first.
        expect(out.copies.map((c) => c.item_id)).toEqual(["3", "1"]);
        const best = out.copies[0];
        expect(best).toMatchObject({
            source: "discogs",
            catno_match: true,
            record_grading: "Near Mint (NM or M-)",
            sleeve_grading: "Very Good (VG)",
            shipping_policy: "US Media Mail $5, ships in 2 days",
            seller_rating: "99.6",
            ships_from: "United States",
            shipping_type: "SELLER_POLICY",
        });
        expect(out.sellers_searched[0]).toMatchObject({ listings_scanned: 3, from_cache: false });
        expect(out.note).toMatch(/Searched 1 Discogs seller inventory;/);
    });

    it("uses the configured default sellers", async () => {
        const http = setup();
        mockInventory(http, "shop_a");
        const out = await make(http, { discogsSellers: ["shop_a"] }).findCopies(123, {
            withDetails: false,
        });
        expect(out.count).toBe(2);
        expect(out.sellers_searched[0]?.seller).toBe("shop_a");
    });

    it("filters by max price", async () => {
        const http = setup();
        mockInventory(http);
        const out = await make(http).findCopies(123, {
            sellers: ["recordstore"],
            maxPrice: 100,
            withDetails: false,
        });
        expect(out.copies.map((c) => c.item_id)).toEqual(["3"]);
    });

    it("caches inventories on disk between searches", async () => {
        const http = setup();
        const inventory = mockInventory(http);
        const opts = { sellers: ["recordstore"], withDetails: false };

        await make(http).findCopies(123, opts);
        expect(inventory.calls).toHaveLength(2); // two pages

        const second = make(http); // new instance: reads the on-disk cache
        const out = await second.findCopies(123, opts);
        expect(inventory.calls).toHaveLength(2);
        expect(out.sellers_searched[0]?.from_cache).toBe(true);
        expect(out.count).toBe(2);

        await second.findCopies(123, { ...opts, refresh: true });
        expect(inventory.calls).toHaveLength(4);
    });

    it("reads cache files written by the Python version", async () => {
        await writeFile(
            join(cacheDir, "inventory_recordstore.json"),
            JSON.stringify({
                fetched_at: Date.now() / 1000,
                truncated: false,
                listings: [
                    { listing_id: 7, release_id: 123, description: "OK Computer", price: 50 },
                ],
            }),
        );
        const out = await make(setup()).findCopies(123, {
            sellers: ["recordstore"],
            withDetails: false,
        });
        expect(out.copies.map((c) => c.item_id)).toEqual(["7"]);
        expect(out.sellers_searched[0]?.from_cache).toBe(true);
    });

    it("serves a stale scan when a refresh fails", async () => {
        const http = setup();
        let fail = false;
        http.on("/users/flaky/inventory", () =>
            fail ? json({}, { status: 500 }) : json({ listings: [invListing(1, 123, 10)] }),
        );
        const digger = make(http);
        await digger.findCopies(123, { sellers: ["flaky"], withDetails: false });
        fail = true;
        const out = await digger.findCopies(123, {
            sellers: ["flaky"],
            refresh: true,
            withDetails: false,
        });
        expect(out.count).toBe(1);
        expect(out.sellers_searched[0]?.error).toMatch(/Refresh failed, using older scan/);
    });

    it("reports an unknown seller without failing the search", async () => {
        const http = setup();
        http.on("/users/nobody/inventory", () =>
            json({ message: "User does not exist." }, { status: 404 }),
        );
        mockInventory(http);

        const out = await make(http).findCopies(123, {
            sellers: ["nobody", "recordstore"],
            withDetails: false,
        });
        expect(out.sellers_searched[0]?.error).toMatch(/Not found/);
        expect(out.count).toBe(2);
    });

    it("keeps cached data when a listing has sold since the scan", async () => {
        const http = setup();
        http.on("/users/recordstore/inventory", { listings: [invListing(5, 123, 30)] });
        mockListingDetails(http); // listing 5 returns 404
        const out = await make(http).findCopies(123, { sellers: ["recordstore"] });
        expect(out.copies[0]).toMatchObject({ item_id: "5", price: 30, seller: "recordstore" });
    });
});

describe("listing sources", () => {
    it("merges configured sources, skips unconfigured ones, and sorts exact pressings first", async () => {
        const fake = (name: string, configured: boolean, prices: number[], exact: boolean) =>
            ({
                name,
                configured,
                findCopies: () =>
                    Promise.resolve({
                        copies: prices.map((price, i) =>
                            emptyCopy({
                                source: name,
                                item_id: `${name}${i}`,
                                title: "",
                                price,
                                catno_match: exact,
                            }),
                        ),
                        notes: [`${name} searched.`],
                    }),
            }) satisfies ListingSource;

        const settings = makeSettings({ cacheDir });
        const discogs = new DiscogsClient("t", "test", { fetch: setup().fetch, minIntervalMs: 0 });
        const digger = new CrateDigger(settings, {
            discogs,
            sources: [
                fake("loose", true, [5], false),
                fake("exact", true, [80, 60], true),
                fake("off", false, [1], true),
            ],
        });

        const out = await digger.findCopies(123);
        expect(out.copies.map((c) => c.item_id)).toEqual(["exact1", "exact0", "loose0"]);
        expect(out.note).toBe("loose searched. exact searched.");
    });
});

describe("copyDetails and refreshSellers", () => {
    it("returns one Discogs listing as a Copy", async () => {
        const http = mockFetch();
        mockListingDetails(http);
        const copy = await make(http).copyDetails("3");
        expect(copy).toMatchObject({ item_id: "3", price: 95, seller: "recordstore" });
    });

    it("rejects non-Discogs ids", async () => {
        await expect(make(mockFetch()).copyDetails("v1|123|0")).rejects.toBeInstanceOf(
            InvalidInputError,
        );
    });

    it("rescans sellers", async () => {
        const http = mockFetch();
        const inventory = mockInventory(http);
        const summaries = await make(http).refreshSellers(["recordstore", " recordstore ", ""]);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toMatchObject({ listings_scanned: 3, from_cache: false, error: null });
        expect(inventory.calls).toHaveLength(2);
    });
});

describe("findPressingsForSale", () => {
    it("returns pressings for sale, cheapest first", async () => {
        const http = mockFetch();
        mockPressingsForSale(http);
        const pressingResult = await make(http).findPressingsForSale(123);
        expect(pressingResult.pressings.map((p) => p.release.id)).toEqual([123, 201, 202]);
        expect(pressingResult).toMatchObject({
            checked: 4,
            release_id: 123,
            releases_for_sale: 1,
            stats_failed: 0,
            total_versions: 5,
        });
    });


    it("applies country, year, and max price filters", async () => {
        const http = mockFetch();
        mockPressingsForSale(http);
        const pressingResult = await make(http).findPressingsForSale(123, {
            country: "US",
            released: "1990",
            maxPrice: 100,
        });
        expect(pressingResult.pressings.map((p) => p.release.id)).toEqual([201]);
    });

});
