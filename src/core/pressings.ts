import type { DiscogsClient } from "./discogs.js";
import type { MarketStats } from "./models.js";
import type { RawVersion } from "./discogs.js";

import type { FileCache } from "./cache.js";
import type { Settings } from "./config.js";

export class PressingsIndex {
    // Implementation for managing pressings for sale goes here.
    private readonly versionsCache: FileCache<RawVersion[]>;
    private readonly statsCache: FileCache<MarketStats>;

    constructor(
        readonly discogs: DiscogsClient,
        readonly settings: Settings,
        versionsCache: FileCache<RawVersion[]>,
        statsCache: FileCache<MarketStats>,
    ) {
        this.versionsCache = versionsCache;
        this.statsCache = statsCache;
    }

    async versions(masterId: number, options: { refresh?: boolean } = {}): Promise<RawVersion[]> {
        return this.versionsCache.getOrFetch(
            masterId,
            async () => {
                // Implementation for fetching versions goes here.
                return this.collect(this.discogs.iterVersions(masterId, { format: null }));
            },
            options.refresh ?? false,
        );
    }

    async stats(releaseId: number, refresh = false): Promise<MarketStats> {
        return this.statsCache.getOrFetch(
            releaseId,
            async () => {
                return this.discogs.getMarketStats(releaseId, this.settings.currency);
            },
            refresh,
        );
    }

    private async collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
        const results: T[] = [];
        for await (const item of iterable) {
            results.push(item);
        }
        return results;
    }
}
