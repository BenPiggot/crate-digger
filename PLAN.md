# crate-digger: TypeScript port plan

## Goals

1. Port crate-digger from Python to TypeScript.
2. Learn MCP by writing the TypeScript MCP server by hand.
3. Add a "find every pressing" tool that uses only the official Discogs API.

## Who does what

| Step | Owner | Notes |
|---|---|---|
| 1. Project setup | Claude | `tsconfig`, build/run scripts, lint, test runner, CI |
| 2. Port the core | Claude writes, Ben reviews | Read every file. Ask about any idiom that isn't clear. |
| 3. MCP server | **Ben** | Claude explains and reviews but doesn't write this code |
| 4. Hybrid "every pressing" tool | **Ben**, Claude helps with core functions | Ben designs the tool's inputs and outputs |
| 5. Web backend | Claude writes, Ben reviews | Same routes and response shapes so `index.html` keeps working |
| 6. Frontend | Optional, later | The plain `index.html` works as it is |

**Notes for Claude Code:** for step 3, don't write the MCP server code. Explain concepts, point to the SDK docs and review Ben's code. The Python version stays in git history as a reference until the TypeScript version matches it.

## Current architecture (Python)

```
   Claude / Cursor            Browser
         │                       │
   mcp_server.py          web.py + static/index.html
         │                       │
         └──────────┬────────────┘
                    ▼
         service.py (CrateDigger)
   discogs.py · inventory.py · models.py · config.py
                ebay.py (unused: no keys)
```

The MCP server and web app are separate thin layers on the same core. Neither depends on the other.

## Decisions

- **Discogs only.** eBay is not ported. The core uses a `ListingSource` interface so eBay can be added later as a second implementation, written and tested against the live API once there are keys.
- **No scraping.** Individual marketplace listings for a release aren't available through the API. The hybrid tool links to the Discogs marketplace page for the final step.
- **The UI never mentions eBay.**

## Step 2: core port

Port `config`, `models`, `discogs`, `inventory` and `service` to TypeScript.

```ts
interface ListingSource {
  name: string;
  configured: boolean;
  findCopies(release: Release, opts: SearchOptions): Promise<Copy[]>;
}
```

- The first implementation is Discogs seller inventories (from `inventory.py`).
- `CrateDigger.findCopies` loops over the configured sources.
- Port the existing tests in `tests/test_service.py` along with the core.

## Step 3: MCP server

Use the official TypeScript SDK (`@modelcontextprotocol/sdk`). The SDK has changed a lot, so check the current README and examples in `modelcontextprotocol/typescript-sdk` before starting. Don't rely on older tutorials.

Port the existing tools one at a time, simplest first:

| Tool | Calls |
|---|---|
| `get_market_overview(release_id)` | `/marketplace/stats/{id}` (already in the core) |
| `search_releases(query, catno, barcode)` | Discogs database search |
| `get_copy_details(item_id)` | `/marketplace/listings/{id}` |
| `refresh_seller_inventories(sellers)` | inventory scan |
| `find_copies(release_id, sellers, max_price, refresh)` | the core's `findCopies` |

For each tool, define the inputs with a Zod schema, write the handler that calls the core, and return the result. Use the stdio transport for Claude Desktop and Cursor.

Test with the **MCP Inspector**: call each tool by hand and read the raw requests and responses.

## Step 4: hybrid "every pressing" tool

**Purpose:** for a given album, show which pressings are for sale and their lowest prices, then link to Discogs for the individual listings.

**Flow:**
1. Get the master release. If you start from a release, take `master_id` from `GET /releases/{release_id}`.
2. `GET /masters/{master_id}/versions` lists every pressing. It's paginated, so follow `pagination.pages`. Supports filters like `format` (e.g. Vinyl), `country` and `released`.
3. For each pressing: `GET /marketplace/stats/{release_id}?curr_abbr=USD` returns `num_for_sale` and `lowest_price`.
4. Filter: `num_for_sale > 0`, optional `max_price`, and optional format, country and year.
5. Return one row per pressing: release id, label and catno, country, year, format, `num_for_sale`, `lowest_price`, and a link to `https://www.discogs.com/sell/release/{release_id}`.

**Tool sketch** (Ben finalizes this):
`find_pressings_for_sale(master_id | release_id, max_price?, format?, country?, year_range?)`

**Constraints:**
- Rate limit: about 60 requests a minute with a personal token. An album with 80 pressings takes 1–2 minutes when not cached.
- Cache stats per release (a few hours' TTL) and version lists (a day or more).
- Throttle requests, and back off on HTTP 429.

**Possible later addition:** a targeted scraper for listing rows on the shortlisted pressings only. Not planned now, because of the Discogs terms and the risk to the seller account.

## Step 5: web backend

Port `web.py`'s three routes (`/api/releases`, `/api/config`, `/api/releases/:id/copies`) to Express, Fastify or Hono, keeping the response shapes. Remove `ebay_configured` from `/api/config` once the UI no longer reads it.

## Done when

- [ ] All five existing MCP tools work in TypeScript and are tested in the MCP Inspector
- [ ] `find_pressings_for_sale` works in Claude Desktop
- [ ] Web UI works against the TypeScript backend
- [ ] README updated: Discogs-first, TypeScript, new tool documented
- [ ] Python code removed