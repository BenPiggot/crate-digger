# crate-digger

Find every copy of a **specific vinyl pressing** that's for sale, with price, condition, and shipping for each copy.

crate-digger runs two ways from the same core:

- **MCP server**: tools an LLM (Claude Desktop, Claude Code, or any MCP client) can call, e.g. *"Find me an original UK pressing of OK Computer under $150 and show me the cheapest one with returns."*
- **Web UI**: a small local page. Search for a record, pick the exact pressing, and get a sortable table of copies.

![crate-digger web UI](screenshot.png)

## How it works

```
 search_releases ──► Discogs database ──► exact pressing (release_id, catno, barcode)
                                                   │
 find_copies ──────────────────────────────────────┤
                                                   ├─► Discogs marketplace stats (count, lowest price)
                                                   └─► eBay Browse API
                                                         1. search by UPC barcode (precise)
                                                         2. else search artist + title, flag catno matches
                                                         3. fetch each listing's grading, shipping, returns
```

**Why eBay for the listings?** The Discogs API gives release data and aggregate marketplace stats, but it does not expose the list of individual listings for a release. That list only exists on discogs.com, and scraping it breaks Discogs' terms of use. eBay's Browse API returns each copy with its price, condition, and shipping, so crate-digger uses Discogs to identify the pressing and eBay to find the copies.

## Setup

```bash
git clone https://github.com/<you>/crate-digger && cd crate-digger
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # then fill in your keys
```

You need two free sets of credentials:

| Key | Where |
|---|---|
| `DISCOGS_TOKEN` | discogs.com → Settings → Developers → *Generate new token* |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | developer.ebay.com → create an app → *Production* keyset (App ID and Cert ID) |

## Run the web UI

```bash
crate-digger-web          # http://127.0.0.1:8000
```

JSON endpoints are also available: `GET /api/releases?q=...&catno=...` and `GET /api/releases/{id}/copies?max_price=...`. Interactive docs are at `/docs`.

## Use as an MCP server

Add to your MCP client config (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "crate-digger": {
      "command": "/absolute/path/to/crate-digger/.venv/bin/crate-digger-mcp",
      "env": {
        "DISCOGS_TOKEN": "...",
        "EBAY_CLIENT_ID": "...",
        "EBAY_CLIENT_SECRET": "..."
      }
    }
  }
}
```

For Claude Code: `claude mcp add crate-digger -- /absolute/path/.venv/bin/crate-digger-mcp`. Credentials are read from `.env` in the working directory or from the environment.

### Tools

| Tool | What it does |
|---|---|
| `search_releases(query, artist, title, catno, barcode)` | Find candidate pressings on Discogs |
| `get_market_overview(release_id)` | Release details + Discogs copies-for-sale count and lowest price |
| `find_copies(release_id, max_price, limit, with_details)` | Every copy on eBay: price, shipping, total, record/sleeve grading, ships-from, seller, returns, link |
| `get_copy_details(item_id)` | Full details for one listing |

## Tests

```bash
pytest
```

All HTTP calls are mocked with `respx`, so tests run offline with no keys.

## Project layout

```
src/crate_digger/
  discogs.py      Discogs API client
  ebay.py         eBay Browse API client (OAuth client-credentials, search, item details)
  service.py      matching + orchestration, shared by both front ends
  mcp_server.py   MCP tools
  web.py          FastAPI app
  static/index.html  the UI (no build step)
```

## Limits and ideas

- Keyword matches can include other pressings. Listings whose titles mention the catalog number are flagged and sorted first.
- Grading depends on sellers filling in eBay's *Record Grading* and *Sleeve Grading* fields.
- Ideas: more marketplaces, price alerts, caching, currency conversion, deploying the UI.

## License

MIT
