/**
 * Plain data shapes shared by the MCP server and the web UI.
 *
 * Field names are snake_case on purpose: these objects are serialized straight to
 * JSON for index.html and the MCP tools, and the response shapes must match the
 * Python version. Everything else in the codebase uses camelCase.
 */

/** One specific pressing on Discogs. */
export interface Release {
    id: number;
    title: string;
    artist: string;
    year: number | null;
    country: string | null;
    label: string | null;
    catno: string | null;
    formats: string[];
    barcodes: string[];
    thumb: string | null;
    url: string | null;
    master_id: number | null;
}

/** Discogs' aggregate marketplace numbers for a release. */
export interface MarketStats {
    num_for_sale: number;
    lowest_price: number | null;
    currency: string | null;
}

/** One search result from the Discogs database. */
export interface ReleaseSearchResult {
    release_id: number;
    title: string | null;
    year: string | number | null;
    country: string | null;
    label: string | null;
    catno: string | null;
    formats: string[];
    thumb: string | null;
}

/** One pressing of a master, with its Discogs marketplace numbers. */
export interface PressingForSale {
    release: Release;
    /** null if the stats request failed for this pressing. */
    discogs_market: MarketStats | null;
    /** How many Discogs users own it; useful for ranking common pressings first. */
    in_collection: number | null;
    /** Discogs marketplace page listing every copy of this pressing for sale. */
    sell_url: string;
}

/** One copy of a record for sale, from any listing source. */
export interface Copy {
    source: string;
    item_id: string;
    title: string;
    price: number | null;
    currency: string | null;
    /** null means unknown, or set by the seller's shipping policy. */
    shipping_cost: number | null;
    /** e.g. FIXED, CALCULATED, SELLER_POLICY. */
    shipping_type: string | null;
    total: number | null;
    /** A marketplace's coarse condition, e.g. "Used". Discogs uses record_grading instead. */
    condition: string | null;
    /** e.g. "Near Mint (NM or M-)". */
    record_grading: string | null;
    sleeve_grading: string | null;
    ships_from: string | null;
    seller: string | null;
    seller_feedback_pct: string | null;
    buying_options: string[];
    returns: string | null;
    /** The seller's own shipping terms (Discogs). */
    shipping_policy: string | null;
    seller_rating: string | null;
    comments: string | null;
    url: string | null;
    image: string | null;
    /** True when this is known to be the exact pressing (e.g. tied to the Discogs release id). */
    catno_match: boolean;
}

/** A Copy with every optional field empty, to spread required fields into. */
export function emptyCopy(
    fields: Pick<Copy, "source" | "item_id" | "title"> & Partial<Copy>,
): Copy {
    return {
        price: null,
        currency: null,
        shipping_cost: null,
        shipping_type: null,
        total: null,
        condition: null,
        record_grading: null,
        sleeve_grading: null,
        ships_from: null,
        seller: null,
        seller_feedback_pct: null,
        buying_options: [],
        returns: null,
        shipping_policy: null,
        seller_rating: null,
        comments: null,
        url: null,
        image: null,
        catno_match: false,
        ...fields,
    };
}
