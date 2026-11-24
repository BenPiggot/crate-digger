import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expandHome } from "./inventory.js";

interface Cached<T> {
    value: T;
    /** Epoch ms. */
    fetched_at: number;
}

export class FileCache<T> {
    private readonly memory = new Map<string, Cached<T>>();

    constructor(
        private readonly dir: string,
        private readonly prefix: string, // "versions" or "stats"
        private readonly ttlMs: number,
    ) {
        this.dir = expandHome(dir);
    }

    private path(key: string | number): string {
        return `${this.dir}/${this.prefix}_${key}.json`;
    }

    private async load(key: string | number): Promise<Cached<T> | null> {
        const remembered = this.memory.get(String(key));
        if (remembered) return remembered;
        try {
            const data = JSON.parse(await readFile(this.path(key), "utf8")) as Cached<T>;
            if (typeof data.value === "undefined" || typeof data.fetched_at !== "number")
                return null;
            this.memory.set(String(key), data);
            return data;
        } catch {
            return null; // missing or corrupt cache: just rescan
        }
    }
    private async save(key: string | number, value: T): Promise<void> {
        const cached: Cached<T> = { value, fetched_at: Date.now() };
        try {
            await mkdir(this.dir, { recursive: true });
            await writeFile(this.path(key), JSON.stringify(cached), "utf8");
        } catch {
            // caching is best-effort
        }
    }

    /** Cached value if fresh; otherwise fetch, save and return it. Falls back to stale data if the fetch fails. */
    async getOrFetch(key: string | number, fetch: () => Promise<T>, refresh = false): Promise<T> {
        const cached = await this.load(key);
        if (cached && !refresh && Date.now() - cached.fetched_at < this.ttlMs) {
            return cached.value;
        }
        try {
            const value = await fetch();
            await this.save(key, value);
            return value;
        } catch (e) {
            if (cached) {
                return cached.value; // serve stale data rather than nothing
            }
            throw e;
        }
    }
}
