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
| `iheartjane_flower.py` | Async Playwright scraper for iHeartJane — merges into `flower_results.csv` with `source=iheartjane` |
| `flower_results.csv` | Generated output, gitignored, recreated on every scrape |
| `location.json` | Persisted last-used lat/lng + label, gitignored |
| `snapshots/` | Timestamped copies of `flower_results.csv` after each scrape cycle (e.g. `snapshots/2024-01-15_14-00.csv`), gitignored |

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
ppg, price, grams, label, dist, product, brand, dispensary, on_sale, updated_at, source, listing_url
```
- `on_sale`: string `"True"` / `"False"` (Python csv.DictWriter convention)
- `source`: `"weedmaps"` | `"leafly"` | `"iheartjane"` | `"dutchie"` (planned)
- `updated_at`: populated by Weedmaps only; empty string for other sources
- `label`: human-readable size (e.g., "1/8 oz", "3.5g"); Leafly uses `normalizedQuantity`
- `listing_url`: direct URL to the dispensary's menu page on the source platform (or the
  dispensary's own website for iHeartJane). Empty string for legacy rows; the UI constructs
  a best-effort fallback from the dispensary name for weedmaps/leafly rows.

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
- `snapshots/` — timestamped CSV snapshots; grows large over time
- `location.json` — user-specific saved location
- `inspect_api.py`, `inspect_leafly.py`, `screenshot_*.py` — one-off dev/debug scripts
- `leafly_api_log.json` — API discovery log
- `*.png` — screenshots
- All home-directory noise (AppData, Documents, etc.)

## iHeartJane scraper (iheartjane_flower.py) — DONE

iHeartJane is architecturally different from Weedmaps/Leafly. Product data lives
behind a per-store secret key (`jdm_api_key`) embedded in each dispensary's website.

### Store discovery (urllib, no Playwright)
```
POST https://search.iheartjane.com/1/indexes/stores-production/query
Headers:
  X-Algolia-API-Key: edc5435c65d771cecbd98bbd488aa8d3
  X-Algolia-Application-Id: VFM4X0N23A
  Content-Type: application/json
  User-Agent: {browser UA}           ← required to avoid 403
  Origin: https://iheartjane.com
Body:
  { "aroundLatLng": "{lat},{lng}", "aroundRadius": {meters},
    "hitsPerPage": 30, "page": 0 }
```
Response: `hits[].{ objectID, name, _geoloc.{lat,lng} }`
`objectID` is the numeric store ID.

```
GET https://api.iheartjane.com/v1/stores/{store_id}
Headers: User-Agent + Origin required (403 without them)
Response: { store: { boost_menu_url, ... } }
```
`boost_menu_url` is the dispensary's own website that hosts the iHeartJane embed.
Stores without a `boost_menu_url` are delivery-only or iHeartJane-native (skipped).

### Per-store menu fetch (Playwright)
```
1. page.goto(store.boost_menu_url)
2. page.on('request') → capture jdm_api_key from first dmerch.iheartjane.com URL
   regex: r'jdm_api_key=([a-f0-9-]+)'
3. Wait 3s for key to fire
4. POST https://dmerch.iheartjane.com/v2/smart
   ?jdm_api_key={key}&jdm_source=monolith&jdm_version=2.17.0
   Content-Type: text/plain  (avoids CORS preflight — key trick)
   Body: { "search_filter": "kind:flower", "max_products": 60,
           "page_size": 60, "page": N, "store_id": {id}, ... }
5. Paginate page=0,1,2,... tracking seen object_id to stop circular responses
```

### Product field mapping
Each product has a `search_attributes` sub-object:
| CSV field | Path |
|---|---|
| `product` | `search_attributes.name` |
| `brand` | `search_attributes.brand` |
| `price` | `search_attributes.discounted_price_{weight}` or `.price_{weight}` |
| `grams` | from weight key: `half_gram`=0.5, `gram`=1, `two_gram`=2, `eighth_ounce`=3.5, `quarter_ounce`=7, `half_ounce`=14, `ounce`=28 |
| `label` | human label for weight key |
| `on_sale` | `"True"` when `applicable_special_ids` non-empty AND `discounted_price_{weight}` exists |

`available_weights` array (e.g. `["eighth ounce"]`) → convert spaces to underscores for price key lookup.

### CORS / header notes
- Raw Python requests to `dmerch.iheartjane.com` → 403 (Cloudflare blocks non-browser UA)
- Raw Python to Algolia/store API → 403 without `User-Agent` + `Origin` headers
- `dmerch` fetch FROM WITHIN Playwright page (page.evaluate) → works fine

### Pagination gotcha
API cycles back to page 0 after exhausting results (doesn't return fewer items).
Stop conditions: `new_in_page == 0` (seen all IDs) OR `len(all) >= nb_hits`.

---

## Dutchie — NOT VIABLE for OC/CA

Dutchie is a B2B cannabis POS/ordering platform. Discovery confirmed:

1. **No California consumer marketplace**: `dutchie.com/dispensaries/california` → 404.
   The consumer marketplace (`dutchie.com`) operates in CO, MA, IL, NJ etc. — not CA.

2. **GraphQL API (dutchie.com/graphql)**: Uses APQ (persisted queries). `filteredDispensaries`
   returns `[]` for all CA cities tested. CSRF requires `x-apollo-operation-name` header
   or `Content-Type: application/json` for POST.

3. **Embedded API (plus.dutchie.com/plus/2021-07/graphql)**: Requires `retailerId: ID!`
   (MongoDB ObjectID). The schema is: `menu(retailerId, filter: MenuFilter, menuType,
   pagination: Pagination)`. `ProductsFilterInput` and `PaginationInput` are wrong names.
   `MenuFilter` and `Pagination` are correct.

4. **No OC dispensaries use Dutchie Plus embeds**: Checked The Artist Tree, Farmacy,
   Catalyst, Planet 13, Blaze — none embed Dutchie. iHeartJane, Weedmaps, and Leafly
   dominate the OC/SoCal market.

If Dutchie presence expands to CA in the future, the scraper would need:
- A list of `retailerId`s (extracted from dispensary embed scripts)
- The `plus.dutchie.com/plus/2021-07/graphql` menu API (no Playwright needed for the call itself)

---

## Adding a new scraper (pattern)
To add a future source (e.g. `dutchie_flower.py`):
1. Use `inspect_*.py` Playwright script to find endpoints
2. Write scraper with same CLI args: `--radius`, `--latlng`, `--label`
3. Output rows with all 11 CSV fields, `source="dutchie"`
4. Merge into `flower_results.csv` using same dedup key pattern
5. Add `SCRAPER_DT` to `serve.py`, append to `_run_scraper` sequence
6. Add source filter pill + badge CSS to `index.html`
