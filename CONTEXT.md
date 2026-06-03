# Weedmaps Flower Price Finder — Project Context

## What this is
A local tool that scrapes flower (cannabis) prices from dispensaries near any location across multiple platforms (Weedmaps, Leafly — iHeartJane and Dutchie planned), sorts them by $/gram, and serves a filterable web UI. Everything runs locally — no cloud, no accounts.

## Repo location
`C:\Users\tooth` — this is the user's home directory and also the git repo root.

## Files
| File | Purpose |
|---|---|
| `weedmaps_flower.py` | Async Playwright scraper for Weedmaps — outputs to `flower_results.csv` with `source=weedmaps` |
| `leafly_flower.py` | Async Playwright scraper for Leafly — merges into `flower_results.csv` with `source=leafly` |
| `index.html` | Single-page web app — loads CSV via PapaParse, all logic in-browser |
| `serve.py` | Dev server on `127.0.0.1:8080` — static files + 3 API endpoints, runs both scrapers |
| `flower_results.csv` | Generated output, gitignored, recreated on every scrape |
| `location.json` | Persisted last-used lat/lng + label, gitignored |

## How to run
```
cd C:\Users\tooth
python serve.py
```
Opens browser automatically. The server must stay running for the Refresh button to work.

Python executable: `C:\Users\tooth\AppData\Local\Python\pythoncore-3.14-64\python.exe`
Git: `C:\Program Files\Git\cmd\git.exe` (add to PATH if needed)

## CSV schema (flower_results.csv)
All scrapers write to this unified CSV:
```
ppg, price, grams, label, dist, product, brand, dispensary, on_sale, updated_at, source
```
- `on_sale`: string `"True"` / `"False"` (Python csv.DictWriter convention)
- `source`: `"weedmaps"` | `"leafly"` | `"iheartjane"` | `"dutchie"` (planned)
- `updated_at`: populated by Weedmaps only; empty string for other sources
- `label`: human-readable size (e.g., "1/8 oz", "3.5g"); Leafly uses `normalizedQuantity`

## Deduplication key (cross-source merge)
`(dispensary.lower().strip(), brand.lower().strip(), round(grams,1), round(price,2))`
Same dispensary + brand + weight + price = same product, regardless of source.

## Scraper architecture (shared pattern)

### Why Playwright (not requests/aiohttp)
Bot detection on all platforms. The browser navigates to the platform site first to establish a real browser session, then API calls are made via `page.evaluate(fetch(...))` from within the browser context.

### Critical CORS constraint
Worker pages **must** navigate to the target domain before making API calls. The `Origin` header is a forbidden header — the browser sends the actual page origin. A page at `about:blank` sends `Origin: null` and gets CORS-blocked.

### Parallel fetching
Uses `async_playwright` + `asyncio.gather` + `asyncio.Semaphore(6)`. One main page collects dispensary slugs, then up to 6 worker pages fetch menus simultaneously.

## Weedmaps scraper (weedmaps_flower.py)

### API endpoints
```
# Discover dispensary slugs near a location
GET https://api-g.weedmaps.com/discovery/v1/products
    ?latlng={lat},{lng}&filter[bounding_radius]={radius}&page_size=25&page={n}

# Fetch a dispensary's flower menu (paginated, 24/page)
GET https://api-g.weedmaps.com/discovery/v1/listings/dispensaries/{slug}/menu_items
    ?filter[category_slug]=flower&sort_by=position&page_size=24&page={n}
```
No auth required. Headers: `Accept: application/json` only.

### Menu item price formats
Three formats exist in the wild — the scraper handles all of them:
- **Format A**: `prices.ounce` is a list of tiers with `{label, price, gram_unit_price}`
- **Format B**: `prices` has keys `gram`, `eighth`, `quarter`, `half_ounce`, `ounce` etc.
- **Format C**: `prices.unit` is a single pre-packed item; weight parsed from product name

### Fields captured per row
`ppg, price, grams, label, dist, product, brand, dispensary, on_sale, updated_at`

`updated_at` comes directly from the Weedmaps API item — when the dispensary last touched the listing.

## Leafly scraper (leafly_flower.py)

### API endpoints
```
# Dispensary search (uses browser geolocation — set via Playwright)
GET https://www.leafly.com/_next/data/{buildId}/dispensaries/near-me.json?page={n}
    → pageProps.storeLocatorResults.data.{organicStores, sponsoredStores}[]
    → each store: { slug, name, distanceMi, address.{lat,lon,city,state} }

# Menu items (paginated, 18/page)
# Page 1: navigate to URL, extract __NEXT_DATA__
# Pages 2+: fetch via _next/data
GET https://www.leafly.com/_next/data/{buildId}/dispensary-info/{slug}/menu.json?page={n}
    → pageProps.menuData.{ menuItems, totalItems }
    → each item: { name, brandName, price, pricePerUnit, quantity, unit,
                   productCategory, deal, variants[], normalizedQuantity,
                   dispensaryName, dispensarySlug }
```

