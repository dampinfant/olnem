#!/usr/bin/env python3
"""
Weedmaps flower price finder
Sorted by price per gram across nearby dispensaries.

Dispensary menus are fetched in parallel using async Playwright so all menus
download simultaneously rather than sequentially.  Typical refresh time for
10 dispensaries: ~15-20 s.

Install deps:
    pip install playwright
    playwright install chromium
"""

import sys, io, re, time, json, csv, argparse, asyncio
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LATLNG         = "33.58,-117.83"   # Newport Coast, CA
RADIUS         = "20mi"
PRODUCT_PAGES  = 10                # pages × 25 products to collect dispensary slugs
MENU_MAX_PAGES = 20                # max pagination per dispensary menu
MAX_CONCURRENT = 6                 # browser pages fetching menus simultaneously

FLOWER_FILTER = "filter[category_slug]=flower"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# 1g detection
# ---------------------------------------------------------------------------

ONE_GRAM_RE = re.compile(
    r'(?<!\d)1(?:\.0?)?\s*gr(?:m|am)?s?\b'
    r'|\bsingle[\s\-]?gram\b'
    r'|\bper[\s\-]?gram\b'
    r'|\bone[\s\-]?gram\b',
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Non-flower exclusion
# ---------------------------------------------------------------------------

EXCLUDE_RE = re.compile(
    r'\bpre[-\s]?roll\b'
    r'|\bpreroll\b'
    r'|\bjoint\b'
    r'|\bblunt\b'
    r'|\binfused\b'
    r'|\blive\s+rosin\b'
    r'|\bhash\s+rosin\b'
    r'|\brosin\s*(?:pod|cart)\b'
    r'|\blive\s+resin\b'
    r'|\bdistillate\b'
    r'|\bcartridge\b'
    r'|\bvape\s+(?:cart|pod)\b'
    r'|\bpod\b',
    re.IGNORECASE,
)

# ---------------------------------------------------------------------------
# Helpers  (pure Python — no async needed)
# ---------------------------------------------------------------------------

UNIT_GRAM_MAP = {
    "half_gram": 0.5, "gram": 1.0, "two_grams": 2.0,
    "eighth": 3.5, "quarter": 7.0, "half_ounce": 14.0, "ounce": 28.0,
}

_BUCKETS: list[tuple[float, float]] = [
    (0.5, 0.10), (1.0, 0.15), (2.0, 0.20), (3.5, 0.30),
    (7.0, 0.50), (14.0, 1.00), (28.0, 1.50),
]

_LABEL_SNAPS: dict[str, float] = {
    "1/8 oz": 3.5, "1/4 oz": 7.0, "1/2 oz": 14.0, "1 oz": 28.0,
    "half gram": 0.5, "half-gram": 0.5, "gram": 1.0,
}


def normalize_grams(grams: float, label: str) -> float:
    low = label.lower()
    for phrase, std in _LABEL_SNAPS.items():
        if phrase in low:
            return std
    for std, tol in _BUCKETS:
        if abs(grams - std) <= tol:
            return std
    return round(grams, 1)


def is_flower(item: dict) -> bool:
    ec = item.get("edge_category") or {}
    if ec.get("slug") == "flower" or ec.get("name", "").lower() == "flower":
        return True
    for anc in ec.get("ancestors") or []:
        if anc.get("slug") == "flower" or anc.get("name", "").lower() == "flower":
            return True
    cat = item.get("category") or {}
    if isinstance(cat, dict):
        return cat.get("slug", "") in ("flower", "cbd-flower")
    return False


def rows_from_item(item: dict, disp_name: str, dist: float) -> list[dict]:
    if not is_flower(item):
        return []
    name = item.get("name", "")
    if EXCLUDE_RE.search(name):
        return []
    brand      = (item.get("brand_endorsement") or {}).get("brand_name", "")
    prices     = item.get("prices") or {}
    on_sale    = (item.get("price") or {}).get("on_sale", False)
    updated_at = item.get("updated_at", "")
    out        = []

    ounce_list = prices.get("ounce")
    if isinstance(ounce_list, list) and ounce_list:
        for tier in ounce_list:
            price = tier.get("price")
            ppg   = tier.get("gram_unit_price")
            label = tier.get("label", "")
            if price and ppg and ppg > 0:
                raw_grams = price / ppg
                grams = normalize_grams(raw_grams, label)
                out.append(_row(disp_name, dist, name, brand, label, float(price),
                                grams, float(price) / grams, on_sale, updated_at))
        if out:
            return out

    for key, std_grams in UNIT_GRAM_MAP.items():
        tier = prices.get(key)
        if not isinstance(tier, dict):
            continue
        price = tier.get("price")
        if not price or float(price) <= 0:
            continue
        label = tier.get("label", key)
        grams = normalize_grams(std_grams, label)
        ppg   = float(price) / grams
        out.append(_row(disp_name, dist, name, brand, label, float(price),
                        grams, ppg, tier.get("on_sale", on_sale), updated_at))
    if out:
        return out

    unit = prices.get("unit")
    if isinstance(unit, dict) and unit.get("price"):
        price        = float(unit["price"])
        label        = unit.get("label", "each")
        on_sale_unit = unit.get("on_sale", on_sale)
        m = re.search(r"(\d+(?:\.\d+)?)\s*(g(?:ram)?s?|oz)\b", name, re.IGNORECASE)
        if m:
            qty, unit_str = float(m.group(1)), m.group(2).lower()
            grams = qty * 28.3495 if "oz" in unit_str else qty
            if 0.3 <= grams <= 56:
                grams = normalize_grams(grams, label)
                out.append(_row(disp_name, dist, name, brand, label, price,
                                grams, price / grams, on_sale_unit, updated_at))
        elif ONE_GRAM_RE.search(name):
            out.append(_row(disp_name, dist, name, brand, label, price,
                            1.0, price, on_sale_unit, updated_at))
    return out


def _row(disp, dist, name, brand, label, price, grams, ppg, on_sale, updated_at=""):
    return dict(dispensary=disp, dist=dist, product=name, brand=brand,
                label=label, price=price, grams=grams, ppg=ppg, on_sale=on_sale,
                updated_at=updated_at, source="weedmaps")


# ---------------------------------------------------------------------------
# Async Playwright helpers
# ---------------------------------------------------------------------------

async def _api_fetch(page, url: str) -> dict:
    """Run a fetch() call inside the browser page and return the parsed JSON."""
    return await page.evaluate(
        f"""async () => {{
            const r = await fetch({json.dumps(url)}, {{
                headers: {{
                    'Accept': 'application/json',
                    'Origin': 'https://weedmaps.com',
                }}
            }});
            return {{ status: r.status, body: await r.json() }};
        }}"""
    )


async def collect_dispensary_slugs(page, latlng: str, radius: str) -> dict[str, tuple[str, float]]:
    seen: dict[str, tuple[str, float]] = {}
    base = (
        f"https://api-g.weedmaps.com/discovery/v1/products"
        f"?latlng={latlng}&filter[bounding_radius]={radius}&page_size=25"
    )
    for pg in range(1, PRODUCT_PAGES + 1):
        r = await _api_fetch(page, f"{base}&page={pg}")
        products = (r["body"].get("data") or {}).get("products") or []
        if not products:
            break
        for p in products:
            listing = (p.get("variant") or {}).get("listing") or {}
            slug  = listing.get("slug")
            name  = listing.get("name", slug)
            dist  = listing.get("distance") or 999
            state = listing.get("state", "")
            if slug and slug not in seen and state == "California":
                seen[slug] = (name, dist)
        await asyncio.sleep(0.1)
    return seen


async def fetch_flower_menu(page, slug: str) -> list[dict]:
    base = (
        f"https://api-g.weedmaps.com/discovery/v1/listings/dispensaries/{slug}/menu_items"
        f"?{FLOWER_FILTER}&sort_by=position&page_size=24"
    )
    all_items: list[dict] = []
    for pg in range(1, MENU_MAX_PAGES + 1):
        r = await _api_fetch(page, f"{base}&page={pg}")
        items = (r["body"].get("data") or {}).get("menu_items") or []
        if not items:
            break
        all_items.extend(items)
        if len(items) < 24:
            break
        await asyncio.sleep(0.05)   # reduced from 0.15 — async concurrency makes heavy throttling unnecessary
    return all_items


async def fetch_dispensary(context, slug: str, disp_name: str, dist: float,
                           sem: asyncio.Semaphore) -> tuple:
    """
    Acquire a semaphore slot, spin up a dedicated page, navigate to weedmaps.com
    (establishes the correct CORS origin), fetch the full menu, then tear down.
    Returns (disp_name, dist, item_count, rows, error_or_None).
    """
    async with sem:
        page = await context.new_page()
        try:
            await page.goto(
                "https://weedmaps.com/dispensaries",
                wait_until="domcontentloaded",
                timeout=30_000,
            )
            await asyncio.sleep(1.0)   # let page JS settle; shorter than main page (1 s vs 2 s)
            items = await fetch_flower_menu(page, slug)
            rows  = [r for item in items for r in rows_from_item(item, disp_name, dist)]
            listing_url = f"https://weedmaps.com/dispensary/{slug}/menu"
            for r in rows:
                r["listing_url"] = listing_url
            return disp_name, dist, len(items), rows, None
        except Exception as exc:
            return disp_name, dist, 0, [], str(exc)
        finally:
            await page.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def async_main():
    global LATLNG, RADIUS

    parser = argparse.ArgumentParser()
    parser.add_argument("--radius", default=RADIUS,
                        help="Search radius, e.g. '10mi' or '30mi'")
    parser.add_argument("--latlng", default=LATLNG,
                        help="Center point as 'lat,lng', e.g. '34.07,-118.40'")
    parser.add_argument("--label", default="",
                        help="Human-readable location name for console output")
    args             = parser.parse_args()
    RADIUS           = args.radius
    LATLNG           = args.latlng
    location_display = args.label or LATLNG

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=_UA,
        )

        # ── Phase 1: discover dispensary slugs on the main page ──────────────
        main_page = await context.new_page()
        print("Loading Weedmaps...")
        await main_page.goto(
            "https://weedmaps.com/dispensaries",
            wait_until="domcontentloaded",
            timeout=45_000,
        )
        await asyncio.sleep(2)

        print(f"Discovering dispensaries ({RADIUS} of {location_display})...")
        slug_map = await collect_dispensary_slugs(main_page, LATLNG, RADIUS)
        await main_page.close()

        if not slug_map:
            print("No dispensaries found. Try increasing PRODUCT_PAGES or RADIUS.")
            await browser.close()
            return

        by_dist = sorted(slug_map.items(), key=lambda x: x[1][1])
        print(f"Found {len(by_dist)} dispensaries:")
        for slug, (name, dist) in by_dist:
            print(f"  {dist:4.1f}mi  {name}")

        # ── Phase 2: fetch all menus in parallel ─────────────────────────────
        n_workers = min(len(by_dist), MAX_CONCURRENT)
        print(f"\nFetching {len(by_dist)} menus in parallel "
              f"({n_workers} concurrent pages)...")

        sem   = asyncio.Semaphore(n_workers)
        t0    = time.perf_counter()
        tasks = [
            fetch_dispensary(context, slug, name, dist, sem)
            for slug, (name, dist) in by_dist
        ]
        results = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - t0

        await browser.close()

    # ── Collect & report results ─────────────────────────────────────────────
    rows: list[dict] = []
    skipped = 0
    for disp_name, dist, item_count, disp_rows, error in results:
        tag = disp_name[:55]
        if error:
            print(f"  ERROR  {tag}: {error}")
            skipped += 1
        else:
            rows.extend(disp_rows)
            print(f"  {tag:<55}  {item_count:>3} items → {len(disp_rows):>4} rows")

    print(f"\nMenu fetch: {elapsed:.1f}s for {len(by_dist)} dispensaries "
          f"({n_workers} parallel pages)")

    if not rows:
        print(
            "\nNo flower items parsed. Try checking:\n"
            "  • item['prices'] structure — may need a new format handler\n"
            "  • item['edge_category'] — confirm ancestors include Flower"
        )
        return

    rows.sort(key=lambda r: r["ppg"])

    hdr = f"{'$/g':>6}  {'Price':>7}  {'Wt':>6}  {'Dist':>5}  {'Product':<44}  {'Brand':<22}  Dispensary"
    print(f"\n{hdr}")
    print("─" * len(hdr))
    for r in rows:
        print(
            f"${r['ppg']:>5.2f}  "
            f"${r['price']:>6.2f}  "
            f"{r['grams']:>4.1f}g  "
            f"{r['dist']:>4.1f}mi  "
            f"{r['product'][:44]:<44}  "
            f"{r['brand'][:22]:<22}  "
            f"{r['dispensary']}"
        )

    print(f"\n{len(rows)} flower price point(s) across {len(by_dist)} dispensaries "
          f"({skipped} skipped due to errors).")

    csv_path = "flower_results.csv"
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["ppg", "price", "grams", "label", "dist",
                        "product", "brand", "dispensary", "on_sale", "updated_at", "source",
                        "listing_url"],
            extrasaction="ignore",
            restval="",
        )
        writer.writeheader()
        writer.writerows(rows)
    print(f"Saved to {csv_path}")


def main():
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
