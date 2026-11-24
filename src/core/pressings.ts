import { DiscogsClient } from "./discogs.js";
import type { MarketStats } from "./models.js";
import type { RawVersion } from "./discogs.js";


import type { FileCache } from "./cache.js";
import type { Settings } from "./config.js";


export class PressingsIndex {
    // Implementation for managing pressings for sale goes here.
    private readonly versionsCache: FileCache<RawVersion[]>;
    private readonly statsCache: FileCache<MarketStats>;
    readonly discogs: DiscogsClient;

    constructor(
        readonly settings: Settings,
        versionsCache: FileCache<RawVersion[]>,
        statsCache: FileCache<MarketStats>,
    ) {
        this.versionsCache = versionsCache;
        this.statsCache = statsCache;
        this.discogs = new DiscogsClient(settings.discogsToken, settings.userAgent);
    }

    async versions(masterId: number, refresh = false): Promise<RawVersion[]> {
        return this.versionsCache.getOrFetch(masterId, async () => {
            // Implementation for fetching versions goes here.
            return this.collect(this.discogs.iterVersions(masterId));
        }, refresh);
    }

    async stats(releaseId: number, refresh = false): Promise<MarketStats> {
        return this.statsCache.getOrFetch(releaseId, async () => {
            return this.discogs.getMarketStats(releaseId);
        }, refresh);
    }

    private collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
        return (async () => {
            const results: T[] = [];
            for await (const item of iterable) {
                results.push(item);
            }
            return results;
        })();
    }
}