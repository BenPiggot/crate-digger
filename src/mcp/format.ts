import type { SellerScanSummary } from "../core/listing-source.js";
import type { Copy, MarketStats, PressingForSale, Release, ReleaseSearchResult } from "../core/models.js";

export function formatReleases(releases: ReleaseSearchResult[]): string {
    if (releases.length === 0) {
        return "No releases found.";
    }

    const lines = releases.map(
        (r) =>
            `${r.release_id} - ${r.title} (${r.year ?? "?"}, ${r.country ?? "?"}) - ${r.label ?? "?"} ${r.catno ?? "?"}`,
    );

    return `${releases.length} releases:\n${lines.join("\n")}`;
}

export function formatMarketOverview(
    releaseId: number,
    release: Release,
    discogs_market: MarketStats,
): string {
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

export function formatCopies(
    copies: Copy[],
    sellers: SellerScanSummary[] = [],
    note: string = "",
): string {
    // Sellers whose scan failed or was cut short, so "no copies" may not mean "none for sale".
    const problems = sellers
        .filter((s) => s.error || s.truncated)
        .map((s) =>
            s.error
                ? `- ${s.seller}: scan failed (${s.error})`
                : `- ${s.seller}: scan stopped early, so results may be incomplete`,
        );

    const sections: string[] = [];
    if (note) {
        sections.push(note);
    }

    if (copies.length === 0) {
        sections.push(
            "No copies for sale from the checked sellers. Try refresh=true or other sellers.",
        );
    } else {
        const copyLines = copies.map((c) =>
            [
                `${c.seller ?? "?"} (rating ${c.seller_rating ?? "?"}), listing ${c.item_id}`,
                `Media Grading: ${c.record_grading ?? "?"} | Sleeve Grading: ${c.sleeve_grading ?? "?"}`,
                `Price: ${c.price ?? "?"} ${c.currency ?? ""} | Shipping: ${c.shipping_cost ?? "?"} | Total: ${c.total ?? "?"}`,
                `Ships from: ${c.ships_from ?? "?"}`,
                `${c.url ?? ""}`,
            ].join("\n"),
        );
        sections.push(
            `${copies.length} copies, exact matches first, cheapest first:\n${copyLines.join("\n\n")}`,
        );
    }

    if (problems.length > 0) {
        sections.push(`Seller scan problems:\n${problems.join("\n")}`);
    }

    return sections.join("\n\n");
}

export function formatSellerInventories(sellers: SellerScanSummary[]): string {
    if (sellers.length === 0) {
        return "No sellers scanned.";
    }

    const lines = sellers.map((s) =>
        [
            `${s.seller} - ${s.listings_scanned} items:`,
            `- Error: ${s.error ?? "none"}`,
            `- Truncated: ${s.truncated ? "yes" : "no"}`,
            `- Last Scanned: ${!s.error ? String(s.scanned_minutes_ago) + " minutes ago" : "never"}`,
        ].join("\n"),
    );

    return `${sellers.length} sellers scanned:\n${lines.join("\n\n")}`;
}

export function formatCopyDetails(copy: Copy): string {
    if (!copy) {
        return "Copy not found.";
    }

    return [
        `Copy details: Source: ${copy.source}`,
        `Seller: ${copy.seller ?? "?"}`,
        `Item ID: ${copy.item_id}`,
        `Title: ${copy.title}`,
        `Record Grading: ${copy.record_grading ?? "?"}`,
        `Sleeve Grading: ${copy.sleeve_grading ?? "?"}`,
        `Price: ${copy.price ?? "?"} ${copy.currency ?? "?"}`,
        `Shipping Cost: ${copy.shipping_cost ?? "?"} (${copy.shipping_type ?? "?"})`,
        `Total: ${copy.total ?? "?"}`,
        `Link: ${copy.url ?? "?"}`,
    ].join("\n");
}

export function formatPressingsForSale(
    pressings: PressingForSale[],
): string {
    if (pressings.length === 0) {
        return "No pressings for sale.";
    }

    const lines = pressings.map((p) =>
        [
            `Release ID: ${p.release.id}`,
            `Label: ${p.release.label ?? "?"} | Catno: ${p.release.catno ?? "?"}`,
            `Country: ${p.release.country ?? "?"} | Year: ${p.release.year ?? "?"} | Format: ${p.release.formats.join(", ") ?? "?"}`,
            `Copies for sale: ${p.discogs_market?.num_for_sale ?? "?"} | Lowest price: ${p.discogs_market?.lowest_price ?? "?"}`,
            `Link: ${p.sell_url}`,
        ].join("\n"),
    );

    return `${pressings.length} pressings for sale:\n${lines.join("\n\n")}`;
}
