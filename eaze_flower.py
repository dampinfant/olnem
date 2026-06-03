#!/usr/bin/env python3
"""
Eaze flower price scraper.
Navigates to www.eaze.com, then fetches /api/v2/groups/flowers and
/api/v2/groups/bulk-flower-5g-and-up via page.evaluate (same-origin,
no CORS) to capture the full flower catalog.
Merges into flower_results.csv with source='eaze'.

Same --radius / --latlng / --label argparse interface and CSV merge pattern
as the other scrapers.  Returns 0 rows (with a printed warning) gracefully
if the area is outside Eaze's delivery zone or if the API shape has changed.

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

LATLNG       = "33.58,-117.83"
RADIUS       = "20mi"                # accepted for CLI parity; Eaze is zone-based
PAGE_TIMEOUT = 45_000

EAZE_HOME    = "https://www.eaze.com"
EAZE_MENU    = "https://www.eaze.com/menu"

# Groups that contain flower SKUs; fetched via /api/v2/groups/{slug}?menu=default
FLOWER_GROUP_SLUGS = ["flowers", "bulk-flower-5g-and-up"]

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

# (pattern, canonical_grams) — checked against "<label> <size>" concatenation
_WEIGHT_PATS: list[tuple[re.Pattern, float]] = [
    (re.compile(r'\b0\.5\s*g|\bhalf[\s-]?gram\b',          re.IGNORECASE), 0.5),
    (re.compile(r'\b1\.0?\s*g(?:ram)?(?!\d)\b',            re.IGNORECASE), 1.0),
    (re.compile(r'\b2\s*g(?:ram)?(?!\d)\b',                re.IGNORECASE), 2.0),
    (re.compile(r'\b3\.5\s*g|\b1/8\s*oz|\beighth\b',       re.IGNORECASE), 3.5),
    (re.compile(r'\b7\s*g(?:ram)?(?!\d)|\b1/4\s*oz|\bquarter\b', re.IGNORECASE), 7.0),
    (re.compile(r'\b14\s*g|\b1/2\s*oz|\bhalf\s*oz\b',      re.IGNORECASE), 14.0),
    (re.compile(r'\b28\s*g|\b1\s*oz\b|\bounce\b',          re.IGNORECASE), 28.0),
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



# ---------------------------------------------------------------------------
# Product row builder  — handles flat products and variant-arrays
# ---------------------------------------------------------------------------

def rows_from_product(p: dict, _listing_url: str = "") -> list[dict]:
    # New flat-product shape: type.slug == 'flowers', no variants array.
    # Flower identity comes from the group slug we fetched, so just block
    # subtype slugs that aren't actual smokable flower.
    name = p.get("name", "")
    if not name or EXCLUDE_RE.search(name):
        return []

    brand      = (p.get("brand") or {}).get("name", "")
    subtype    = (p.get("subtype") or {}).get("name", "")
    on_sale    = "True" if p.get("tag") else "False"
    slug       = p.get("slug", "")
    listing_url = f"https://www.eaze.com/menu/{slug}" if slug else EAZE_MENU

    try:
        price = float(p.get("price") or 0)
    except (TypeError, ValueError):
        return []
    if price <= 0:
        return []

    # weight field is unreliable (sometimes unit count, sometimes grams).
    # Parse from subtype name + product name which always contain the size text.
    grams = _parse_grams(p.get("weight"), f"{subtype} {name}")
    if grams is None:
        return []

    return [dict(
        ppg=round(price / grams, 4), price=price, grams=grams,
        label=subtype, dist=0.0, product=name, brand=brand,
        dispensary="Eaze", on_sale=on_sale,
        updated_at="", source="eaze", listing_url=listing_url,
    )]


def dedup_key(r: dict) -> tuple:
    return (
        str(r.get("dispensary", "")).lower().strip(),
        str(r.get("brand", "")).lower().strip(),
        str(round(float(r.get("grams", 0)), 1)),
        str(round(float(r.get("price", 0)), 2)),
    )


# ---------------------------------------------------------------------------
# Playwright  — load home page → fetch both flower groups via same-origin API
# ---------------------------------------------------------------------------

async def fetch_eaze_catalog(context, lat: float, lng: float) -> list[dict]:
    """
    Navigate to www.eaze.com to establish a session, then fetch both flower
    catalog groups via /api/v2/groups/{slug} using page.evaluate (same-origin,
    no CORS). Returns parsed rows or [] with a warning on failure.
    """
    page = await context.new_page()
    all_products: list[dict] = {}

    try:
        print("Loading Eaze...")
        await page.goto(EAZE_HOME, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)
        await asyncio.sleep(2)

        for slug in FLOWER_GROUP_SLUGS:
            try:
                result = await page.evaluate(f"""async () => {{
                    const r = await fetch('/api/v2/groups/{slug}?menu=default', {{
                        credentials: 'include',
                        headers: {{'Accept': 'application/json'}},
                    }});
                    if (!r.ok) return {{__status: r.status}};
                    return await r.json();
                }}""")
                if isinstance(result, dict) and "__status" in result:
                    print(f"  {slug}: HTTP {result['__status']}")
                    continue
                prods = result.get("products") or []
                print(f"  {slug}: {len(prods)} products")
                for p in prods:
                    if isinstance(p, dict):
                        pid = str(p.get("id") or p.get("catalogItemId") or id(p))
                        all_products[pid] = p
            except Exception as exc:
                print(f"  {slug}: error — {exc}")

    except Exception as exc:
        print(f"WARNING: Eaze — unexpected error during fetch: {exc}")
    finally:
        await page.close()

    if not all_products:
        print(
            "WARNING: Eaze — 0 products captured. "
            "The delivery area may not be serviceable or the API shape has changed. "
            "Skipping Eaze for this cycle."
        )
        return []

    rows = []
    for p in all_products.values():
        rows.extend(rows_from_product(p, EAZE_MENU))
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

    print(f"Fetching Eaze catalog ({location_display})...")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=_UA,
            geolocation={"latitude": lat, "longitude": lng},
            permissions=["geolocation"],
        )
        t0       = time.perf_counter()
        new_rows = await fetch_eaze_catalog(context, lat, lng)
        elapsed  = time.perf_counter() - t0
        await browser.close()

    if not new_rows:
        print("No Eaze flower rows found.")
        return

    new_rows.sort(key=lambda r: r["ppg"])
    print(f"\nCatalog fetch: {elapsed:.1f}s — {len(new_rows)} flower rows")

    # ── Merge into CSV (replace prior eaze rows) ─────────────────────────────
    existing: list[dict] = []
    if os.path.exists(CSV_PATH):
        try:
            with open(CSV_PATH, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    if row.get("source") != "eaze":
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

    print(f"{len(added)} new Eaze rows + {len(existing)} existing = {len(merged)} total")
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
