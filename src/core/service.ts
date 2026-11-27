/** Core logic shared by the MCP server and the web UI. */

import { FileCache } from "./cache.js";
import type { Settings } from "./config.js";
import {
    DiscogsClient,
    DiscogsError,
    toRelease,
    toVersion,
    type RawVersion,
    type SearchFilters,
} from "./discogs.js";
import {
    DiscogsInventorySource,
    InventoryIndex,
    discogsCopy,
    scanSummary,
    uniqueSellers,
} from "./inventory.js";
import type {
    FindPressingsForSaleSearchOptions,
    ListingSource,
    SearchOptions,
    SellerScanSummary,
} from "./listing-source.js";
import type {
    Copy,
    MarketStats,
    PressingForSale,
    PressingTarget,
    Release,
    ReleaseSearchResult,
} from "./models.js";
import { PressingIdentifier, type Candidate, type PressingClues } from "./identify.js";
import type { PressingMatch } from "./models.js";
import { prefilter, PressingsIndex } from "./pressings.js";
import { normalizeCode } from "./utils/text.js";
// import { PressingsIndex } from "./pressings.js";

/** Bad input from a caller (the web layer maps it to HTTP 400). */
export class InvalidInputError extends Error {
    override name = "InvalidInputError";
}

/**
 * True if the catalog number (ignoring spaces, dashes and case) appears in the title.
 * For sources whose listings aren't tied to a Discogs release, e.g. eBay later.
 */
export function catnoInTitle(catno: string | null | undefined, title: string): boolean {
    if (!catno || catno.toLowerCase() === "none") return false;
    return normalizeCode(title).includes(normalizeCode(catno));
}

/** Artist + title search keywords. Discogs appends "(2)" etc. to disambiguate artists; sellers don't. */
export function keywordsFor(release: Pick<Release, "artist" | "title">): string {
    const artist = release.artist.replace(/\s*\(\d+\)/g, "");
    return `${artist} ${release.title}`.trim();
}

/** Exact pressings first, then cheapest (total if known, else price). */
export function compareCopies(a: Copy, b: Copy): number {
    if (a.catno_match !== b.catno_match) return a.catno_match ? -1 : 1;
    const cost = (c: Copy) => c.total ?? c.price ?? Number.POSITIVE_INFINITY;
    return cost(a) - cost(b);
}

export interface MarketOverview {
    release: Release;
    discogs_market: MarketStats;
}

export interface FindCopiesResult extends MarketOverview {
    sellers_searched: SellerScanSummary[];
    count: number;
    copies: Copy[];
    note: string;
}

export type FindCopiesOptions = Partial<Omit<SearchOptions, "sellers" | "maxPrice">> & {
    /** Defaults to the configured sellers. */
    sellers?: readonly string[] | null | undefined;
    maxPrice?: number | null | undefined;
};

export interface FindPressingsForSaleResult {
    pressings: PressingForSale[];
    master_id: number | null;
    releases_for_sale: number;
    release_id: number | null;
    /** Versions of this master on Discogs, all formats. */
    total_versions: number;
    /** Versions left after the format, country and year filters. */
    matching_versions: number;
    /** How many had their stats checked (capped by maxPressingsChecked). */
    checked: number;
    /** Stats requests that failed. */
    stats_failed: number;
}

export type FindPressingsForSaleOptions = Partial<SearchFilters> & {
    country?: string | null | undefined;
    maxPrice?: number | null | undefined;
    refresh?: boolean;
    limit?: number;
    withDetails?: boolean;
    released?: string | null | undefined;
    format?: string | null | undefined;
};

export interface IdentifyPressingResult {
    master_id: number | null;
    matches: PressingMatch[];
    confident: boolean;
    next_check: string | null;
    total_versions: number;
    /** Versions left after the format, country and year filters. */
    matching_versions: number;
    /** How many had their stats checked (capped by maxPressingsChecked). */
    checked: number;
    /** Releases requests that failed. */
    releases_failed: number;
}

export interface CrateDiggerDeps {
    discogs?: DiscogsClient;
    inventory?: InventoryIndex;
    /** Defaults to Discogs seller inventories only. */
    sources?: ListingSource[];
    pressings?: PressingsIndex;
    identifier?: PressingIdentifier;
}

