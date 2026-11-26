# crate-digger

Find copies of a **specific vinyl pressing** for sale on Discogs: which pressings of an album are for sale and from what price, and copies of an exact pressing at the record stores you follow, with price, media and sleeve condition, and shipping terms.

crate-digger runs two ways from the same TypeScript core:

- **MCP server**: tools an LLM (Claude Desktop, Claude Code, or any MCP client) can call, e.g. _"Which pressings of Remarc's 'R.I.P. / Ice Cream & Syrup' are for sale?"_
- **Web UI**: a small local page. Search for a record, pick the exact pressing, and get a sortable table of copies from your chosen sellers.

![crate-digger web UI, shown with sample data](screenshot.png)

## How it works

```
 search_releases ─────────► Discogs database ──► exact pressing (release_id)
                                                         │
 find_pressings_for_sale ────────────────────────────────┤
                                                         ├─► the release's master ──► every version (pressing)
                                                         │     1. filter by format (vinyl by default), country, year
                                                         │     2. check the most common pressings first (capped)
                                                         │     3. marketplace stats per pressing: copies for sale, lowest price
                                                         │
 find_copies ────────────────────────────────────────────┤
                                                         ├─► Discogs marketplace stats (count, lowest price)
                                                         └─► chosen sellers' public inventories
                                                               1. scan each inventory (100 listings/request, cached on disk)
                                                               2. keep listings of this exact release
                                                               3. fetch each match: seller rating + shipping policy
```

### The API constraint, and the workaround

The Discogs API has release data and aggregate stats, but **no endpoint that lists every copy for sale of a release**. That list only exists on discogs.com, and scraping it breaks Discogs' terms of use. crate-digger works within the API in two ways:

- **Across all of Discogs, per pressing** (`find_pressings_for_sale`): for every pressing of an album, how many copies are for sale and the lowest price, with a link to the Discogs page that lists the individual copies.
- **Per copy, at chosen sellers** (`find_copies`): each seller's public inventory is available through the API, with price, media and sleeve condition, ships-from country and the seller's shipping policy. crate-digger searches the sellers you choose (your favorite record stores, say) for the exact release.

Along the way:

- **Exact pressings only.** Inventory listings are tied to a Discogs release ID, so there's no fuzzy matching.
- **Rate-limit aware.** Requests are spaced to stay under Discogs' 60/minute limit, and 429 responses are retried with backoff.
- **Cached.** Seller inventory scans (12 hours), version lists (24 hours) and marketplace stats (3 hours) are saved to disk and reused, so repeat searches are fast. All lifetimes are configurable.
- **Resilient.** An unknown seller, a failed refresh or a failed stats request is reported in the results and doesn't stop the search. Stale cached data is used if a refresh fails.

## Setup

Requires Node.js 22.12 or later.

```bash
git clone https://github.com/BenPiggot/crate-digger && cd crate-digger
npm install
cp .env.example .env   # then add your Discogs token
npm run build
```

| Setting                                                         | What it is                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `DISCOGS_TOKEN`                                                 | **Required.** discogs.com → Settings → Developers → _Generate new token_                                     |
| `DISCOGS_SELLERS`                                               | Default sellers to search, comma-separated Discogs usernames. You can also pass sellers per search.          |
| `CURRENCY`                                                      | Currency for prices (default `USD`)                                                                          |
| `INVENTORY_TTL_HOURS`, `VERSIONS_TTL_HOURS`, `STATS_TTL_HOURS`  | Cache lifetimes for seller inventories (default 12), version lists (default 24) and marketplace stats (default 3) |
| `MAX_INVENTORY_PAGES`                                           | Scan cap per seller (default 100 pages = 10,000 listings)                                                    |
| `MAX_PRESSINGS_CHECKED`                                         | How many pressings `find_pressings_for_sale` checks, most common first (default 25)                          |
| `CACHE_DIR`                                                     | Cache location (default `~/.cache/crate-digger`)                                                             |
| `USER_AGENT`                                                    | User agent sent to Discogs                                                                                   |

