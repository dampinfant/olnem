#!/usr/bin/env python3
"""
Flower Finder server.
- Serves static files from its own directory
- Opens the browser on first launch
- API endpoints:
    GET  /api/status           → { running, csv_mtime, error, radius, latlng, location_label }
    GET  /api/geocode?q=...    → { lat, lng, display_name } or { error }  (proxies Nominatim)
    POST /refresh              → body { radius, latlng, location_label }
                                 starts weedmaps_flower.py in a background thread
"""
import csv
import http.server
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone

import inventory_signals
import restock_patterns

BASE_DIR        = os.path.dirname(os.path.abspath(__file__))
SCRAPER_WM      = os.path.join(BASE_DIR, "weedmaps_flower.py")
SCRAPER_LF      = os.path.join(BASE_DIR, "leafly_flower.py")
SCRAPER_IHJ     = os.path.join(BASE_DIR, "iheartjane_flower.py")
SCRAPER_EZ      = os.path.join(BASE_DIR, "eaze_flower.py")
CSV_PATH        = os.path.join(BASE_DIR, "flower_results.csv")
SNAPSHOTS_DIR   = os.path.join(BASE_DIR, "snapshots")
LOCATION_FILE   = os.path.join(BASE_DIR, "location.json")
PYTHON          = sys.executable

_DEFAULT_LOCATION = {"latlng": "33.58,-117.83", "label": "Newport Coast, CA"}


def _load_location() -> dict:
    try:
        with open(LOCATION_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if "latlng" in data and "label" in data:
            return data
    except Exception:
        pass
    return dict(_DEFAULT_LOCATION)


def _save_location(latlng: str, label: str):
    try:
        with open(LOCATION_FILE, "w", encoding="utf-8") as f:
            json.dump({"latlng": latlng, "label": label}, f)
    except Exception:
        pass


def _csv_mtime() -> str | None:
    try:
        ts = os.path.getmtime(CSV_PATH)
        return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except OSError:
        return None


_saved = _load_location()
_lock  = threading.Lock()
_status = {
    "running":        False,
    "error":          None,
    "radius":         "20mi",
    "latlng":         _saved["latlng"],
    "location_label": _saved["label"],
}


def _run_one(cmd: list, timeout: int = 900) -> str | None:
    """Run a subprocess; return error string or None on success."""
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, cwd=BASE_DIR, timeout=timeout,
        )
        if result.returncode != 0:
            return (result.stderr or result.stdout or "")[-600:].strip()
        return None
    except subprocess.TimeoutExpired:
        return "Timed out after 15 minutes."
    except Exception as exc:
        return str(exc)


def _run_scraper(radius: str, latlng: str, label: str):
    with _lock:
        _status["running"]        = True
        _status["error"]          = None
        _status["radius"]         = radius
        _status["latlng"]         = latlng
        _status["location_label"] = label

    args = ["--radius", radius, "--latlng", latlng, "--label", label]
    errors = []

    # Weedmaps first (writes flower_results.csv)
    err = _run_one([PYTHON, SCRAPER_WM] + args)
    if err:
        errors.append(f"Weedmaps: {err}")

    # Leafly second (merges into flower_results.csv)
    if os.path.exists(SCRAPER_LF):
        err = _run_one([PYTHON, SCRAPER_LF] + args)
        if err:
            errors.append(f"Leafly: {err}")

    # iHeartJane third (merges into flower_results.csv)
    if os.path.exists(SCRAPER_IHJ):
        err = _run_one([PYTHON, SCRAPER_IHJ] + args)
        if err:
            errors.append(f"iHeartJane: {err}")

    # Eaze fourth (merges into flower_results.csv)
    if os.path.exists(SCRAPER_EZ):
        err = _run_one([PYTHON, SCRAPER_EZ] + args)
        if err:
            errors.append(f"Eaze: {err}")

    if os.path.exists(CSV_PATH):
        os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y-%m-%d_%H-%M")
        shutil.copy2(CSV_PATH, os.path.join(SNAPSHOTS_DIR, f"{stamp}.csv"))
        try:
            inventory_signals.update(CSV_PATH)
        except Exception:
            pass
        try:
            restock_patterns.update()
        except Exception:
            pass

    with _lock:
        _status["error"]   = "\n".join(errors) if errors else None
        _status["running"] = False


