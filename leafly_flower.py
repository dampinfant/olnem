#!/usr/bin/env python3
"""
Leafly flower price scraper.
Fetches flower menus from Leafly dispensaries near a given lat/lng, adds
source='leafly', merges with existing flower_results.csv (deduplicating on
dispensary + brand + grams + price), and writes the combined CSV.

Same async/Semaphore pattern as weedmaps_flower.py.

Install deps (same as weedmaps):
    pip install playwright
    playwright install chromium
"""

import sys, io, re, os, time, json, csv, argparse, asyncio
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LATLNG         = "33.58,-117.83"
RADIUS         = "20mi"
PAGE_SIZE      = 18      # Leafly's menu items per page (server constant)
MAX_MENU_PAGES = 50      # hard cap on menu pages per dispensary
NO_FLOWER_STOP = 3       # stop fetching after this many consecutive no-flower pages
DISP_PAGES     = 4       # pages of near-me dispensaries to fetch (30/page)
MAX_CONCURRENT = 6

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

CSV_PATH   = "flower_results.csv"
CSV_FIELDS = ["ppg", "price", "grams", "label", "dist", "product", "brand",
              "dispensary", "on_sale", "updated_at", "source"]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

EXCLUDE_RE = re.compile(
    r'\bpre[-\s]?roll\b|\bpreroll\b|\bjoint\b|\bblunt\b'
    r'|\binfused\b|\binfuse\b'
    r'|\blive\s+rosin\b|\bhash\s+rosin\b|\brosin\s*(?:pod|cart)\b'
    r'|\blive\s+resin\b|\bdistillate\b|\bcartridge\b'
    r'|\bvape\s+(?:cart|pod)\b|\bpod\b',
    re.IGNORECASE,
)


def parse_radius_miles(radius_str: str) -> float:
    m = re.match(r"(\d+(?:\.\d+)?)\s*(mi|km)?", radius_str.strip(), re.IGNORECASE)
    if not m:
        return 20.0
    val, unit = float(m.group(1)), (m.group(2) or "mi").lower()
    return val if unit == "mi" else val * 0.621371


def rows_from_item(item: dict, dist: float) -> list[dict]:
    """Extract one or more price rows from a Leafly menu item."""
    if item.get("productCategory") != "Flower":
        return []
    name = item.get("name", "")
    if EXCLUDE_RE.search(name):
        return []

    brand      = item.get("brandName", "")
    dispensary = item.get("dispensaryName", "")
    if not dispensary:
        return []

    out = []
    variants = item.get("variants") or []
    # Use variants array if it has data; fall back to top-level price fields.
    sources = variants if variants else [item]
    for v in sources:
        price = v.get("price")
        ppg   = v.get("pricePerUnit")
        grams = v.get("quantity")
        if not price or not ppg or not grams:
            continue
        try:
            price = float(price)
            ppg   = float(ppg)
            grams = float(grams)
        except (TypeError, ValueError):
            continue
        if price <= 0 or ppg <= 0 or grams < 0.3 or grams > 60:
            continue
        on_sale = "True" if (v.get("deal") or v.get("dealId")) else "False"
        label   = item.get("normalizedQuantity") or item.get("displayQuantity") or ""
        out.append(dict(
            ppg=round(ppg, 4),
            price=price,
            grams=grams,
            label=label,
            dist=dist,
            product=name,
            brand=brand,
            dispensary=dispensary,
            on_sale=on_sale,
            updated_at="",
            source="leafly",
        ))
    return out


def dedup_key(r: dict) -> tuple:
    """Merge identity: same dispensary + brand + size + price → same product."""
    return (
        str(r.get("dispensary", "")).lower().strip(),
        str(r.get("brand", "")).lower().strip(),
        str(round(float(r.get("grams", 0)), 1)),
        str(round(float(r.get("price", 0)), 2)),
    )


# ---------------------------------------------------------------------------
# Playwright helpers
# ---------------------------------------------------------------------------

async def _api_fetch(page, url: str) -> dict:
    return await page.evaluate(
        f"""async () => {{
            const r = await fetch({json.dumps(url)}, {{
                headers: {{'Accept': 'application/json'}}
            }});
            if (!r.ok) return {{__status: r.status}};
            return await r.json();
        }}"""
    )


async def collect_dispensaries(page, build_id: str, radius_mi: float) -> dict[str, dict]:
    seen: dict[str, dict] = {}
    for pg in range(1, DISP_PAGES + 1):
        url = (
            f"https://www.leafly.com/_next/data/{build_id}"
            f"/dispensaries/near-me.json?page={pg}"
        )
        r = await _api_fetch(page, url)
        if not isinstance(r, dict) or "__status" in r:
            break
        slr   = r.get("pageProps", {}).get("storeLocatorResults", {})
        data  = slr.get("data", {})
        all_stores = (data.get("organicStores") or []) + (data.get("sponsoredStores") or [])
        if not all_stores:
            break
        added = 0
        for s in all_stores:
            slug = s.get("slug")
            dist = s.get("distanceMi")
            if not slug or dist is None:
                continue
            if dist > radius_mi:
                continue
            if slug not in seen:
                seen[slug] = {
                    "slug": slug,
                    "name": s.get("name", slug),
                    "dist": float(dist),
                }
                added += 1
        if added == 0:
            break
        await asyncio.sleep(0.1)
    return seen


