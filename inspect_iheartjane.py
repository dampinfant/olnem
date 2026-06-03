#!/usr/bin/env python3
"""
iHeartJane API discovery — capture the actual product-loading call.
Navigate to Farmacy Santa Ana, scroll/click to Flower section, capture all dmerch calls.
"""
import asyncio, json, re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from playwright.async_api import async_playwright

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36"

dmerch_calls = []

def on_req(req):
    url = req.url
    if "dmerch.iheartjane.com" in url:
        body = req.post_data or ""
        dmerch_calls.append({"url": url, "method": req.method, "body": body})
        if "smart" in url or "search" in url:
            print(f"\n  dmerch {req.method}: {url[:100]}")
            if body:
                try:
                    b = json.loads(body)
                    print(f"    max_products={b.get('max_products')}  search_filter={b.get('search_filter')!r}  page_size={b.get('page_size')}  page={b.get('page')}")
                except:
                    print(f"    body={body[:200]}")


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        ctx = await browser.new_context(viewport={"width": 1280, "height": 900}, user_agent=_UA)
        page = await ctx.new_page()
        page.on("request", on_req)

        print("[1] Loading Farmacy Santa Ana...")
        try:
            await page.goto("https://farmacyshop.com/santa-ana-cannabis/",
                            wait_until="domcontentloaded", timeout=60000)
        except Exception as e:
            print(f"  goto error: {e}")
        await asyncio.sleep(6)

        # Scroll to trigger menu rendering
        print("\n[2] Scrolling to render menu...")
        for y in [300, 600, 900, 1200, 1500, 1800]:
            await page.evaluate(f"window.scrollTo(0, {y})")
            await asyncio.sleep(2)

        # Click flower tab/link
        print("\n[3] Looking for flower navigation...")
        flower_sel = await page.evaluate("""() => {
            const els = [...document.querySelectorAll('a, button, [role=tab], [role=menuitem]')];
            return els.filter(e => /^flower$/i.test((e.textContent||'').trim())).slice(0,3).map(e => ({
                tag: e.tagName, text: e.textContent.trim().slice(0,30), href: e.getAttribute('href')||'', cls: e.className.slice(0,60)
            }));
        }""")
        print(f"  Flower elements: {flower_sel}")

        for sel in ["a[href*='flower']", "[data-category='flower']",
                    "[data-kind='flower']", "[aria-label*='Flower']"]:
            el = await page.query_selector(sel)
            if el:
                print(f"  Clicking: {sel}")
                await el.click()
                await asyncio.sleep(6)
                break

        print(f"\n[4] Total dmerch calls captured: {len(dmerch_calls)}")
        for c in dmerch_calls:
            if "smart" in c["url"] or "search" in c["url"]:
                try:
                    b = json.loads(c["body"])
                    print(f"\n  {c['method']} {c['url'][:80]}")
                    print(f"    max_products={b.get('max_products')}  page_size={b.get('page_size')}  page={b.get('page')}")
                    print(f"    search_filter={b.get('search_filter')!r}  placement={b.get('placement')!r}")
                except:
                    print(f"  {c['url'][:80]}  body={c['body'][:100]}")

        # Now try the call manually with max_products > 0
        print("\n[5] Manual POST with max_products=60, search_filter='kind:flower'...")
        smart_calls = [c for c in dmerch_calls if "smart" in c["url"]]
        if smart_calls:
            # Get jdm_key from URL
            m = re.search(r"jdm_api_key=([a-f0-9-]+)", smart_calls[0]["url"])
            jdm_key = m.group(1) if m else ""
            print(f"  jdm_key={jdm_key}")

            # Try the flower-filtered call from within this page
            base_url = f"https://dmerch.iheartjane.com/v2/smart?jdm_api_key={jdm_key}&jdm_source=monolith&jdm_version=2.17.0"
            body_obj = {
                "app_mode": "framelessEmbed",
                "distinct_id": "$device:test",
                "jane_device_id": "test",
                "search_attributes": ["*"],
                "store_id": 519,
                "disable_ads": False,
                "max_products": 60,  # <-- key change
                "num_columns": 5,
                "page_size": 60,
                "placement": "menu_inline_table",
                "search_facets": [],
                "search_filter": "kind:flower",
                "search_query": "",
                "search_sort": "recommendation",
            }

            result = await page.evaluate(
                """async ([url, bodyStr]) => {
                    const r = await fetch(url, {
                        method: 'POST',
                        headers: {'Content-Type': 'text/plain', 'Accept': 'application/json'},
                        body: bodyStr
                    });
                    if (!r.ok) return {status: r.status};
                    const j = await r.json();
                    const prods = j.products || [];
                    return {
                        status: 200,
                        nb_hits: j.nb_hits,
                        count: prods.length,
                        firstProduct: prods[0] || null
                    };
                }""",
                [base_url, json.dumps(body_obj)]
            )
            print(f"  status={result['status']}  nb_hits={result.get('nb_hits')}  count={result.get('count')}")
            if result.get("firstProduct"):
                p = result["firstProduct"]
                print(f"\n  product keys: {list(p.keys())}")
                print(json.dumps(p, indent=2, default=str)[:3000])

        await asyncio.sleep(2)
        await browser.close()


asyncio.run(main())