def _load_csv_price_map(path: str) -> dict:
    """Return dict keyed by (dispensary, brand, grams, source) → lowest price seen."""
    result = {}
    try:
        with open(path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                try:
                    key = (
                        row.get('dispensary', '').lower().strip(),
                        row.get('brand', '').lower().strip(),
                        round(float(row.get('grams') or 0), 1),
                        row.get('source', 'weedmaps').lower().strip(),
                    )
                    price = float(row.get('price') or 0)
                    if price > 0 and (key not in result or price < result[key]):
                        result[key] = price
                except (ValueError, KeyError):
                    pass
    except Exception:
        pass
    return result


class Handler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path == "/api/status":
            with _lock:
                payload = {
                    "running":        _status["running"],
                    "csv_mtime":      _csv_mtime(),
                    "error":          _status["error"],
                    "radius":         _status["radius"],
                    "latlng":         _status["latlng"],
                    "location_label": _status["location_label"],
                }
            self._json(payload)

        elif self.path == "/api/price_delta":
            try:
                if not os.path.isdir(SNAPSHOTS_DIR) or not os.path.exists(CSV_PATH):
                    self._json({"drops": {}, "snapshot_time": None})
                    return

                csv_mtime = os.path.getmtime(CSV_PATH)
                snaps = sorted(
                    [f for f in os.listdir(SNAPSHOTS_DIR) if f.endswith('.csv')],
                    reverse=True,
                )

                # Find the most recent snapshot that predates the current CSV by >5s.
                # (shutil.copy2 preserves mtime, so the snapshot taken from the current
                # CSV run will share its mtime — skip it and use the one before it.)
                prev_path = None
                for snap_name in snaps:
                    sp = os.path.join(SNAPSHOTS_DIR, snap_name)
                    if os.path.getmtime(sp) < csv_mtime - 5:
                        prev_path = sp
                        break

                if not prev_path:
                    self._json({"drops": {}, "snapshot_time": None})
                    return

                cur_map  = _load_csv_price_map(CSV_PATH)
                prev_map = _load_csv_price_map(prev_path)

                drops = {}
                for key, cur_price in cur_map.items():
                    old_price = prev_map.get(key)
                    if old_price is not None and cur_price < old_price - 0.005:
                        disp, brand, grams, source = key
                        json_key = f"{disp}||{brand}||{grams}||{source}"
                        drops[json_key] = {
                            "old_price": round(old_price, 2),
                            "new_price": round(cur_price, 2),
                            "drop":      round(old_price - cur_price, 2),
                        }

                snap_iso = datetime.fromtimestamp(
                    os.path.getmtime(prev_path), tz=timezone.utc
                ).isoformat()
                self._json({"drops": drops, "snapshot_time": snap_iso})
            except Exception as exc:
                self._json({"drops": {}, "snapshot_time": None, "error": str(exc)})

        elif self.path == "/api/inventory":
            try:
                self._json(inventory_signals.get_signals())
            except Exception as exc:
                self._json({"error": str(exc)})

        elif self.path == "/api/restock":
            try:
                self._json(restock_patterns.get_patterns())
            except Exception as exc:
                self._json({"error": str(exc)})

        elif self.path.startswith("/api/geocode"):
            parsed = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed.query)
            q = params.get("q", [""])[0].strip()
            if not q:
                self._json({"error": "no query"})
                return
            url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({
                "q": q, "format": "json", "limit": 1,
            })
            req = urllib.request.Request(url, headers={
                "User-Agent": "WeedmapsFlowerFinder/1.0 (local price-comparison tool)",
                "Accept":     "application/json",
            })
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    results = json.loads(resp.read())
                if results:
                    r0 = results[0]
                    self._json({
                        "lat":          float(r0["lat"]),
                        "lng":          float(r0["lon"]),
                        "display_name": r0.get("display_name", q),
                    })
                else:
                    self._json({"error": "not found"})
            except Exception as exc:
                self._json({"error": str(exc)})

        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/refresh":
            with _lock:
                already = _status["running"]
                cur_radius = _status["radius"]
                cur_latlng = _status["latlng"]
                cur_label  = _status["location_label"]
            if already:
                self._json({"status": "already_running"})
                return

            radius = cur_radius
            latlng = cur_latlng
            label  = cur_label
            length = int(self.headers.get("Content-Length", 0))
            if length:
                try:
                    body   = json.loads(self.rfile.read(length))
                    radius = body.get("radius", radius)
                    latlng = body.get("latlng", latlng)
                    label  = body.get("location_label", label)
                except Exception:
                    pass

            _save_location(latlng, label)
            threading.Thread(
                target=_run_scraper, args=(radius, latlng, label), daemon=True
            ).start()
            self._json({"status": "started", "radius": radius, "latlng": latlng})
        else:
            self.send_error(404)

    def _json(self, data: dict):
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api") or self.path == "/refresh":
            super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(BASE_DIR)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    threading.Timer(0.4, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    print(f"Flower Finder → http://localhost:{port}/  (Ctrl+C to stop)")
    print(f"Location: {_status['location_label']} ({_status['latlng']})")
    http.server.test(HandlerClass=Handler, port=port, bind="127.0.0.1")