async def fetch_dispensary(context, slug: str, disp_name: str, dist: float,
                           build_id: str, sem: asyncio.Semaphore) -> tuple:
    """
    Navigate to the dispensary's menu page (establishes CORS origin), extract
    the first batch from __NEXT_DATA__, then paginate via _next/data until all
    flower items are collected or the no-flower early-stop fires.
    """
    async with sem:
        page = await context.new_page()
        try:
            await page.goto(
                f"https://www.leafly.com/dispensary-info/{slug}/menu",
                wait_until="domcontentloaded",
                timeout=30_000,
            )
            await asyncio.sleep(1.0)

            # Page 1 is baked into __NEXT_DATA__ (fetching ?page=1 returns empty)
            nd_raw = await page.evaluate(
                "() => { const el = document.getElementById('__NEXT_DATA__'); "
                "return el ? el.textContent : null; }"
            )
            if not nd_raw:
                return disp_name, dist, 0, [], None   # no public menu, not an error
            nd = json.loads(nd_raw)
            pp         = nd.get("props", {}).get("pageProps", {})
            md         = pp.get("menuData", {})
            total      = md.get("totalItems") or 0
            first_batch = md.get("menuItems") or []
            max_pages  = max(1, -(-total // PAGE_SIZE)) if total else 1  # ceiling div

            all_items       = list(first_batch)
            no_flower_streak = 0 if any(
                i.get("productCategory") == "Flower" for i in first_batch
            ) else 1

            for pg in range(2, min(max_pages, MAX_MENU_PAGES) + 1):
                url = (
                    f"https://www.leafly.com/_next/data/{build_id}"
                    f"/dispensary-info/{slug}/menu.json?page={pg}"
                )
                r2 = await _api_fetch(page, url)
                if not isinstance(r2, dict) or "__status" in r2:
                    break
                batch = (r2.get("pageProps", {}).get("menuData", {}).get("menuItems") or [])
                if not batch:
                    break
                all_items.extend(batch)
                if any(i.get("productCategory") == "Flower" for i in batch):
                    no_flower_streak = 0
                else:
                    no_flower_streak += 1
                    if no_flower_streak >= NO_FLOWER_STOP:
                        break
                await asyncio.sleep(0.05)

            rows = [row for item in all_items for row in rows_from_item(item, dist)]
            return disp_name, dist, len(all_items), rows, None

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
    parser.add_argument("--radius", default=RADIUS)
    parser.add_argument("--latlng", default=LATLNG)
    parser.add_argument("--label", default="")
    args             = parser.parse_args()
    RADIUS           = args.radius
    LATLNG           = args.latlng
    location_display = args.label or LATLNG

    lat_s, lng_s = LATLNG.split(",")
    lat, lng     = float(lat_s), float(lng_s)
    radius_mi    = parse_radius_miles(RADIUS)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=_UA,
            geolocation={"latitude": lat, "longitude": lng},
            permissions=["geolocation"],
        )

        # ── Phase 1: discover dispensaries ──────────────────────────────────
        main_page = await context.new_page()
        print("Loading Leafly (near-me)...")
        await main_page.goto(
            "https://www.leafly.com/dispensaries/near-me",
            wait_until="domcontentloaded",
            timeout=45_000,
        )
        await asyncio.sleep(2)

        nd       = await main_page.evaluate(
            "() => JSON.parse(document.getElementById('__NEXT_DATA__').textContent)"
        )
        build_id = nd.get("buildId", "")
        if not build_id:
            print("ERROR: could not extract Leafly buildId.")
            await browser.close()
            return
        print(f"Build ID: {build_id}")

        print(f"Discovering dispensaries ({RADIUS} of {location_display})...")
        slug_map = await collect_dispensaries(main_page, build_id, radius_mi)
        await main_page.close()

        if not slug_map:
            print("No dispensaries found. Try increasing radius.")
            await browser.close()
            return

        by_dist = sorted(slug_map.values(), key=lambda d: d["dist"])
        print(f"Found {len(by_dist)} dispensaries:")
        for d in by_dist:
            print(f"  {d['dist']:4.1f}mi  {d['name']}")

        # ── Phase 2: parallel menu fetching ─────────────────────────────────
        n_workers = min(len(by_dist), MAX_CONCURRENT)
        print(f"\nFetching {len(by_dist)} menus ({n_workers} concurrent pages)...")
        sem   = asyncio.Semaphore(n_workers)
        t0    = time.perf_counter()
        tasks = [
            fetch_dispensary(context, d["slug"], d["name"], d["dist"], build_id, sem)
            for d in by_dist
        ]
        results = await asyncio.gather(*tasks)
        elapsed = time.perf_counter() - t0
        await browser.close()

    # ── Collect results ──────────────────────────────────────────────────────
    new_rows: list[dict] = []
    skipped = 0
    for disp_name, dist, item_count, disp_rows, error in results:
        tag = disp_name[:55]
        if error:
            print(f"  ERROR  {tag}: {error}")
            skipped += 1
        else:
            new_rows.extend(disp_rows)
            print(f"  {tag:<55}  {item_count:>3} items → {len(disp_rows):>4} flower rows")

    print(f"\nMenu fetch: {elapsed:.1f}s  ({n_workers} parallel pages, {skipped} errors)")

    if not new_rows:
        print("No flower items found.")
        return

    new_rows.sort(key=lambda r: r["ppg"])

    # ── Merge with existing CSV ──────────────────────────────────────────────
    existing: list[dict] = []
    if os.path.exists(CSV_PATH):
        try:
            with open(CSV_PATH, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("source", "weedmaps") != "leafly":
                        row.setdefault("source", "weedmaps")
                        existing.append(row)
        except Exception:
            pass

    existing_keys = {dedup_key(r) for r in existing}
    added = [r for r in new_rows if dedup_key(r) not in existing_keys]
    merged = existing + added
    merged.sort(key=lambda r: float(r.get("ppg", 0)))

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(merged)

    print(f"\n{len(added)} new Leafly rows + {len(existing)} existing = {len(merged)} total")
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
