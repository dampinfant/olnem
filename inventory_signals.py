#!/usr/bin/env python3
"""Inventory signal tracking — persists seen/missing state across scrape cycles."""
import csv
import json
import os
from datetime import datetime, timezone

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
HISTORY_FILE = os.path.join(BASE_DIR, "inventory_history.json")


def _key(row: dict) -> str:
    """Composite key matching JS buildDeltaKey: dispensary||brand||grams||source."""
    dispensary = (row.get('dispensary') or '').lower().strip()
    brand      = (row.get('brand')      or '').lower().strip()
    source     = (row.get('source')     or 'weedmaps').lower().strip()
    try:
        g = round(float(row.get('grams') or 0), 1)
        grams = str(int(g)) if g == int(g) else str(g)
    except (ValueError, TypeError):
        grams = '0'
    return f"{dispensary}||{brand}||{grams}||{source}"


def _read_csv(path: str) -> dict:
    """Return {key: row} for the first occurrence of each key in the CSV."""
    rows = {}
    try:
        with open(path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                k = _key(row)
                if k not in rows:
                    rows[k] = row
    except Exception:
        pass
    return rows


def _load() -> dict:
    try:
        with open(HISTORY_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _save(history: dict):
    with open(HISTORY_FILE, 'w', encoding='utf-8') as f:
        json.dump(history, f, indent=2)


def update(current_csv_path: str, previous_snapshot_path: str = None) -> dict:
    """Diff current CSV against stored history; persist updated state.
    Call once after each scrape cycle completes."""
    now     = datetime.now(timezone.utc).isoformat()
    current = _read_csv(current_csv_path)
    history = _load()

    for k, row in current.items():
        if k not in history:
            history[k] = {
                'dispensary':          row.get('dispensary', ''),
                'brand':               row.get('brand', ''),
                'product':             row.get('product', ''),
                'grams':               row.get('grams', ''),
                'source':              row.get('source', 'weedmaps'),
                'last_price':          None,
                'first_seen':          now,
                'last_seen':           now,
                'times_seen':          0,
                'times_missing':       0,
                'consecutive_missing': 0,
            }
        e = history[k]
        e['last_seen']           = now
        e['times_seen']          = e.get('times_seen', 0) + 1
        e['consecutive_missing'] = 0
        try:
            p = float(row.get('price') or 0)
            if p > 0:
                e['last_price'] = p
        except (ValueError, TypeError):
            pass

    for k, e in history.items():
        if k not in current:
            e['times_missing']       = e.get('times_missing', 0) + 1
            e['consecutive_missing'] = e.get('consecutive_missing', 0) + 1

    _save(history)
    return history


def get_signals() -> dict:
    """Return full history dict (for /api/inventory)."""
    return _load()