## Run the web UI

```bash
npm run web          # http://127.0.0.1:8000
npm run dev:web      # same, restarting on every file change
```

Enter seller usernames in the page (they're remembered in your browser), search for a record, and pick the pressing.

JSON endpoints are also available:

- `GET /api/releases?q=...&catno=...&barcode=...`
- `GET /api/releases/{id}/copies?sellers=a,b&max_price=...&refresh=false&with_details=true`
- `GET /api/config`

Errors come back as HTTP 400 with `{ "detail": "..." }`.

## Use as an MCP server

Build first (`npm run build`), then add it to your MCP client. For Claude Desktop, in `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "crate-digger": {
            "command": "node",
            "args": [
                "--env-file=/absolute/path/to/crate-digger/.env",
                "/absolute/path/to/crate-digger/dist/mcp.js"
            ]
        }
    }
}
```

`--env-file` loads your token and settings from `.env`, so they don't need to be copied into the client config. If `node` comes from a version manager such as nvm, use the full path to `node`, since Claude Desktop doesn't see your shell's `PATH`.

For Claude Code:

```bash
claude mcp add crate-digger -- node --env-file=/absolute/path/to/crate-digger/.env /absolute/path/to/crate-digger/dist/mcp.js
```

To try the tools by hand, use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node --env-file-if-exists=.env dist/mcp.js
```

### Tools

| Tool                                                                    | What it does                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_releases(query, artist, title, catno, barcode)`                 | Find candidate pressings on Discogs                                                                                                                                      |
| `get_market_overview(release_id)`                                       | Release details + Discogs copies-for-sale count and lowest price                                                                                                         |
| `find_pressings_for_sale(release_id, format, country, year, max_price)` | Every pressing of the release's album with copies for sale: count, lowest price and a link to the copies on Discogs. Vinyl by default; reports how many pressings were checked |
| `find_copies(release_id, sellers, max_price, refresh)`                  | Copies of the exact pressing from the chosen sellers: price, media/sleeve grading, ships-from, seller rating, shipping policy, link                                      |
| `refresh_seller_inventories(sellers)`                                   | Rescan sellers now to warm the cache                                                                                                                                     |
| `get_copy_details(item_id)`                                             | Full details for one Discogs listing                                                                                                                                     |

## Development

```bash
npm test          # Vitest; all Discogs calls go through a mocked fetch, so tests run offline with no token
npm run check     # typecheck, lint, format check and tests (what CI runs)
npm run format    # format with Prettier
```

## Project layout

```
src/
  core/              shared logic, used by both front ends
    discogs.ts         Discogs API client (rate limiting, retries, pagination)
    inventory.ts       seller inventory scanning + on-disk cache
    pressings.ts       a master's versions and per-pressing market stats
    cache.ts           generic on-disk cache with expiry
    listing-source.ts  interface for places copies come from
    service.ts         orchestration (CrateDigger), shared by both front ends
    models.ts          data shapes returned to the MCP tools and the web UI
    config.ts          settings from environment variables
  mcp/               MCP server: tool definitions and text formatting
  mcp.ts             MCP entry point (stdio)
  web/               Fastify app: JSON API + the page
  web.ts             web entry point
static/index.html    the UI (no build step)
tests/               Vitest tests
```

## Limits and ideas

- `find_copies` searches only the sellers you choose, not all of Discogs. Per-copy details for every seller aren't available through the API, so `find_pressings_for_sale` links to the Discogs page for individual copies.
- The lowest price excludes shipping, and the cheapest copy may not ship to you. Shipping depends on the buyer's location, so crate-digger shows each seller's shipping policy rather than a single number.
- Planned (see [PLAN.md](PLAN.md)): identifying the exact pressing from a description of the record (label details, matrix/runout etchings) and a chat panel in the web UI that answers questions using these tools.
- Ideas: price-drop alerts for a wantlist, suggesting sellers from a release's past listings, currency conversion, deploying the UI.

## License

MIT
