#!/usr/bin/env python3
"""
Grassdoor flower price scraper.
Navigates to grassdoor.com with the target geolocation, intercepts catalog API
responses (so auth tokens / cookies are handled transparently by the browser),
then paginates via scroll and page.evaluate API replay.
Merges into flower_results.csv with source='grassdoor'.

Same --radius / --latlng / --label argparse interface and CSV merge pattern
as the other scrapers.  Returns 0 rows (with a printed warning) gracefully
if the area is outside Grassdoor's delivery zone or if the API shape has changed.

Install deps (same as the other scrapers):
    pip install playwright
    playwright install chromium
"""

import sys, io, re, os, time, json, csv, argparse, asyncio
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

LATLNG        = "33.58,-117.83"
RADIUS        = "20mi"                # accepted for CLI parity; Grassdoor is zone-based
CATALOG_WAIT  = 5                     # seconds after page load before scraping
SCROLL_PASSES = 4                     # scroll passes to trigger lazy-load pages
PAGE_TIMEOUT  = 45_000

GRASSDOOR_HOME      = "https://grassdoor.com"
GRASSDOOR_SHOP_URLS = [               # try these in order until one yields products
    "https://grassdoor.com/flower",
    "https://grassdoor.com/category/flower",
    "https://grassdoor.com/shop/flower",
    "https://grassdoor.com/",
]
API_DOMAIN = "api.grassdoor.com"

CSV_PATH   = "flower_results.csv"
CSV_FIELDS = ["ppg", "price", "grams", "label", "dist", "product", "brand",
              "dispensary", "on_sale", "updated_at", "source", "listing_url"]

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

EXCLUDE_RE = re.compile(
    r'\bpre[-\s]?roll\b|\bpreroll\b|\bjoint\b|\bblunt\b'
    r'|\binfused\b|\binfuse\b'
    r'|\blive\s+rosin\b|\bhash\s+rosin\b|\brosin\s*(?:pod|cart)\b'
    r'|\blive\s+resin\b|\bdistillate\b|\bcartridge\b'
    r'|\bvape\s+(?:cart|pod)\b|\bpod\b',
    re.IGNORECASE,
)

_WEIGHT_PATS: list[tuple[re.Pattern, float]] = [
    (re.compile(r'\b0\.5\s*g|\bhalf[\s-]?gram\b',               re.IGNORECASE), 0.5),
    (re.compile(r'\b1\.0?\s*g(?:ram)?(?!\d)\b',                 re.IGNORECASE), 1.0),
    (re.compile(r'\b2\s*g(?:ram)?(?!\d)\b',                     re.IGNORECASE), 2.0),
    (re.compile(r'\b3\.5\s*g|\b1/8\s*oz|\beighth\b',            re.IGNORECASE), 3.5),
    (re.compile(r'\b7\s*g(?:ram)?(?!\d)|\b1/4\s*oz|\bquarter\b',re.IGNORECASE), 7.0),
    (re.compile(r'\b14\s*g|\b1/2\s*oz|\bhalf\s*oz\b',           re.IGNORECASE), 14.0),
    (re.compile(r'\b28\s*g|\b1\s*oz\b|\bounce\b',               re.IGNORECASE), 28.0),
]
_SNAP_BUCKETS: list[tuple[float, float]] = [
    (0.5, 0.10), (1.0, 0.15), (2.0, 0.20), (3.5, 0.30),
    (7.0, 0.50), (14.0, 1.00), (28.0, 1.50),
]


def _parse_grams(raw, label: str = "") -> float | None:
    text = f"{label} {raw or ''}".strip()
    for pat, std in _WEIGHT_PATS:
        if pat.search(text):
            return std
    try:
        val = float(str(raw).lower().replace("g", "").replace("oz", "").strip())
        if "oz" in str(raw).lower():
            val *= 28.3495
        if 0.3 <= val <= 60:
            for std, tol in _SNAP_BUCKETS:
                if abs(val - std) <= tol:
                    return std
            return round(val, 1)
    except (TypeError, ValueError):
        pass
    return None


def _is_flower(p: dict) -> bool:
    for field in ("category", "kind", "product_type", "type", "productType"):
        v = (p.get(field) or "").lower().strip() if isinstance(p.get(field), str) else ""
        if v in ("flower", "bud", "cannabis flower", "cannabis_flower"):
            return True
        if v and "flower" in v:
            return True
    # Also check nested category objects
    cat = p.get("category")
    if isinstance(cat, dict):
        v = (cat.get("name") or cat.get("slug") or "").lower()
        if "flower" in v:
            return True
    return False


# ---------------------------------------------------------------------------
# Product row builder  — handles flat products and variant-arrays
# ---------------------------------------------------------------------------

