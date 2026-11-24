import type { SellerScanSummary } from "../core/listing-source.js";
import type { Copy, MarketStats, Release, ReleaseSearchResult } from "../core/models.js";
import type { FindPressingsForSaleResult } from "../core/service.js";

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

export function formatPressingsForSale(pressingsResult: FindPressingsForSaleResult): string {
    const pressings = pressingsResult.pressings;
    console.error(`Pressings for sale: ${pressings.length}`);
    console.error(`Total versions: ${pressingsResult.total_versions}`);
    console.error(`Matching versions: ${pressingsResult.matching_versions}`);
    console.error(`Checked pressings: ${pressingsResult.checked}`);
    console.error(`Stats failed: ${pressingsResult.stats_failed}`);
    console.error(`Releases for sale: ${pressingsResult.releases_for_sale}`);
    console.error(`Release ID: ${pressingsResult.release_id}`);
    const lines = pressings.map((p) =>
        [
            `Release ID: ${p.release.id}`,
            `Label: ${p.release.label ?? "?"} | Catno: ${p.release.catno ?? "?"}`,
            `Country: ${p.release.country ?? "?"} | Year: ${p.release.year ?? "?"} | Format: ${[...p.release.formats, p.release.format_description].filter(Boolean).join(", ")}`,
            `Copies for sale: ${p.discogs_market?.num_for_sale ?? "?"} | Lowest price: ${p.discogs_market?.lowest_price ?? "?"} ${p.discogs_market?.currency ?? ""}`,
            `Link: ${p.sell_url}`,
        ].join("\n"),
    );

    const r = pressingsResult;
    const summary: string[] = [
        `Master ${r.master_id ?? "?"} has ${r.total_versions} versions. ` +
            `Checked ${r.checked} vinyl pressings; ${r.pressings.length} have copies for sale. `,
    ];

    const asked = r.releases_for_sale > 0;
    console.error(`Releases for sale: ${r.releases_for_sale}`);
    summary.push(
        asked
            ? `Release ${r.release_id} (the one you asked about) has copies for sale.`
            : `Release ${r.release_id} (the one you asked about) has no copies for sale.`,
    );

    if (r.checked < r.matching_versions) {
        summary.push(
            `Checked only the ${r.checked} most common of ${r.matching_versions} matching pressings.`,
        );
    }
    if (r.stats_failed > 0) {
        summary.push(
            `Stats failed for ${r.stats_failed} pressing${r.stats_failed === 1 ? "" : "s"}.`,
        );
    }

    if (r.pressings.length === 0) {
        return [...summary, "No pressings for sale."].join("\n");
    }

    return `${summary.join("\n")}\n\n${lines.join("\n\n")}`;
}
