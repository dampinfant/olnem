#!/usr/bin/env python3
"""
iHeartJane flower price scraper.
Phase 1: Algolia REST (no browser) — find stores near lat/lng.
Phase 2: Playwright (per store) — navigate to boost_menu_url, capture
         jdm_api_key from network, then paginate dmerch/v2/smart via
         page.evaluate (bypasses Cloudflare on dmerch).
Merges into flower_results.csv with source='iheartjane'.

Usage:
    python iheartjane_flower.py [--radius 20mi] [--latlng 33.58,-117.83] [--label "Newport Coast, CA"]
"""

import sys, io, re, os, time, json, csv, argparse, asyncio, uuid, math, urllib.request
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

LATLNG         = "33.58,-117.83"
RADIUS         = "20mi"
MAX_CONCURRENT = 6
PAGE_SIZE      = 60

ALGOLIA_URL = "https://search.iheartjane.com/1/indexes/stores-production/query"
ALGOLIA_KEY = "edc5435c65d771cecbd98bbd488aa8d3"
ALGOLIA_APP = "VFM4X0N23A"
DMERCH_BASE = "https://dmerch.iheartjane.com/v2/smart"

CSV_PATH   = "flower_results.csv"
CSV_FIELDS = ["ppg", "price", "grams", "label", "dist", "product", "brand",
              "dispensary", "on_sale", "updated_at", "source"]

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

WEIGHT_MAP = {
    "half_gram":     (0.5,  "0.5g"),
    "gram":          (1.0,  "1g"),
    "two_gram":      (2.0,  "2g"),
    "eighth_ounce":  (3.5,  "1/8 oz"),
    "quarter_ounce": (7.0,  "1/4 oz"),
    "half_ounce":    (14.0, "1/2 oz"),
    "ounce":         (28.0, "1 oz"),
}