### Key Leafly details
- `buildId` changes with each deployment — extract fresh from `__NEXT_DATA__` on first page load
- `pricePerUnit` is already $/gram (pre-computed by Leafly)
- `productCategory` can be `"Flower"`, `"PreRoll"`, `"Edible"`, `"Cartridge"`, etc. — filter to Flower only
- Flower items tend to appear first in the menu; early-stop after 3 consecutive non-flower pages
- Page 1 of menu items is baked into `__NEXT_DATA__` at page load time; `?page=1` via `_next/data` returns empty
- Worker page navigates to `https://www.leafly.com/dispensary-info/{slug}/menu` (establishes leafly.com CORS origin)
- If `__NEXT_DATA__` is null (no public menu), return 0 rows silently (not an error)
- geolocation is set at the browser context level via Playwright `permissions: ["geolocation"]`

### Leafly → CSV field mapping
| CSV field | Leafly field |
|---|---|
| `ppg` | `pricePerUnit` |
| `price` | `price` |
| `grams` | `quantity` (when `unit="g"`) |
| `label` | `normalizedQuantity` or `displayQuantity` |
| `product` | `name` |
| `brand` | `brandName` |
| `dispensary` | `dispensaryName` |
| `on_sale` | `"True"` if `deal` or `dealId` is set |

## serve.py

Extends `SimpleHTTPRequestHandler`. Three endpoints on top of normal static file serving:

```
GET  /api/status
     → { running, csv_mtime, error, radius, latlng, location_label }

GET  /api/geocode?q=<query>
     → { lat, lng, display_name }  or  { error }
     Proxies OpenStreetMap Nominatim with proper User-Agent header.

POST /refresh
     body: { radius, latlng, location_label }
     → { status: "started" | "already_running" }
     Runs SCRAPER_WM then SCRAPER_LF sequentially in a background thread.
     Persists latlng + label to location.json.
```

Scraper sequence: Weedmaps first (writes `flower_results.csv`), then Leafly (reads + merges into `flower_results.csv`). Sequential to avoid CSV write conflicts.

## Web UI (index.html)

Single file, no build step. Uses PapaParse (CDN) to load `flower_results.csv`.

### Source filter
Pills: All / Weedmaps / Leafly (more to be added as scrapers are added).
Source badge on each row: `WM` (green) or `LF` (blue).
`on_sale` handled as both string `"True"` (Weedmaps) and boolean `true` (Leafly via dynamicTyping).

### Scoring modes
Two modes toggled by pills:

**Mainstream** (rewards proven distribution):
- Distribution 40 pts — dispensary breadth (normalized to max)
- Variety 20 pts — distinct products (cap 10)
- Consistency 25 pts — low $/g coefficient of variation
- Sale authenticity 15 pts — penalises brands where >30% always on sale

**Craft** (rewards exclusivity + honest pricing):
- Exclusivity 15 pts — full score at 1 dispensary, fades to 0 at 4+
- Variety 25 pts — distinct products (lower cap of 5)
- Consistency 40 pts — tighter CoV penalty
- Sale authenticity 20 pts — same penalty, higher weight

### Fake deal detection
Computed client-side from the CSV, per weight tier:
- **`?SALE`** (yellow badge) — `on_sale=True` but `ppg >= median_ppg_for_that_weight`
- **`⚠LOW`** (red badge) — `ppg < median * 0.5` AND ≥3 data points for that weight tier

### Refresh flow
1. User clicks Refresh or selects a new radius/location
2. UI sends `POST /refresh` with `{ radius, latlng, location_label }`
3. Server spawns both scrapers in background thread (sequential), returns `{ status: "started" }`
4. UI polls `GET /api/status` every 4s
5. When `running` goes false, UI re-fetches the CSV via PapaParse and re-renders in place

### Location search
1. User types address, presses Enter or clicks Search
2. UI calls `GET /api/geocode?q=...` (server proxies Nominatim)
3. On success: updates `currentLatlng` + `currentLocationLabel`, calls `doRefresh()`
4. Input gets `geo-ok` (green border) or `geo-error` (red border) class

## Automation
A Windows Task Scheduler job (`WeedmapsFlowerScraper`) runs the scraper every 3 hours using the real Python at `pythoncore-3.14-64\python.exe`, working directory `C:\Users\tooth`, 20-minute execution limit.
Note: The Task Scheduler job only runs `weedmaps_flower.py`. The Leafly scraper is currently only triggered via the UI Refresh button or manually.

## What's gitignored
- `flower_results.csv` — generated data
- `location.json` — user-specific saved location
- `inspect_api.py`, `inspect_leafly.py`, `screenshot_*.py` — one-off dev/debug scripts
- `leafly_api_log.json` — API discovery log
- `*.png` — screenshots
- All home-directory noise (AppData, Documents, etc.)

## Adding a new scraper (pattern)
To add `iheartjane_flower.py` or `dutchie_flower.py`:
1. Use `inspect_*.py` Playwright script to find endpoints (same discovery pattern as `inspect_leafly.py`)
2. Write scraper with same CLI args: `--radius`, `--latlng`, `--label`
3. Output rows with all 11 CSV fields, `source="iheartjane"` / `source="dutchie"`
4. Merge into `flower_results.csv` using same dedup key pattern
5. Add `SCRAPER_IHJ` / `SCRAPER_DT` to `serve.py`, append to `_run_scraper` sequence
6. Add source filter pill + badge CSS to `index.html`