export class CrateDigger {
    readonly discogs: DiscogsClient;
    readonly inventory: InventoryIndex;
    readonly sources: readonly ListingSource[];
    readonly pressings: PressingsIndex;
    readonly identifier: PressingIdentifier;

    readonly VINYL = "Vinyl";

    constructor(
        readonly settings: Settings,
        deps: CrateDiggerDeps = {},
    ) {
        this.discogs = deps.discogs ?? new DiscogsClient(settings.discogsToken, settings.userAgent);
        this.inventory =
            deps.inventory ??
            new InventoryIndex(this.discogs, {
                cacheDir: settings.cacheDir,
                ttlMs: settings.inventoryTtlHours * 3600 * 1000,
                maxPages: settings.maxInventoryPages,
            });

        this.pressings =
            deps.pressings ??
            new PressingsIndex(
                this.discogs,
                settings,
                new FileCache(
                    settings.cacheDir,
                    "versions",
                    settings.versionsTtlHours * 3600 * 1000,
                ),
                new FileCache(settings.cacheDir, "stats", settings.statsTtlHours * 3600 * 1000),
                new FileCache(
                    settings.cacheDir,
                    "releases",
                    settings.versionsTtlHours * 3600 * 1000,
                ),
            );
        this.identifier = deps.identifier ?? new PressingIdentifier();
        this.sources = deps.sources ?? [
            new DiscogsInventorySource(this.discogs, this.inventory, settings.currency),
        ];
    }

    async searchReleases(
        query: string,
        filters: SearchFilters = {},
    ): Promise<ReleaseSearchResult[]> {
        return this.discogs.search(query, filters);
    }

    async marketOverview(releaseId: number): Promise<MarketOverview> {
        const [release, stats] = await Promise.all([
            this.discogs.getRelease(releaseId),
            this.discogs.getMarketStats(releaseId, this.settings.currency),
        ]);
        return { release, discogs_market: stats };
    }

    /** Every copy of this pressing for sale from the configured listing sources. */
    async findCopies(
        releaseId: number,
        options: FindCopiesOptions = {},
    ): Promise<FindCopiesResult> {
        const opts: SearchOptions = {
            sellers: options.sellers?.length ? options.sellers : this.settings.discogsSellers,
            refresh: options.refresh ?? false,
            maxPrice: options.maxPrice ?? null,
            limit: options.limit ?? 50,
            withDetails: options.withDetails ?? true,
            detailsLimit: options.detailsLimit ?? 20,
        };
        const { release, discogs_market } = await this.marketOverview(releaseId);

        const results = await Promise.all(
            this.sources.filter((s) => s.configured).map((s) => s.findCopies(release, opts)),
        );

        let copies = results.flatMap((r) => r.copies);
        if (opts.maxPrice !== null) {
            const max = opts.maxPrice;
            copies = copies.filter((c) => c.price === null || c.price <= max);
        }
        copies.sort(compareCopies);

        return {
            release,
            discogs_market,
            sellers_searched: results.flatMap((r) => r.sellersSearched ?? []),
            count: copies.length,
            copies,
            note: results.flatMap((r) => r.notes ?? []).join(" "),
        };
    }

    /** Rescan seller inventories now (e.g. to warm the cache before searching). */
    async refreshSellers(sellers: readonly string[]): Promise<SellerScanSummary[]> {
        const summaries: SellerScanSummary[] = [];
        for (const seller of uniqueSellers(sellers)) {
            summaries.push(scanSummary(await this.inventory.scan(seller, true)));
        }
        return summaries;
    }

    /** Full details for one Discogs listing (numeric listing id). */
    async copyDetails(itemId: string): Promise<Copy> {
        if (!/^\d+$/.test(itemId)) {
            throw new InvalidInputError(`Not a Discogs listing id: "${itemId}"`);
        }
        const detail = await this.discogs.getListing(Number(itemId), this.settings.currency);
        return discogsCopy(
            {
                listing_id: detail.id ?? Number(itemId),
                description: detail.release?.description ?? null,
                uri: detail.uri ?? null,
            },
            detail,
        );
    }