EXCLUDE_RE = re.compile(
    r'\bpre[-\s]?roll\b|\bpreroll\b|\bjoint\b|\bblunt\b'
    r'|\binfused\b|\binfuse\b'
    r'|\blive\s+rosin\b|\bhash\s+rosin\b|\brosin\s*(?:pod|cart)\b'
    r'|\blive\s+resin\b|\bdistillate\b|\bcartridge\b'
    r'|\bvape\s+(?:cart|pod)\b|\bpod\b',
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def haversine_mi(lat1, lng1, lat2, lng2):
    R = 3958.8
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    dφ = math.radians(lat2 - lat1)
    dλ = math.radians(lng2 - lng1)
    a = math.sin(dφ/2)**2 + math.cos(φ1)*math.cos(φ2)*math.sin(dλ/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_radius_miles(radius_str):
    m = re.match(r"(\d+(?:\.\d+)?)\s*(mi|km)?", radius_str.strip(), re.IGNORECASE)
    if not m:
        return 20.0
    val, unit = float(m.group(1)), (m.group(2) or "mi").lower()
    return val if unit == "mi" else val * 0.621371


def dedup_key(r):
    return (
        str(r.get("dispensary", "")).lower().strip(),
        str(r.get("brand", "")).lower().strip(),
        str(round(float(r.get("grams", 0)), 1)),
        str(round(float(r.get("price", 0)), 2)),
    )


# ---------------------------------------------------------------------------
# Phase 1: store discovery via Algolia (pure HTTP, no browser)
# ---------------------------------------------------------------------------

def algolia_search_stores(lat, lng, radius_mi):
    radius_m = int(radius_mi * 1609.34)
    stores = {}
    for page in range(0, 20):
        body = json.dumps({
            "aroundLatLng": f"{lat},{lng}",
            "aroundRadius": radius_m,
            "hitsPerPage":  30,
            "page":         page,
        }).encode()
        req = urllib.request.Request(
            ALGOLIA_URL,
            data=body,
            method="POST",
            headers={
                "X-Algolia-API-Key":        ALGOLIA_KEY,
                "X-Algolia-Application-Id": ALGOLIA_APP,
                "Content-Type":             "application/json",
                "User-Agent":               _UA,
                "Origin":                   "https://iheartjane.com",
                "Referer":                  "https://iheartjane.com/",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except Exception as exc:
            print(f"  Algolia error (page {page}): {exc}")
            break
        hits = data.get("hits", [])
        if not hits:
            break
        for h in hits:
            sid = str(h.get("objectID", ""))
            if not sid:
                continue
            geo  = h.get("_geoloc", {})
            dist = haversine_mi(lat, lng, geo.get("lat", lat), geo.get("lng", lng))
            stores[sid] = {
                "store_id":      int(sid),
                "name":          h.get("name", sid),
                "dist":          round(dist, 2),
                "boost_menu_url": None,
            }
        if len(hits) < 30:
            break
    return stores


def fetch_boost_url(store_id):
    url = f"https://api.iheartjane.com/v1/stores/{store_id}"
    req = urllib.request.Request(url, headers={
        "Accept":     "application/json",
        "User-Agent": _UA,
        "Origin":     "https://iheartjane.com",
        "Referer":    "https://iheartjane.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        return data.get("store", {}).get("boost_menu_url")
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Product parsing
# ---------------------------------------------------------------------------

def rows_from_product(sa, store_name, dist):
    if sa.get("kind") != "flower":
        return []
    name = sa.get("name", "")
    if not name or EXCLUDE_RE.search(name):
        return []
    brand      = sa.get("brand", "")
    has_special = bool(sa.get("applicable_special_ids"))

    out = []
    for w_label in sa.get("available_weights", []):
        w_key = w_label.replace(" ", "_")
        if w_key not in WEIGHT_MAP:
            continue
        grams, label = WEIGHT_MAP[w_key]
        reg_price  = sa.get(f"price_{w_key}")
        disc_price = sa.get(f"discounted_price_{w_key}")
        price = disc_price if disc_price else reg_price
        if not price:
            continue
        try:
            price = float(price)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        ppg     = round(price / grams, 4)
        on_sale = "True" if (has_special and disc_price) else "False"
        out.append(dict(
            ppg=ppg,
            price=price,
            grams=grams,
            label=label,
            dist=dist,
            product=name,
            brand=brand,
            dispensary=store_name,
            on_sale=on_sale,
            updated_at="",
            source="iheartjane",
        ))
    return out


# ---------------------------------------------------------------------------
# Phase 2: per-store Playwright worker
# ---------------------------------------------------------------------------

async def fetch_store(context, store, sem):
    async with sem:
        boost_url = store.get("boost_menu_url")
        store_id  = store["store_id"]
        name      = store["name"]
        dist      = store["dist"]

        if not boost_url:
            return name, dist, 0, [], "no boost_menu_url"

        page = await context.new_page()
        captured = {"key": None}

        def on_request(req):
            if "dmerch.iheartjane.com" in req.url and not captured["key"]:
                m = re.search(r"jdm_api_key=([a-f0-9-]+)", req.url)
                if m:
                    captured["key"] = m.group(1)

        page.on("request", on_request)

        try:
            await page.goto(boost_url, wait_until="domcontentloaded", timeout=45_000)
            await asyncio.sleep(3)

            api_key = captured["key"]
            if not api_key:
                return name, dist, 0, [], "jdm_api_key not captured"

            dmerch_url = (
                f"{DMERCH_BASE}?jdm_api_key={api_key}"
                f"&jdm_source=monolith&jdm_version=2.17.0"
            )
            device = str(uuid.uuid4())
            all_products = []
            seen_ids     = set()
            nb_hits      = None

            for pg in range(0, 50):
                body = json.dumps({
                    "app_mode":          "framelessEmbed",
                    "distinct_id":       f"$device:{device}",
                    "jane_device_id":    device,
                    "search_attributes": ["*"],
                    "store_id":          store_id,
                    "disable_ads":       False,
                    "max_products":      PAGE_SIZE,
                    "num_columns":       5,
                    "page_size":         PAGE_SIZE,
                    "placement":         "menu_inline_table",
                    "search_facets":     [],
                    "search_filter":     "kind:flower",
                    "search_query":      "",
                    "search_sort":       "recommendation",
                    "page":              pg,
                })
                result = await page.evaluate(
                    f"""async () => {{
                        const r = await fetch({json.dumps(dmerch_url)}, {{
                            method: 'POST',
                            headers: {{
                                'Content-Type': 'text/plain',
                                'Accept':       'application/json',
                            }},
                            body: {json.dumps(body)},
                        }});
                        if (!r.ok) return {{__status: r.status}};
                        return await r.json();
                    }}"""
                )
                if not isinstance(result, dict) or "__status" in result:
                    break
                if pg == 0:
                    nb_hits = result.get("nb_hits", 0)
                products = result.get("products", [])
                if not products:
                    break
                new_in_page = 0
                for p in products:
                    oid = p.get("object_id") or p.get("product_id")
                    if oid and oid in seen_ids:
                        continue
                    if oid:
                        seen_ids.add(oid)
                    all_products.append(p)
                    new_in_page += 1
                # Stop if no new products (API is cycling) or we have all
                if new_in_page == 0:
                    break
                if nb_hits and len(all_products) >= nb_hits:
                    break
                if len(products) < PAGE_SIZE:
                    break
                await asyncio.sleep(0.1)

            rows = []
            for p in all_products:
                sa = p.get("search_attributes", {})
                rows.extend(rows_from_product(sa, name, dist))

            return name, dist, len(all_products), rows, None

        except Exception as exc:
            return name, dist, 0, [], str(exc)
        finally:
            await page.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def async_main():
    global LATLNG, RADIUS

    parser = argparse.ArgumentParser()
    parser.add_argument("--radius", default=RADIUS)
    parser.add_argument("--latlng", default=LATLNG)
    parser.add_argument("--label",  default="")
    args   = parser.parse_args()
    RADIUS = args.radius
    LATLNG = args.latlng
    location_display = args.label or LATLNG

    lat_s, lng_s = LATLNG.split(",")
    lat, lng     = float(lat_s), float(lng_s)
    radius_mi    = parse_radius_miles(RADIUS)

    # ── Phase 1: store discovery ─────────────────────────────────────────────
    print(f"Discovering iHeartJane stores ({RADIUS} of {location_display})...")
    stores = algolia_search_stores(lat, lng, radius_mi)
    if not stores:
        print("No stores found.")
        return
    print(f"Found {len(stores)} stores. Fetching boost URLs...")

    for sid, store in stores.items():
        store["boost_menu_url"] = fetch_boost_url(store["store_id"])

    by_dist = sorted(stores.values(), key=lambda s: s["dist"])
    valid   = [s for s in by_dist if s.get("boost_menu_url")]
    skipped_no_url = len(by_dist) - len(valid)
    print(f"{len(valid)}/{len(by_dist)} stores have boost URLs"
          + (f" ({skipped_no_url} skipped)" if skipped_no_url else "") + ":")
    for s in valid:
        print(f"  {s['dist']:4.1f}mi  {s['name']}")

    if not valid:
        print("No actionable stores.")
        return

    # ── Phase 2: parallel Playwright workers ────────────────────────────────
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=_UA,
        )

        n_workers = min(len(valid), MAX_CONCURRENT)
        print(f"\nFetching {len(valid)} menus ({n_workers} concurrent)...")
        sem     = asyncio.Semaphore(n_workers)
        t0      = time.perf_counter()
        tasks   = [fetch_store(context, s, sem) for s in valid]
        results = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - t0
        await browser.close()

    # ── Collect results ──────────────────────────────────────────────────────
    new_rows = []
    n_errors = 0
    for name, dist, item_count, rows, error in results:
        tag = name[:55]
        if error:
            print(f"  ERROR  {tag}: {error}")
            n_errors += 1
        else:
            new_rows.extend(rows)
            print(f"  {tag:<55}  {item_count:>3} items → {len(rows):>4} flower rows")

    print(f"\nMenu fetch: {elapsed:.1f}s  ({n_workers} parallel, {n_errors} errors)")

    if not new_rows:
        print("No flower rows found.")
        return

    new_rows.sort(key=lambda r: r["ppg"])

    # ── Merge into CSV (replace prior iheartjane rows) ───────────────────────
    existing = []
    if os.path.exists(CSV_PATH):
        try:
            with open(CSV_PATH, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("source") != "iheartjane":
                        existing.append(row)
        except Exception:
            pass

    existing_keys = {dedup_key(r) for r in existing}
    added  = [r for r in new_rows if dedup_key(r) not in existing_keys]
    merged = existing + added
    merged.sort(key=lambda r: float(r.get("ppg", 0)))

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(merged)

    print(f"\n{len(added)} new iHeartJane rows + {len(existing)} existing = {len(merged)} total")
    print(f"Saved → {CSV_PATH}")

    hdr = f"{'$/g':>6}  {'Price':>7}  {'Wt':>5}  {'Dist':>4}  {'Product':<44}  {'Brand':<20}  Dispensary"
    print(f"\n{hdr}")
    print("─" * len(hdr))
    for r in added[:40]:
        print(
            f"${float(r['ppg']):>5.2f}  "
            f"${float(r['price']):>6.2f}  "
            f"{float(r['grams']):>3.1f}g  "
            f"{float(r['dist']):>3.1f}mi  "
            f"{r['product'][:44]:<44}  "
            f"{r['brand'][:20]:<20}  "
            f"{r['dispensary']}"
        )
    if len(added) > 40:
        print(f"  … and {len(added) - 40} more")


def main():
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