def rows_from_product(p: dict, listing_url: str) -> list[dict]:
    if not _is_flower(p):
        return []
    name = p.get("name", "")
    if not name or EXCLUDE_RE.search(name):
        return []

    raw_brand = p.get("brand")
    brand = (
        p.get("brandName")
        or (raw_brand.get("name", "") if isinstance(raw_brand, dict) else (raw_brand or ""))
        or p.get("brand_name", "")
        or p.get("producer", "")
        or ""
    )

    raw_disp = p.get("dispensary")
    dispensary = (
        p.get("dispensaryName")
        or p.get("dispensary_name")
        or (raw_disp.get("name", "") if isinstance(raw_disp, dict) else (raw_disp or ""))
        or "Grassdoor"
    )

    top_on_sale = bool(
        p.get("isDiscounted") or p.get("isOnSale") or p.get("is_discounted")
        or p.get("on_sale") or p.get("isSpecial") or p.get("has_deal")
        or p.get("sale_price")
    )
    updated_at = p.get("updatedAt") or p.get("updated_at") or p.get("updated") or ""
    dist = 0.0   # Grassdoor is delivery-only — no physical distance metric

    # ── variant model ────────────────────────────────────────────────────────
    variants = p.get("variants") or p.get("prices") or p.get("sizes") or []
    if variants:
        out = []
        for v in variants:
            if not isinstance(v, dict):
                continue
            try:
                price = float(
                    v.get("price") or v.get("sale_price") or v.get("discountedPrice")
                    or v.get("discounted_price") or 0
                )
                orig = float(
                    v.get("original_price") or v.get("originalPrice")
                    or v.get("retail_price") or v.get("retailPrice") or price
                )
            except (TypeError, ValueError):
                continue
            if price <= 0:
                continue
            label_raw = str(
                v.get("label") or v.get("sizeLabel") or v.get("size_label")
                or v.get("unit") or v.get("weight") or v.get("name") or ""
            )
            grams = _parse_grams(
                v.get("quantity") or v.get("grams") or v.get("size")
                or v.get("weight") or v.get("amount"),
                label_raw,
            )
            if grams is None:
                continue
            on_sale = "True" if (top_on_sale or price < orig - 0.01) else "False"
            out.append(dict(
                ppg=round(price / grams, 4), price=price, grams=grams,
                label=label_raw, dist=dist, product=name, brand=brand,
                dispensary=dispensary, on_sale=on_sale,
                updated_at=updated_at, source="grassdoor", listing_url=listing_url,
            ))
        return out

    # ── flat single-size product ─────────────────────────────────────────────
    try:
        price = float(p.get("price") or p.get("discountedPrice") or p.get("sale_price") or 0)
        orig  = float(p.get("originalPrice") or p.get("original_price") or p.get("retailPrice") or price)
    except (TypeError, ValueError):
        return []
    if price <= 0:
        return []

    label_raw = str(p.get("label") or p.get("unit") or p.get("sizeLabel") or p.get("size") or "")
    grams = _parse_grams(
        p.get("quantity") or p.get("grams") or p.get("weight") or p.get("gram"),
        label_raw or name,
    )
    if grams is None:
        return []

    on_sale = "True" if (top_on_sale or price < orig - 0.01) else "False"
    return [dict(
        ppg=round(price / grams, 4), price=price, grams=grams,
        label=label_raw, dist=dist, product=name, brand=brand,
        dispensary=dispensary, on_sale=on_sale,
        updated_at=updated_at, source="grassdoor", listing_url=listing_url,
    )]


# ---------------------------------------------------------------------------
# Response interception helper
# ---------------------------------------------------------------------------

def _extract_products(data) -> list[dict]:
    """Pull a flat product list out of whatever JSON shape we received."""
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []
    for key in ("products", "items", "results", "data", "catalog"):
        val = data.get(key)
        if isinstance(val, list):
            return val
        if isinstance(val, dict):
            for inner_key in ("products", "items", "results", "data"):
                inner = val.get(inner_key)
                if isinstance(inner, list):
                    return inner
    return []


def dedup_key(r: dict) -> tuple:
    return (
        str(r.get("dispensary", "")).lower().strip(),
        str(r.get("brand", "")).lower().strip(),
        str(round(float(r.get("grams", 0)), 1)),
        str(round(float(r.get("price", 0)), 2)),
    )


# ---------------------------------------------------------------------------
# Playwright  — navigate → intercept → paginate
# ---------------------------------------------------------------------------

