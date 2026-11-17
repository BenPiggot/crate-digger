/**
 * Search chosen Discogs sellers' inventories for an exact release.
 *
 * The Discogs API has no "all listings for a release" endpoint, but every seller's
 * inventory is public. Scanning an inventory costs one request per 100 listings,
 * so scans are cached on disk and reused until they expire.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DiscogsError, type DiscogsClient, type RawListing } from "./discogs.js";
import type {
  ListingSource,
  SearchOptions,
  SellerScanSummary,
  SourceResult,
} from "./listing-source.js";
import { emptyCopy, type Copy, type Release } from "./models.js";

/** The fields we keep from each inventory listing, so cache files stay small. */
export interface CompactListing {
  listing_id: number;
  release_id: number | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  condition: string | null;
  sleeve_condition: string | null;
  ships_from: string | null;
  comments: string | null;
  uri: string | null;
}

export type InventoryMatch = CompactListing & { seller: string };

export function compact(listing: RawListing): CompactListing {
  return {
    listing_id: listing.id,
    release_id: listing.release?.id ?? null,
    description: listing.release?.description ?? null,
    price: listing.price?.value ?? null,
    currency: listing.price?.currency ?? null,
    condition: listing.condition ?? null,
    sleeve_condition: listing.sleeve_condition ?? null,
    ships_from: listing.ships_from ?? null,
    comments: listing.comments ?? null,
    uri: listing.uri ?? null,
  };
}

export interface SellerScan {
  seller: string;
  listings: CompactListing[];
  /** Epoch ms. */
  fetchedAt: number;
  fromCache: boolean;
  /** Hit the page limit before the end of the inventory. */
  truncated: boolean;
  error: string | null;
}

export function scanSummary(scan: SellerScan, now = Date.now()): SellerScanSummary {
  return {
    seller: scan.seller,
    listings_scanned: scan.listings.length,
    from_cache: scan.fromCache,
    scanned_minutes_ago: Math.round((now - scan.fetchedAt) / 60_000),
    truncated: scan.truncated,
    error: scan.error,
  };
}

/** On-disk cache format. `fetched_at` is epoch seconds, matching the Python cache files. */
interface CacheFile {
  fetched_at: number;
  truncated?: boolean;
  listings: CompactListing[];
}

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Unique, trimmed, non-empty seller names, in the order given. */
export function uniqueSellers(sellers: Iterable<string>): string[] {
  return [...new Set([...sellers].map((s) => s.trim()).filter(Boolean))];
}

export interface InventoryIndexOptions {
  cacheDir: string;
  ttlMs?: number;
  maxPages?: number;
}

export class InventoryIndex {
  readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly maxPages: number;
  private readonly memory = new Map<string, SellerScan>();

  constructor(
    private readonly discogs: DiscogsClient,
    options: InventoryIndexOptions,
  ) {
    this.cacheDir = expandHome(options.cacheDir);
    this.ttlMs = options.ttlMs ?? 12 * 3600 * 1000;
    this.maxPages = options.maxPages ?? 100;
  }

  private path(seller: string): string {
    return join(
      this.cacheDir,
      `inventory_${seller.toLowerCase().replace(/[^A-Za-z0-9_.-]/g, "_")}.json`,
    );
  }

  private async load(seller: string): Promise<SellerScan | null> {
    const remembered = this.memory.get(seller.toLowerCase());
    if (remembered) return remembered;
    try {
      const data = JSON.parse(await readFile(this.path(seller), "utf8")) as CacheFile;
      if (!Array.isArray(data.listings) || typeof data.fetched_at !== "number") return null;
      return {
        seller,
        listings: data.listings,
        fetchedAt: data.fetched_at * 1000,
        fromCache: true,
        truncated: data.truncated ?? false,
        error: null,
      };
    } catch {
      return null; // missing or corrupt cache: just rescan
    }
  }

