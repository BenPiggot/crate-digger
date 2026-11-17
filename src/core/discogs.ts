/**
 * Discogs client: identify the exact pressing, read aggregate market stats, and
 * read sellers' public inventories.
 *
 * Note: the Discogs API does not expose the list of marketplace listings for a
 * release. Per-copy data comes from seller inventories instead (see inventory.ts).
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { MarketStats, Release, ReleaseSearchResult } from "./models.js";

export const BASE_URL = "https://api.discogs.com";

export class DiscogsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiscogsError";
  }
}

// ---- Raw API shapes: only the fields we read, all optional because the API is loose. ----

interface RawPrice {
  value?: number;
  currency?: string;
}

export interface RawRelease {
  id: number;
  title?: string;
  artists?: { name?: string }[];
  year?: number;
  country?: string;
  labels?: { name?: string; catno?: string }[];
  formats?: { name?: string; descriptions?: string[] }[];
  identifiers?: { type?: string; value?: string }[];
  thumb?: string;
  uri?: string;
  master_id?: number;
}

interface RawSearch {
  results?: {
    id: number;
    title?: string;
    year?: string;
    country?: string;
    label?: string[];
    catno?: string;
    format?: string[];
    thumb?: string;
  }[];
}

interface RawStats {
  num_for_sale?: number;
  lowest_price?: RawPrice | null;
}

export interface RawListing {
  id: number;
  price?: RawPrice;
  shipping_price?: RawPrice;
  condition?: string;
  sleeve_condition?: string;
  ships_from?: string;
  comments?: string;
  uri?: string;
  release?: { id?: number; description?: string };
  seller?: { username?: string; stats?: { rating?: string | number }; shipping?: string };
}

interface RawInventoryPage {
  listings?: RawListing[];
  pagination?: { pages?: number };
}

export type Params = Record<string, string | number | undefined>;

export interface DiscogsClientOptions {
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Minimum ms between requests. Defaults to 1000 with a token, 2400 without. */
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface SearchFilters {
  artist?: string | undefined;
  title?: string | undefined;
  catno?: string | undefined;
  barcode?: string | undefined;
  /** Defaults to "Vinyl". Pass null to search all formats. */
  format?: string | null | undefined;
  limit?: number | undefined;
}

/**
 * Async Discogs client that stays under the rate limit.
 *
 * Discogs allows 60 requests/minute with a token and 25 without, so requests are
 * spaced out and 429 responses are retried after a pause.
 */
export class DiscogsClient {
  private readonly headers: Record<string, string>;
  private readonly fetch: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  /** Time (ms, performance.now clock) the most recently scheduled request may start. */
  private nextSlot = 0;

  constructor(
    private readonly token: string,
    userAgent: string,
    options: DiscogsClientOptions = {},
  ) {
    this.headers = { "User-Agent": userAgent };
    if (token) this.headers.Authorization = `Discogs token=${token}`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.minIntervalMs = options.minIntervalMs ?? (token ? 1000 : 2400);
    this.maxRetries = options.maxRetries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  /**
   * Wait for this request's turn. JavaScript runs one callback at a time, so reading
   * and updating `nextSlot` before the first `await` can't race: no lock needed.
   */
  private async throttle(): Promise<void> {
    const now = performance.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    if (start > now) await sleep(start - now);
  }

  async get<T>(path: string, params: Params = {}): Promise<T> {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let resp: Response;
      try {
        resp = await this.fetch(url, {
          headers: this.headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // Network failure or timeout: make it a DiscogsError so callers handle one type.
        throw new DiscogsError(`Couldn't reach Discogs (${path}): ${errorMessage(e)}`);
      }
      if (resp.status === 429 && attempt < this.maxRetries) {
        // Back off: Discogs' window is a moving 60 seconds.
        const retryAfter = Number(resp.headers.get("Retry-After"));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 10_000 * (attempt + 1));
        continue;
      }
      if (resp.status === 404) throw new DiscogsError(`Not found on Discogs: ${path}`, 404);
      if (resp.status === 429)
        throw new DiscogsError("Discogs rate limit hit; wait a minute and retry.", 429);
      if (!resp.ok)
        throw new DiscogsError(`Discogs returned HTTP ${resp.status} for ${path}`, resp.status);
      return (await resp.json()) as T;
    }
  }

  /** Search the Discogs database for releases. Requires a token. */
  async search(query = "", filters: SearchFilters = {}): Promise<ReleaseSearchResult[]> {
    if (!this.token) throw new DiscogsError("Searching Discogs requires DISCOGS_TOKEN to be set.");
    const { artist, title, catno, barcode, format = "Vinyl", limit = 10 } = filters;
    const data = await this.get<RawSearch>("/database/search", {
      type: "release",
      per_page: limit,
      // `|| undefined` drops empty strings, like the Python version's `if value:`.
      q: query || undefined,
      artist: artist || undefined,
      release_title: title || undefined,
      catno: catno || undefined,
      barcode: barcode || undefined,
      format: format || undefined,
    });
    return (data.results ?? []).map((r) => ({
      release_id: r.id,
      title: r.title ?? null,
      year: r.year ?? null,
      country: r.country ?? null,
      label: r.label?.[0] ?? null,
      catno: r.catno ?? null,
      formats: r.format ?? [],
      thumb: r.thumb ?? null,
    }));
  }

  async getRawRelease(releaseId: number): Promise<RawRelease> {
    return this.get<RawRelease>(`/releases/${releaseId}`);
  }

  async getRelease(releaseId: number): Promise<Release> {
    return toRelease(await this.getRawRelease(releaseId));
  }

  async getMarketStats(releaseId: number, currency = "USD"): Promise<MarketStats> {
    const data = await this.get<RawStats>(`/marketplace/stats/${releaseId}`, {
      curr_abbr: currency,
    });
    return {
      num_for_sale: data.num_for_sale ?? 0,
      lowest_price: data.lowest_price?.value ?? null,
      currency: data.lowest_price?.currency ?? null,
    };
  }

  /** Yield every for-sale listing in a seller's public inventory, 100 per request. */
  async *iterInventory(username: string, maxPages = 100): AsyncGenerator<RawListing> {
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.get<RawInventoryPage>(
        `/users/${encodeURIComponent(username)}/inventory`,
        { status: "For Sale", per_page: 100, page, sort: "listed", sort_order: "desc" },
      );
      yield* data.listings ?? [];
      if (page >= (data.pagination?.pages ?? 1)) return;
    }
  }

  /** One marketplace listing, including the seller's shipping policy. */
  async getListing(listingId: number, currency = "USD"): Promise<RawListing> {
    return this.get<RawListing>(`/marketplace/listings/${listingId}`, { curr_abbr: currency });
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function toRelease(r: RawRelease): Release {
  const label = r.labels?.[0];
  const formats = (r.formats ?? []).map((f) =>
    [f.name ?? "", ...(f.descriptions ?? [])].join(", "),
  );
  const barcodes = (r.identifiers ?? [])
    .filter((i) => i.type === "Barcode")
    .map((i) => (i.value ?? "").replace(/\D/g, ""))
    .filter(Boolean);
  return {
    id: r.id,
    title: r.title ?? "",
    artist: (r.artists ?? []).map((a) => a.name ?? "").join(", "),
    year: r.year || null,
    country: r.country ?? null,
    label: label?.name ?? null,
    catno: label?.catno ?? null,
    formats,
    barcodes: [...new Set(barcodes)],
    thumb: r.thumb ?? null,
    url: r.uri ?? null,
  };
}
