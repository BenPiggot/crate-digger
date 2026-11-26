/** Settings loaded from environment variables (or a local .env file). */

export interface Settings {
    readonly discogsToken: string;
    readonly currency: string;
    readonly userAgent: string;
    /** Default sellers to search, e.g. favorite record stores. */
    readonly discogsSellers: readonly string[];
    readonly cacheDir: string;
    readonly inventoryTtlHours: number;
    readonly versionsTtlHours: number;
    readonly releasesTtlHours: number;
    readonly statsTtlHours: number;
    /** 100 listings per page. */
    readonly maxInventoryPages: number;
    readonly maxPressingsChecked: number;
}

export const DEFAULT_SETTINGS: Settings = {
    discogsToken: "",
    currency: "USD",
    userAgent: "crate-digger/0.1 +https://github.com/BenPiggot/crate-digger",
    discogsSellers: [],
    cacheDir: "~/.cache/crate-digger",
    inventoryTtlHours: 12,
    maxInventoryPages: 100,
    statsTtlHours: 3,
    versionsTtlHours: 24,
    releasesTtlHours: 24,
    maxPressingsChecked: 25,
};

/** Build settings for tests or callers that don't read the environment. */
export function makeSettings(overrides: Partial<Settings> = {}): Settings {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

export function parseSellers(value: string | undefined): string[] {
    return (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function numberFrom(value: string | undefined, fallback: number, name: string): number {
    if (value === undefined || value.trim() === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
    return n;
}

/**
 * Read settings from the environment. Loads `.env` from the working directory first
 * (if there is one); variables already set in the environment win over the file.
 */
export function settingsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
    { loadDotenv = true } = {},
): Settings {
    if (loadDotenv) {
        try {
            process.loadEnvFile();
        } catch {
            // No .env file: that's fine.
        }
    }
    return {
        discogsToken: env.DISCOGS_TOKEN ?? DEFAULT_SETTINGS.discogsToken,
        currency: env.CURRENCY || DEFAULT_SETTINGS.currency,
        userAgent: env.USER_AGENT || DEFAULT_SETTINGS.userAgent,
        discogsSellers: parseSellers(env.DISCOGS_SELLERS),
        cacheDir: env.CACHE_DIR || DEFAULT_SETTINGS.cacheDir,
        inventoryTtlHours: numberFrom(
            env.INVENTORY_TTL_HOURS,
            DEFAULT_SETTINGS.inventoryTtlHours,
            "INVENTORY_TTL_HOURS",
        ),
        maxInventoryPages: numberFrom(
            env.MAX_INVENTORY_PAGES,
            DEFAULT_SETTINGS.maxInventoryPages,
            "MAX_INVENTORY_PAGES",
        ),
        versionsTtlHours: numberFrom(
            env.VERSIONS_TTL_HOURS,
            DEFAULT_SETTINGS.versionsTtlHours,
            "VERSIONS_TTL_HOURS",
        ),
        statsTtlHours: numberFrom(
            env.STATS_TTL_HOURS,
            DEFAULT_SETTINGS.statsTtlHours,
            "STATS_TTL_HOURS",
        ),

        releasesTtlHours: numberFrom(
            env.RELEASES_TTL_HOURS,
            DEFAULT_SETTINGS.releasesTtlHours,
            "RELEASES_TTL_HOURS",
        ),
        maxPressingsChecked: numberFrom(
            env.MAX_PRESSINGS_CHECKED,
            DEFAULT_SETTINGS.maxPressingsChecked,
            "MAX_PRESSINGS_CHECKED",
        ),
    };
}