    async findPressingsForSale(
        releaseId: number,
        options: FindPressingsForSaleOptions = {},
    ): Promise<FindPressingsForSaleResult> {
        const opts: FindPressingsForSaleSearchOptions = {
            refresh: options.refresh ?? false,
            maxPrice: options.maxPrice ?? null,
            format: options.format ?? null,
            country: options.country ?? null,
            released: options.released ?? null,
            limit: options.limit ?? 50,
            withDetails: options.withDetails ?? true,
        };
        const { release } = await this.marketOverview(releaseId);

        const rawVersions = await this.pressings.versions(
            release.master_id ?? releaseId ?? 0,
            opts,
        );
        const matching = rawVersions
            .filter((version) => this.matchesFilters(version, opts))
            .sort((a, b) => this.byInCollectionDesc(a, b));
        const candidates = matching.slice(0, this.settings.maxPressingsChecked);

        const pressings: PressingForSale[] = [];
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const [_, version] of candidates.entries()) {
            let marketStats: MarketStats | null = null;

            try {
                marketStats = await this.pressings.stats(version.id);
            } catch (e) {
                // Transient error: keep the cached data.
                if (!(e instanceof DiscogsError)) throw e;
            }

            pressings.push({
                release: toVersion(version),
                discogs_market: marketStats,
                in_collection: version?.stats?.community?.in_collection ?? 0,
                sell_url: `https://www.discogs.com/sell/release/${version.id}`,
            });
        }

        const forSale = pressings
            .filter((p) => (p.discogs_market?.num_for_sale ?? 0) > 0)
            .filter((p) => {
                const lowestPrice = p.discogs_market?.lowest_price;
                return (
                    opts.maxPrice === null || lowestPrice == null || lowestPrice <= opts.maxPrice
                );
            })
            .sort(
                (a, b) =>
                    (a.discogs_market?.lowest_price ?? Infinity) -
                    (b.discogs_market?.lowest_price ?? Infinity),
            );
        const queriedReleasesForSale = forSale.filter((p) => p.release.id === releaseId).length;
        return {
            pressings: forSale,
            master_id: release.master_id,
            release_id: release.id,
            releases_for_sale: queriedReleasesForSale,
            total_versions: rawVersions.length,
            matching_versions: matching.length,
            checked: pressings.length,
            stats_failed: pressings.filter((p) => p.discogs_market === null).length,
        };
    }

    private matchesFilters(version: RawVersion, opts: FindPressingsForSaleSearchOptions): boolean {
        const wanted = opts.format ?? this.VINYL;
        if (!version.major_formats?.includes(wanted)) return false;
        if (opts.country && !(version.country === opts.country)) return false;
        if (opts.released && !version.released?.startsWith(opts.released)) return false;
        return true;
    }

    private byInCollectionDesc(a: RawVersion, b: RawVersion): number {
        return (
            (b?.stats?.community?.in_collection ?? 0) - (a?.stats?.community?.in_collection ?? 0)
        );
    }

    async identifyPressing(
        target: PressingTarget,
        clues: PressingClues,
    ): Promise<IdentifyPressingResult> {
        const masterId = await this.masterIdFor(target);
        const versions = await this.pressings.versions(masterId);
        const filteredVersions = prefilter(versions, clues);

        const candidateVersions = [...filteredVersions]
            .sort((a, b) => this.byInCollectionDesc(a, b))
            .slice(0, this.settings.maxPressingsChecked);

        const details: Candidate[] = [];

        for (const version of candidateVersions) {
            try {
                details.push({ version, release: await this.pressings.releases(version.id) });
            } catch (e) {
                if (!(e instanceof DiscogsError)) throw e;
            }
        }

        const ranked = this.identifier.rank(clues, details);
        const top = ranked.slice(0, 3);
        const [first, second] = top;
        const confident = this.identifier.isConfident(top);

        return {
            master_id: masterId,
            matches: top.map((candidate) => ({
                release: toRelease(candidate.release),
                score: candidate.score,
                matched: candidate.matched,
                conflicts: candidate.conflicts,
            })),
            confident,
            next_check:
                !confident && first !== undefined && second !== undefined
                    ? this.identifier.distinguishingCheck(clues, first, second)
                    : null,
            total_versions: versions.length,
            matching_versions: filteredVersions.length,
            checked: details.length,
            releases_failed: filteredVersions.length - details.length,
        };
    }

    private async masterIdFor(target: PressingTarget): Promise<number> {
        if ("masterId" in target) return target.masterId;
        const release = await this.discogs.getRelease(target.releaseId);
        if (!release.master_id) throw new Error(`Release ${target.releaseId} has no master`);
        return release.master_id;
    }
}
