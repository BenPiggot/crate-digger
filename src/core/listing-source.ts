/**
 * A place copies for sale come from. Discogs seller inventories are the only
 * implementation today; eBay can be added later as a second one (see PLAN.md).
 */

import type { Copy, Release } from "./models.js";

export interface SearchOptions {
    /** Discogs seller usernames to search. Sources that don't use sellers ignore it. */
    sellers: readonly string[];
    /** Rescan instead of using cached data. */
    refresh: boolean;
    maxPrice: number | null;
    /** Max copies to ask the source for, where it supports a limit. */
    limit: number;
    /** Fetch per-listing details (seller rating, shipping policy) for the first `detailsLimit` copies. */
    withDetails: boolean;
    detailsLimit: number;
}

export interface FindPressingsForSaleSearchOptions {
    format: string | null;
    country: string | null;
    released: string | null;
    /** Rescan instead of using cached data. */
    refresh: boolean;
    maxPrice: number | null;
    /** Max copies to ask the source for, where it supports a limit. */
    limit: number;
    withDetails: boolean;
}

export interface PressingIdentification {
    release: Release;
    score: number;
    matched: string[];
    conflicts: string[];    
    runouts: string[];
}

/** Per-seller scan summary, shown in the UI as "sellers_searched". */
export interface SellerScanSummary {
    seller: string;
    listings_scanned: number;
    from_cache: boolean;
    scanned_minutes_ago: number;
    truncated: boolean;
    error: string | null;
}

export interface SourceResult {
    copies: Copy[];
    /** Only sources that scan sellers fill this in. */
    sellersSearched?: SellerScanSummary[];
    /** Sentences for the response's `note`, e.g. caveats about match quality. */
    notes?: string[];
}

export interface ListingSource {
    readonly name: string;
    /** False when the source is missing credentials; CrateDigger skips it. */
    readonly configured: boolean;
    findCopies(release: Release, opts: SearchOptions): Promise<SourceResult>;
}