async def fetch_grassdoor_catalog(context, lat: float, lng: float) -> list[dict]:
    """
    Navigate Grassdoor's flower catalog with browser-managed auth; capture all
    API responses from api.grassdoor.com; return parsed rows.
    Returns [] with a warning on geo-restriction or unexpected page shape.
    """
    page = await context.new_page()
    products_by_id: dict[str, dict] = {}
    captured_listing_url = [GRASSDOOR_SHOP_URLS[0]]

    async def on_response(response):
        if API_DOMAIN not in response.url:
            return
        if response.status != 200:
            return
        try:
            data = await response.json()
        except Exception:
            return
        for p in _extract_products(data):
            if not isinstance(p, dict):
                continue
            pid = str(p.get("id") or p.get("product_id") or p.get("objectID") or id(p))
            products_by_id[pid] = p

    page.on("response", on_response)

    try:
        # ── Establish CORS origin on the home page ───────────────────────────
        print("Loading Grassdoor...")
        await page.goto(GRASSDOOR_HOME, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)
        await asyncio.sleep(2)

        # ── Navigate to flower catalog ───────────────────────────────────────
        for url in GRASSDOOR_SHOP_URLS:
            try:
                resp = await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)
                if resp and resp.ok:
                    captured_listing_url[0] = url
                    break
            except Exception:
                continue
        await asyncio.sleep(CATALOG_WAIT)

        # ── Scroll to trigger lazy-load pagination ───────────────────────────
        for _ in range(SCROLL_PASSES):
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await asyncio.sleep(1.5)
            try:
                btn = page.locator(
                    'button:text-matches("load more|see more|view more|show more", "i")'
                ).first
                if await btn.is_visible(timeout=500):
                    await btn.click()
                    await asyncio.sleep(1.5)
            except Exception:
                pass

        # ── Fallback: direct API call from within browser context ─────────────
        # Only attempted if the navigation captured nothing — avoids duplicate work.
        if not products_by_id:
            for api_url in [
                f"https://{API_DOMAIN}/api/products?lat={lat}&lng={lng}&category=flower",
                f"https://{API_DOMAIN}/api/v1/products?lat={lat}&lng={lng}&type=flower",
                f"https://{API_DOMAIN}/api/catalog?lat={lat}&lng={lng}&category=flower",
                f"https://{API_DOMAIN}/api/v2/menu?lat={lat}&lng={lng}&kind=flower",
            ]:
                try:
                    result = await page.evaluate(
                        f"""async () => {{
                            const r = await fetch({json.dumps(api_url)}, {{
                                headers: {{
                                    'Accept': 'application/json',
                                    'Origin': 'https://grassdoor.com',
                                    'Referer': 'https://grassdoor.com/',
                                }},
                                credentials: 'include',
                            }});
                            if (!r.ok) return {{__status: r.status}};
                            return await r.json();
                        }}"""
                    )
                    if isinstance(result, dict) and "__status" in result:
                        continue
                    for p in _extract_products(result):
                        if isinstance(p, dict):
                            pid = str(p.get("id") or p.get("product_id") or id(p))
                            products_by_id[pid] = p
                    if products_by_id:
                        break
                except Exception:
                    continue

    except Exception as exc:
        print(f"WARNING: Grassdoor — unexpected error during fetch: {exc}")
    finally:
        await page.close()

    if not products_by_id:
        print(
            "WARNING: Grassdoor — 0 products captured. "
            "The delivery area may not be serviceable or the page structure has changed. "
            "Skipping Grassdoor for this cycle."
        )
        return []

    rows = []
    for p in products_by_id.values():
        rows.extend(rows_from_product(p, captured_listing_url[0]))
    return rows


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

    print(f"Fetching Grassdoor catalog ({location_display})...")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=_UA,
            geolocation={"latitude": lat, "longitude": lng},
            permissions=["geolocation"],
        )
        t0       = time.perf_counter()
        new_rows = await fetch_grassdoor_catalog(context, lat, lng)
        elapsed  = time.perf_counter() - t0
        await browser.close()

    if not new_rows:
        print("No Grassdoor flower rows found.")
        return

    new_rows.sort(key=lambda r: r["ppg"])
    print(f"\nCatalog fetch: {elapsed:.1f}s — {len(new_rows)} flower rows")

    # ── Merge into CSV (replace prior grassdoor rows) ────────────────────────
    existing: list[dict] = []
    if os.path.exists(CSV_PATH):
        try:
            with open(CSV_PATH, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("source") != "grassdoor":
                        existing.append(row)
        except Exception:
            pass

    existing_keys = {dedup_key(r) for r in existing}
    added  = [r for r in new_rows if dedup_key(r) not in existing_keys]
    merged = existing + added
    merged.sort(key=lambda r: float(r.get("ppg", 0)))

    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore", restval="")
        writer.writeheader()
        writer.writerows(merged)

    print(f"{len(added)} new Grassdoor rows + {len(existing)} existing = {len(merged)} total")
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
