#!/usr/bin/env python3
"""
Restock pattern detection — analyzes per-dispensary restock events
derived from the snapshots/ folder to produce day-of-week / hour-of-day
patterns and a 0–1 confidence score.
"""
import csv
import json
import os
from collections import Counter
from datetime import datetime, timezone

BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
SNAPSHOTS_DIR = os.path.join(BASE_DIR, "snapshots")
PATTERNS_FILE = os.path.join(BASE_DIR, "restock_patterns.json")

# If no snapshot for a dispensary exists within this many days, don't carry
# the old baseline forward (avoids false-positive restock events after gaps).
_GAP_DAYS = 3


def _parse_snap_dt(filename: str) -> datetime | None:
    """'2026-06-02_10-30.csv' → UTC datetime, or None on parse failure."""
    try:
        return datetime.strptime(filename[:-4], "%Y-%m-%d_%H-%M").replace(tzinfo=timezone.utc)
    except (ValueError, IndexError):
        return None


def _read_snap(path: str) -> dict[str, set[str]]:
    """Return {dispensary_name: {listing_key, ...}} from one snapshot CSV.

    Listing key = brand||grams||source (dispensary omitted — it's the dict key).
    """
    by_disp: dict[str, set[str]] = {}
    try:
        with open(path, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                disp = (row.get('dispensary') or '').strip()
                if not disp:
                    continue
                brand  = (row.get('brand')   or '').lower().strip()
                source = (row.get('source')  or 'weedmaps').lower().strip()
                try:
                    g     = round(float(row.get('grams') or 0), 1)
                    grams = str(int(g)) if g == int(g) else str(g)
                except (ValueError, TypeError):
                    grams = '0'
                by_disp.setdefault(disp, set()).add(f"{brand}||{grams}||{source}")
    except Exception:
        pass
    return by_disp


def _top_2_days(days: list[int]) -> list[int]:
    """Return up to the 2 most-common weekdays (0=Mon, 6=Sun), frequency-desc."""
    if not days:
        return []
    return [d for d, _ in Counter(days).most_common(2)]


def _hour_range(hours: list[int]) -> list[int] | None:
    """Return [lo, hi] covering the central ~80% of restock hours."""
    if not hours:
        return None
    s = sorted(hours)
    trim = max(0, len(s) // 10)
    trimmed = s[trim : len(s) - trim] if trim and len(s) - 2 * trim >= 1 else s
    return [trimmed[0], trimmed[-1]]


def _confidence(days: list[int], event_count: int) -> float:
    """0–1 reflecting how strongly restocks cluster on specific days of the week.

    Logic:
      - max_frac: fraction of events on the single most-common day
      - Normalize against a uniform-7-day baseline (1/7 ≈ 0.143)
      - Scale down for small samples (full weight at 6+ events)
    """
    if event_count < 2:
        return 0.0
    max_frac    = Counter(days).most_common(1)[0][1] / event_count
    day_score   = max(0.0, (max_frac - 1 / 7) / (1 - 1 / 7))
    sample_wt   = min(1.0, event_count / 6)
    return round(day_score * sample_wt, 3)


def _load() -> dict:
    try:
        with open(PATTERNS_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def _save(patterns: dict):
    with open(PATTERNS_FILE, 'w', encoding='utf-8') as f:
        json.dump(patterns, f, indent=2)


def update() -> dict:
    """Re-scan all snapshot CSVs to detect per-dispensary restock events.

    A restock event = new listings appearing at a dispensary compared to the
    most recent prior snapshot containing that dispensary (within _GAP_DAYS).

    No-ops silently if snapshots/ is absent.  Safe to call even before any
    scrape data exists.
    """
    if not os.path.isdir(SNAPSHOTS_DIR):
        return {}

    snap_names = sorted(f for f in os.listdir(SNAPSHOTS_DIR) if f.endswith('.csv'))
    if len(snap_names) < 2:
        return {}

    # Per-dispensary accumulators
    disp_data: dict[str, dict]      = {}
    prev_keys: dict[str, set]       = {}   # disp → listing-key set from last seen snap
    prev_dt:   dict[str, datetime]  = {}   # disp → datetime of that snap

    for snap_name in snap_names:
        snap_dt = _parse_snap_dt(snap_name)
        if snap_dt is None:
            continue
        snap_path = os.path.join(SNAPSHOTS_DIR, snap_name)
        by_disp   = _read_snap(snap_path)

        for disp, cur_keys in by_disp.items():
            if disp not in disp_data:
                disp_data[disp] = {
                    'events':     [],
                    'snaps_seen': 0,
                    'first':      snap_name[:10],
                    'last':       snap_name[:10],
                }
            d = disp_data[disp]
            d['snaps_seen'] += 1
            d['last'] = snap_name[:10]

            old_keys = prev_keys.get(disp)
            old_dt   = prev_dt.get(disp)
            if old_keys is not None and old_dt is not None:
                gap = (snap_dt - old_dt).total_seconds() / 86400
                if gap <= _GAP_DAYS and cur_keys - old_keys:
                    d['events'].append(snap_dt.isoformat())

            prev_keys[disp] = cur_keys
            prev_dt[disp]   = snap_dt

    # Build final patterns dict
    patterns: dict[str, dict] = {}
    for disp, d in disp_data.items():
        events = d['events']
        n      = len(events)
        days:  list[int] = []
        hours: list[int] = []
        for iso in events:
            try:
                dt = datetime.fromisoformat(iso)
                days.append(dt.weekday())
                hours.append(dt.hour)
            except (ValueError, TypeError):
                pass

        patterns[disp] = {
            'restock_events':      events,
            'restock_event_count': n,
            'top_days':            _top_2_days(days),
            'hour_range':          _hour_range(hours),
            'confidence':          _confidence(days, n),
            'snapshots_analyzed':  d['snaps_seen'],
            'first_snapshot_date': d['first'],
            'last_snapshot_date':  d['last'],
        }

    _save(patterns)
    return patterns


def get_patterns() -> dict:
    """Return stored patterns (for /api/restock)."""
    return _load()
