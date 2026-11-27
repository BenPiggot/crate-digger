import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CrateDigger, InvalidInputError } from "../core/service.js";
import { settingsFromEnv } from "../core/config.js";
import {
    formatReleases,
    formatCopies,
    formatMarketOverview,
    formatSellerInventories,
    formatCopyDetails,
    formatPressingsForSale,
    formatPressingIdentification,
} from "./format.js";
import { safe } from "./clean.js";

export function createServer(): McpServer {
    const server = new McpServer({
        name: "crate-digger-server",
        version: "1.0.0",
    });

    const _settings = settingsFromEnv(process.env, { loadDotenv: true });
    const digger = new CrateDigger(_settings);

    server.registerTool(
        "search_releases",
        {
            description:
                "Search Discogs for vinyl releases (specific pressings). " +
                "Returns candidates with release_id, title, year, country, label and catalog number. " +
                "Use catno or barcode to pin down an exact pressing.",
            inputSchema: {
                query: z.string().optional(),
                artist: z.string().optional(),
                title: z.string().optional(),
                catno: z.string().optional(),
                barcode: z.string().optional(),
                limit: z.number().int().min(1).max(100).default(10),
            },
        },
        safe(async ({ query, artist, title, catno, barcode, limit }) => {
            const data = await digger.searchReleases(query ?? "", {
                artist,
                title,
                catno,
                barcode,
                limit,
            });
            return formatReleases(data);
        }),
    );

    server.registerTool(
        "get_market_overview",
        {
            description:
                "Release details plus Discogs' aggregate marketplace stats (copies for sale, lowest price).",
            inputSchema: {
                release_id: z.number().int().min(1),
            },
        },
        safe(async ({ release_id }) => {
            const data = await digger.marketOverview(release_id);
            return formatMarketOverview(release_id, data.release, data.discogs_market);
        }),
    );

    server.registerTool(
        "find_copies",
        {
            description:
                "List copies of a Discogs release for sale, with price, condition and shipping terms. " +
                "It only searches the given sellers' inventories, not all of Discogs. " +
                "Sources: the public inventories of the given Discogs `sellers` (usernames, e.g. record stores; defaults to the configured list). " +
                "Discogs copies are always the exact pressing and include media and sleeve grading, ships-from country, seller rating, the seller's shipping policy and a link. " +
                "Set refresh=true to rescan inventories instead of using the cache. Exact matches are listed first, cheapest first. ",
            inputSchema: {
                release_id: z.number().int().min(1),
                sellers: z.array(z.string()).optional(),
                max_price: z.number().optional(),
                refresh: z.boolean().default(false),
                limit: z.number().int().min(1).max(100).default(50),
                with_details: z.boolean().default(true),
            },
        },
        safe(async ({ release_id, sellers, max_price, refresh, limit, with_details }) => {
            const data = await digger.findCopies(release_id, {
                sellers,
                maxPrice: max_price,
                refresh,
                limit,
                withDetails: with_details,
            });
            return formatCopies(data.copies, data.sellers_searched, data.note);
        }),
    );

    server.registerTool(
        "refresh_seller_inventories",
        {
            description:
                "Re-scan Discogs sellers' inventories now and cache them. Returns listings scanned per seller.",
            inputSchema: {
                sellers: z.array(z.string()),
            },
        },
        safe(async ({ sellers }) => {
            const data = await digger.refreshSellers(sellers);
            return formatSellerInventories(data);
        }),
    );

    server.registerTool(
        "get_copy_details",
        {
            description:
                "Full details for one listing: a numeric Discogs listing id. " +
                "Discogs copies include media and sleeve grading, ships-from country, seller rating, the seller's shipping policy and a link.",
            inputSchema: {
                item_id: z.string(),
            },
        },
        safe(async ({ item_id }) => {
            const data = await digger.copyDetails(item_id);
            return formatCopyDetails(data);
        }),
    );

    server.registerTool(
        "find_pressings_for_sale",
        {
            description:
                "Find all pressings for sale for a given release. Returns a list of copies with details such as price, condition, and seller information. " +
                "Per-copy details aren't available through the API, and that the link is where to see individual copies.",
            inputSchema: {
                release_id: z.number().int().min(1),
                format: z.string().optional(),
                country: z.string().optional(),
                year: z.string().optional(),
                max_price: z.number().optional(),
                refresh: z.boolean().default(false),
                limit: z.number().int().min(1).max(100).default(50),
                with_details: z.boolean().default(true),
            },
        },
        safe(
            async ({
                release_id,
                max_price,
                format,
                country,
                year,
                refresh,
                limit,
                with_details,
            }) => {
                const data = await digger.findPressingsForSale(release_id, {
                    maxPrice: max_price,
                    format,
                    country,
                    released: year,
                    refresh,
                    limit,
                    withDetails: with_details,
                });
                return formatPressingsForSale(data);
            },
        ),
    );

    server.registerTool(
        "identify_pressing",
        {
            description:
                "Work out which exact pressing (Discogs release) a physical record is, from what's printed or etched on its barcode, runout, " +
                "and other identifying details such whether the pressing was a promo, white label, acetate, or special edition. " +
                "In the case where a clear match is found, return the matching release details. In the case where no clear match is found, " +
                "return the closest matches and a distinguishing check to narrow down the candidates.",
            inputSchema: {
                master_id: z.number().int().min(1).optional(),
                release_id: z.number().int().min(1).optional(),
                format: z
                    .string()
                    .optional()
                    .describe("The format of the pressing, e.g., 'vinyl', 'CD', 'cassette'."),
                country: z.string().optional().describe("The country of the pressing."),
                year: z
                    .string()
                    .optional()
                    .describe("Only if printed on the record or sleeve; don't guess."),
                label: z.string().optional().describe("The label of the pressing."),
                catno: z.string().optional().describe("The catalog number of the pressing."),
                barcode: z.string().optional().describe("The barcode of the pressing."),
                runout: z
                    .string()
                    .optional()
                    .describe(
                        "Text etched in the runout area near the label, copied exactly as read, including spaces and symbols",
                    ),
                details: z
                    .string()
                    .optional()
                    .describe(
                        "Other identifying details, such as whether the pressing is a promo, white label, acetate, or special edition.",
                    ),
            },
        },
        safe(
            async ({
                release_id,
                master_id,
                format,
                country,
                year,
                label,
                catno,
                barcode,
                runout,
                details,
            }) => {
                const target =
                    master_id !== undefined
                        ? { masterId: master_id }
                        : release_id !== undefined
                          ? { releaseId: release_id }
                          : undefined;

                if (target === undefined) {
                    throw new InvalidInputError("Either master_id or release_id must be provided.");
                }
                const clues = { format, country, year, label, catno, barcode, runout, details };
                const data = await digger.identifyPressing(target, clues);
                return formatPressingIdentification(data, clues);
            },
        ),
    );
    return server;
}
