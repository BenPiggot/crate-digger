import type { SellerScanSummary } from "../listing-source.js";
import type { Copy, MarketStats, Release, ReleaseSearchResult } from "../models.js";

export function formatReleases(releases: ReleaseSearchResult[]): string {
    if (releases.length === 0) {
        return "No releases found.";
    }

    const lines = releases.map((r) => (
        `${r.release_id} - ${r.title} (${r.year ?? "?"}, ${r.country ?? "?"}) - ${r.label ?? "?"} ${r.catno ?? "?"}`
    ));

    return `${releases.length} releases:\n${lines.join("\n")}`;
}

export function formatMarketOverview(releaseId: number, release: Release, discogs_market: MarketStats ): string {
    if (!release) {
        return `Release ${releaseId} not found.`;
    }

    if (!discogs_market) {
        return `Release ${releaseId}: ${release.title} (${release.year ?? "?"}, ${release.country ?? "?"}) - ${release.label ?? "?"} ${release.catno ?? "?"}\nDiscogs Market: not found.`;
    }

    const releaseInfo = `Release ${releaseId}: ${release.title} (${release.year ?? "?"}, ${release.country ?? "?"}) - ${release.label ?? "?"} ${release.catno ?? "?"}`;
    const marketInfo = `Discogs Market: ${discogs_market.num_for_sale} copies for sale, lowest price: ${discogs_market.lowest_price ?? "?"} ${discogs_market.currency ?? "?"}`;
    return `${releaseInfo}\n${marketInfo}`;
}

export function formatCopies(copies: Copy[]): string {
    if (copies.length === 0) {
        return "No copies for sale from the checked sellers. Try refresh=true or other sellers.";
    }

    const lines = copies.map((c) => (
        `${c.seller} - ${c.price} - ${c.condition ?? "?"} - ${c.sleeve_grading ?? "?"} - Ships from: ${c.ships_from ?? "?"}`
    ));

    return `${copies.length} copies, exact matches first, cheapest first:\n${lines.join("\n")}`;
}

export function formatSellerInventories(sellers: SellerScanSummary[]): string {
    if (sellers.length === 0) {
        return "No sellers scanned.";
    }

    const lines = sellers.map((s) => (
        `${s.seller} - ${s.listings_scanned} items, last scanned: ${s.scanned_minutes_ago ? String(s.scanned_minutes_ago) : "never"}`
    ));

    return `${sellers.length} sellers scanned:\n${lines.join("\n")}`;
}   

export function formatCopyDetails(copy: Copy): string {
    if (!copy) {
        return "Copy not found.";
    }

    return `Copy details: Source: ${copy.source} - Item ID: ${copy.item_id} - Title: ${copy.title} - Price: ${copy.price ?? "?"} ${copy.currency ?? "?"} 
        - Shipping Cost: ${copy.shipping_cost ?? "?"} (${copy.shipping_type ?? "?"} - Total: ${copy.total ?? "?"}`;
}