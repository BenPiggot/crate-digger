import type { DiscogsClient, RawRelease } from "./discogs.js";
import type { MarketStats } from "./models.js";
import type { PressingClues } from "./identify.js";
import type { RawVersion } from "./discogs.js";

import type { FileCache } from "./cache.js";
import type { Settings } from "./config.js";

export class PressingsIndex {
    // Implementation for managing pressings for sale goes here.
    private readonly versionsCache: FileCache<RawVersion[]>;
    private readonly statsCache: FileCache<MarketStats>;
    private readonly releasesCache: FileCache<RawRelease>;

    constructor(
        readonly discogs: DiscogsClient,
        readonly settings: Settings,
        versionsCache: FileCache<RawVersion[]>,
        statsCache: FileCache<MarketStats>,
        releasesCache: FileCache<RawRelease>,
    ) {
        this.versionsCache = versionsCache;
        this.statsCache = statsCache;
        this.releasesCache = releasesCache;
    }

    async versions(masterId: number, options: { refresh?: boolean } = {}): Promise<RawVersion[]> {
        return this.versionsCache.getOrFetch(
            masterId,
            async () => {
                // Implementation for fetching versions goes here.
                return this.collect(this.discogs.iterVersions(masterId, { format: "Vinyl" }));
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

    async releases(releaseId: number, refresh = false): Promise<RawRelease> {
        return await this.releasesCache.getOrFetch(
            releaseId,
            () => {
                return this.discogs.getRawRelease(releaseId);
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

export function prefilter(versions: RawVersion[], clues: PressingClues): RawVersion[] {
    return versions.filter((version) => {
        if (clues.format && !version?.format?.includes(clues.format)) return false;
        if (clues.country && version?.country !== clues.country) return false;
        if (clues.year && version?.released !== clues.year) return false;
        return true;
    });
}