  private async save(scan: SellerScan): Promise<void> {
    this.memory.set(scan.seller.toLowerCase(), scan);
    const file: CacheFile = {
      fetched_at: scan.fetchedAt / 1000,
      truncated: scan.truncated,
      listings: scan.listings,
    };
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(this.path(scan.seller), JSON.stringify(file));
    } catch {
      // caching is best-effort
    }
  }

  async scan(seller: string, refresh = false): Promise<SellerScan> {
    // Load the cache even on refresh, so a failed refresh can fall back to it.
    const cached = await this.load(seller);
    if (cached && !refresh && Date.now() - cached.fetchedAt < this.ttlMs) {
      return { ...cached, fromCache: true };
    }
    const listings: CompactListing[] = [];
    try {
      for await (const raw of this.discogs.iterInventory(seller, this.maxPages)) {
        listings.push(compact(raw));
      }
    } catch (e) {
      if (!(e instanceof DiscogsError)) throw e;
      if (cached) {
        // Serve stale data rather than nothing.
        return {
          ...cached,
          fromCache: true,
          error: `Refresh failed, using older scan: ${e.message}`,
        };
      }
      return {
        seller,
        listings: [],
        fetchedAt: Date.now(),
        fromCache: false,
        truncated: false,
        error: e.message,
      };
    }
    const scan: SellerScan = {
      seller,
      listings,
      fetchedAt: Date.now(),
      fromCache: false,
      truncated: listings.length >= this.maxPages * 100,
      error: null,
    };
    await this.save(scan);
    return scan;
  }

  /** Listings of this exact release across the given sellers, plus a per-seller scan summary. */
  async find(
    releaseId: number,
    sellers: readonly string[],
    refresh = false,
  ): Promise<{ matches: InventoryMatch[]; summaries: SellerScanSummary[] }> {
    const matches: InventoryMatch[] = [];
    const summaries: SellerScanSummary[] = [];
    // Sequential on purpose: all requests share one rate limit anyway.
    for (const seller of uniqueSellers(sellers)) {
      const scan = await this.scan(seller, refresh);
      summaries.push(scanSummary(scan));
      for (const listing of scan.listings) {
        if (listing.release_id === releaseId) matches.push({ ...listing, seller });
      }
    }
    return { matches, summaries };
  }
}

/** The cached-listing fields discogsCopy reads; copyDetails builds a partial one. */
export type ListingBasics = Pick<CompactListing, "listing_id" | "description" | "uri"> &
  Partial<CompactListing> & { seller?: string };

/** Build a Copy from a cached inventory match, enriched with the full listing if available. */
export function discogsCopy(match: ListingBasics, detail: RawListing | null = null): Copy {
  const seller = detail?.seller;
  const price = detail?.price?.value ?? match.price ?? null;
  const ship = detail?.shipping_price?.value ?? null;
  const rating = seller?.stats?.rating;
  return emptyCopy({
    source: "discogs",
    item_id: String(match.listing_id),
    title: match.description ?? "",
    price,
    currency: detail?.price?.currency || match.currency || null,
    shipping_cost: ship,
    shipping_type: ship === null ? "SELLER_POLICY" : null,
    total: price !== null && ship !== null ? Math.round((price + ship) * 100) / 100 : null,
    record_grading: detail?.condition || match.condition || null,
    sleeve_grading: detail?.sleeve_condition || match.sleeve_condition || null,
    ships_from: detail?.ships_from || match.ships_from || null,
    seller: seller?.username || match.seller || null,
    seller_rating: rating ? String(rating) : null,
    shipping_policy: seller?.shipping || null,
    comments: detail?.comments || match.comments || null,
    url: match.uri,
    catno_match: true, // inventory listings are tied to the exact Discogs release
  });
}

/** ListingSource over chosen Discogs sellers' public inventories. */
export class DiscogsInventorySource implements ListingSource {
  readonly name = "discogs";
  // Inventories are public, so this works without a token (just more slowly).
  readonly configured = true;

  constructor(
    private readonly discogs: DiscogsClient,
    private readonly index: InventoryIndex,
    private readonly currency: string,
  ) {}

  async findCopies(release: Release, opts: SearchOptions): Promise<SourceResult> {
    const sellers = uniqueSellers(opts.sellers);
    if (sellers.length === 0) {
      return {
        copies: [],
        sellersSearched: [],
        notes: [
          "No Discogs sellers chosen. Add seller usernames to search their inventories for this pressing.",
        ],
      };
    }
    const { matches, summaries } = await this.index.find(release.id, sellers, opts.refresh);
    const copies: Copy[] = [];
    for (const [i, match] of matches.entries()) {
      let detail: RawListing | null = null;
      if (opts.withDetails && i < opts.detailsLimit) {
        try {
          detail = await this.discogs.getListing(match.listing_id, this.currency);
        } catch (e) {
          // Sold since the scan, or a transient error: keep the cached data.
          if (!(e instanceof DiscogsError)) throw e;
        }
      }
      copies.push(discogsCopy(match, detail));
    }
    const n = sellers.length;
    return {
      copies,
      sellersSearched: summaries,
      notes: [
        `Searched ${n} Discogs seller inventor${n === 1 ? "y" : "ies"}; those copies are this exact pressing.`,
      ],
    };
  }
}
