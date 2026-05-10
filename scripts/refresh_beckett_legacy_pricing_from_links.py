#!/usr/bin/env python3
"""Refresh Beckett Legacy workbook pricing from reviewed Beckett links.

This is intentionally narrower than the search/matching scripts: it trusts the
URLs DJ reviewed in the workbook and only pulls title + pricing data from those
exact Beckett item pages. That keeps manual match decisions intact while making
the pricing columns repeatable.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
DOCS = Path.home() / "Documents" / "eBay Docs" / "Listing Automation"
DEFAULT_WORKBOOK = DOCS / "Beckett Legacy Pricing Review.xlsx"
DEFAULT_CACHE = DOCS / "beckett_legacy_pricing_cache.json"
BACKUP_ROOT = DOCS / "backups"
REPORT_PATH = ROOT / "outputs" / "beckett-legacy-link-refresh-report.json"
SHEETS = ("Legacy Beckett Pricing", "No Beckett Match")
MONEY_RE = re.compile(r"\$?\s*(?:\d[\d,]*(?:\.\d+)?|\.\d+)")
REAL_TIME_RE = re.compile(
    r"Beckett\s+Real\s+Time\s+Pricing\s*(\$?\s*\d[\d,]*(?:\.\d+)?)\s*to\s*(\$?\s*\d[\d,]*(?:\.\d+)?)",
    re.I,
)
GRADE_RE = re.compile(r"\b(PSA|BGS|SGC|CGC|HGA|BCCG|GAI)\s*(10|[1-9](?:\.\d)?)\b", re.I)


def money_to_float(value: Any) -> float | None:
    match = MONEY_RE.search(str(value or ""))
    if not match:
        return None
    try:
        return float(match.group(0).replace("$", "").replace(",", ""))
    except ValueError:
        return None


def format_money(value: float) -> str:
    return f"${value:,.2f}"


def normalize_price_label(value: Any) -> str:
    values = [money_to_float(match.group(0)) for match in MONEY_RE.finditer(str(value or ""))]
    values = [value for value in values if value is not None]
    if not values:
        return "N/A" if re.search(r"\bN/A\b", str(value or ""), re.I) else ""
    if len(values) == 1:
        return format_money(values[0])
    low, high = min(values[:2]), max(values[:2])
    return f"{format_money(low)}-{format_money(high)}"


def price_range(price_map: dict[str, str]) -> str:
    values = [money_to_float(value) for value in price_map.values()]
    values = [value for value in values if value is not None]
    if not values:
        return ""
    low, high = min(values), max(values)
    return format_money(low) if low == high else f"{format_money(low)}-{format_money(high)}"


def normalize_spaces(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def is_confirmed_status(value: Any) -> bool:
    status = normalize_spaces(value).lower()
    return (
        status == "matched"
        or status == "now matched"
        or status.startswith("confirmed")
        or (status.startswith("match") and "no " not in status)
    )


def is_graded(condition: Any) -> bool:
    return bool(GRADE_RE.search(str(condition or "")))


def raw_grade_basis(condition: Any) -> str:
    text = str(condition or "").upper()
    padded = f" {text} "
    ordered = [
        ("NM-MT+", ["NM-MT+", "NEAR MINT-MINT+"]),
        ("NM-MT", ["NM-MT", "NEAR MINT-MINT"]),
        ("MINT", ["MINT", " MT "]),
        ("NM", ["NEAR MINT", "NRMT", " NM "]),
        ("EX-MT", ["EX-MT", "EXMT"]),
        ("EX", ["EXCELLENT", " EX "]),
        ("VG-EX", ["VG-EX", "VGEX"]),
        ("VG", ["VERY GOOD", " VG "]),
        ("GOOD", ["GOOD"]),
        ("POOR", ["POOR"]),
    ]
    for label, needles in ordered:
        if any(needle in padded or needle in text for needle in needles):
            return label
    return ""


def matched_grade_price(condition: Any, raw_prices: dict[str, str], graded_prices: dict[str, str]) -> tuple[str, str]:
    condition_text = str(condition or "")
    grade_match = GRADE_RE.search(condition_text)
    if grade_match and graded_prices:
        grade = float(grade_match.group(2))
        rounded = int(grade) if grade.is_integer() else int(grade) + 1
        for label, price in graded_prices.items():
            match = re.search(r"\(\s*(\d+(?:\.\d+)?)\s*\)", label)
            if match and int(math.ceil(float(match.group(1)))) == rounded:
                return normalize_price_label(price), label
    basis = raw_grade_basis(condition_text)
    if basis and raw_prices:
        for label, price in raw_prices.items():
            if normalize_key(label) == normalize_key(basis):
                return normalize_price_label(price), label
    return "", ""


def parse_price_rows(rows: list[list[str]]) -> list[dict[str, str]]:
    maps: list[dict[str, str]] = []
    for idx, row in enumerate(rows):
        price_cells = [MONEY_RE.search(cell).group(0) for cell in row if MONEY_RE.search(cell)]
        if len(price_cells) < 2:
            continue
        labels: list[str] = []
        if idx > 0:
            labels = [cell for cell in rows[idx - 1] if not MONEY_RE.search(cell)]
        if len(labels) != len(price_cells):
            non_prices = [cell for cell in row if not MONEY_RE.search(cell)]
            if len(non_prices) == len(price_cells):
                labels = non_prices
        if len(labels) == len(price_cells):
            maps.append({normalize_spaces(label): normalize_price_label(price) for label, price in zip(labels, price_cells)})
    return maps


def classify_price_maps(maps: list[dict[str, str]]) -> tuple[dict[str, str], dict[str, str]]:
    raw: dict[str, str] = {}
    graded: dict[str, str] = {}
    for price_map in maps:
        labels = " ".join(price_map.keys()).lower()
        if re.search(r"\(\s*(10|9|8|7|6|5|4|3|2|1)\s*\)", labels):
            graded.update(price_map)
        elif any(label in labels.upper() for label in ["NM-MT", "VG-EX", "MINT", "GOOD", "POOR"]):
            raw.update(price_map)
        elif not raw:
            raw.update(price_map)
    return raw, graded


def parse_realtime_pricing(soup: BeautifulSoup) -> str:
    rt_heading = soup.select_one(".rtHad")
    if rt_heading:
        text = rt_heading.parent.get_text(" ", strip=True)
        match = REAL_TIME_RE.search(text)
        if match:
            return normalize_price_label(f"{match.group(1)}-{match.group(2)}")
        if re.search(r"Beckett\s+Real\s+Time\s+Pricing\s+N/A\b", text, flags=re.I):
            return "N/A"
    text = soup.get_text(" ", strip=True)
    match = REAL_TIME_RE.search(text)
    if match:
        return normalize_price_label(f"{match.group(1)}-{match.group(2)}")
    return "N/A" if re.search(r"Beckett\s+Real\s+Time\s+Pricing\s+N/A\b", text, flags=re.I) else ""


def parse_card_page(html: str) -> dict[str, Any]:
    soup = BeautifulSoup(html, "html.parser")
    title = ""
    for heading in soup.find_all("h1"):
        text = normalize_spaces(heading.get_text(" ", strip=True))
        if text and "beckett real time pricing" not in text.lower():
            title = text
            break
    rows_by_table: list[list[list[str]]] = []
    for table in soup.find_all("table"):
        rows: list[list[str]] = []
        for tr in table.find_all("tr"):
            cells = [normalize_spaces(cell.get_text(" ", strip=True)) for cell in tr.find_all(["th", "td"])]
            cells = [cell for cell in cells if cell]
            if cells:
                rows.append(cells)
        if any(MONEY_RE.search(cell) for row in rows for cell in row):
            rows_by_table.append(rows)
    maps: list[dict[str, str]] = []
    for rows in rows_by_table:
        maps.extend(parse_price_rows(rows))
    raw_prices, graded_prices = classify_price_maps(maps)
    return {
        "title": title,
        "real_time_pricing": parse_realtime_pricing(soup),
        "raw_prices": raw_prices,
        "graded_prices": graded_prices,
        "raw_range": price_range(raw_prices),
        "graded_range": price_range(graded_prices),
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
    }


def load_cache(path: Path) -> dict[str, Any]:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"searches": {}, "cards": {}, "completed": {}}


def save_cache(path: Path, cache: dict[str, Any]) -> None:
    path.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_card(url: str, session: Any, cache: dict[str, Any], delay: float, force: bool) -> dict[str, Any]:
    cards = cache.setdefault("cards", {})
    cached = cards.get(url)
    if cached and not force and cached.get("real_time_pricing") and cached.get("raw_prices") is not None:
        return cached
    time.sleep(max(0, delay))
    response = session.get(url, timeout=60)
    response.raise_for_status()
    card = parse_card_page(response.text)
    existing = cached if isinstance(cached, dict) else {}
    existing.update(card)
    cards[url] = existing
    return existing


def get_headers(ws) -> dict[str, int]:
    return {str(cell.value).strip(): cell.column for cell in ws[1] if cell.value}


def backup_workbook(workbook_path: Path) -> Path:
    backup_dir = BACKUP_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S-beckett-link-refresh")
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / workbook_path.name
    shutil.copy2(workbook_path, backup_path)
    return backup_path


def row_needs_refresh(sheet_name: str, row: dict[str, Any], force: bool) -> bool:
    if force:
        return True
    if sheet_name == "No Beckett Match":
        return True
    important = ("Beckett Real Time Pricing", "Beckett Price Range", "Beckett Raw Range")
    return any(not normalize_spaces(row.get(header)) for header in important)


def workbook_price_range(row: dict[str, Any], raw_range: str, graded_range: str, realtime: str) -> str:
    """Return the price range the workbook should show for this reviewed row.

    DJ's rule for legacy rows is intentionally simple: graded cards use the
    grade-aware Beckett values, while ungraded cards use Beckett Real Time
    Pricing when Beckett exposes it. Raw guide ranges remain a fallback for
    pages where real-time pricing is unavailable.
    """
    if is_graded(row.get("Current Grade / Condition")):
        return graded_range or raw_range or ("" if realtime == "N/A" else realtime)
    return ("" if realtime == "N/A" else realtime) or raw_range


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--beckett-email", default=os.environ.get("BECKETT_EMAIL", ""))
    parser.add_argument("--beckett-password", default=os.environ.get("BECKETT_PASSWORD", ""))
    parser.add_argument("--delay", type=float, default=0.12)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not args.beckett_email or not args.beckett_password:
        raise SystemExit("Set BECKETT_EMAIL/BECKETT_PASSWORD or pass --beckett-email/--beckett-password.")

    sys.path.insert(0, str(ROOT / "scripts"))
    from beckett_legacy_pricing import create_session  # type: ignore

    cache = load_cache(args.cache)
    backup_path = backup_workbook(args.workbook)
    wb = load_workbook(args.workbook)
    session = create_session(args.beckett_email, args.beckett_password)
    stats: Counter[str] = Counter()
    errors: list[dict[str, Any]] = []
    changed: list[dict[str, Any]] = []
    refreshed_this_run: set[str] = set()

    for sheet_name in SHEETS:
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        headers = get_headers(ws)
        required = {
            "Match Status",
            "Beckett URL",
            "Beckett Matched Title",
            "Beckett Price Range",
            "Beckett Raw Range",
            "Beckett Graded Range",
            "Beckett Matched Grade Price",
            "Beckett Matched Grade Basis",
            "Beckett Real Time Pricing",
            "Current Grade / Condition",
        }
        missing_headers = sorted(required - set(headers))
        if missing_headers:
            raise RuntimeError(f"{sheet_name} is missing headers: {missing_headers}")

        for row_index in range(2, ws.max_row + 1):
            row = {header: ws.cell(row_index, column).value for header, column in headers.items()}
            url = normalize_spaces(row.get("Beckett URL"))
            if not url or not is_confirmed_status(row.get("Match Status")):
                continue
            cached_card = cache.get("cards", {}).get(url)
            needs_refresh = row_needs_refresh(sheet_name, row, args.force)
            if not needs_refresh and isinstance(cached_card, dict):
                # Complete rows can still have stale manually edited title/price cells.
                # Reconcile them from the cached Beckett page without another network hit.
                card = cached_card
                stats["used_cached_complete"] += 1
            elif not needs_refresh:
                stats["skipped_complete"] += 1
                continue
            else:
                try:
                    # During a forced refresh, only re-fetch each unique Beckett URL once.
                    # Duplicate workbook rows can then reuse the freshly updated cache entry.
                    force_fetch = args.force and url not in refreshed_this_run
                    card = fetch_card(url, session, cache, args.delay, force_fetch)
                    refreshed_this_run.add(url)
                except Exception as error:  # noqa: BLE001 - report per row and continue.
                    errors.append({"sheet": sheet_name, "row": row_index, "url": url, "error": str(error)})
                    stats["errors"] += 1
                    continue

            raw_range = normalize_price_label(card.get("raw_range")) or price_range(card.get("raw_prices") or {})
            graded_range = normalize_price_label(card.get("graded_range")) or price_range(card.get("graded_prices") or {})
            realtime = normalize_price_label(card.get("real_time_pricing"))
            price_range_label = workbook_price_range(row, raw_range, graded_range, realtime)
            matched_price, matched_basis = matched_grade_price(
                row.get("Current Grade / Condition"),
                card.get("raw_prices") or {},
                card.get("graded_prices") or {},
            )

            before = {
                "title": row.get("Beckett Matched Title"),
                "price": row.get("Beckett Price Range"),
                "raw": row.get("Beckett Raw Range"),
                "graded": row.get("Beckett Graded Range"),
                "matched": row.get("Beckett Matched Grade Price"),
                "basis": row.get("Beckett Matched Grade Basis"),
                "realtime": row.get("Beckett Real Time Pricing"),
            }
            if card.get("title"):
                ws.cell(row_index, headers["Beckett Matched Title"]).value = card["title"]
            if price_range_label:
                ws.cell(row_index, headers["Beckett Price Range"]).value = price_range_label
            if raw_range:
                ws.cell(row_index, headers["Beckett Raw Range"]).value = raw_range
            ws.cell(row_index, headers["Beckett Graded Range"]).value = graded_range
            if matched_price:
                ws.cell(row_index, headers["Beckett Matched Grade Price"]).value = matched_price
            if matched_basis:
                ws.cell(row_index, headers["Beckett Matched Grade Basis"]).value = matched_basis
            if realtime:
                ws.cell(row_index, headers["Beckett Real Time Pricing"]).value = realtime

            after = {
                "title": ws.cell(row_index, headers["Beckett Matched Title"]).value,
                "price": ws.cell(row_index, headers["Beckett Price Range"]).value,
                "raw": ws.cell(row_index, headers["Beckett Raw Range"]).value,
                "graded": ws.cell(row_index, headers["Beckett Graded Range"]).value,
                "matched": ws.cell(row_index, headers["Beckett Matched Grade Price"]).value,
                "basis": ws.cell(row_index, headers["Beckett Matched Grade Basis"]).value,
                "realtime": ws.cell(row_index, headers["Beckett Real Time Pricing"]).value,
            }
            if before != after:
                changed.append({"sheet": sheet_name, "row": row_index, "url": url, "before": before, "after": after})
                stats["changed_rows"] += 1
            else:
                stats["unchanged_rows"] += 1

    for ws in wb.worksheets:
        headers = get_headers(ws)
        for header in ("Beckett Real Time Pricing", "Beckett Price Range", "Beckett Raw Range", "Beckett Graded Range"):
            if header in headers:
                ws.column_dimensions[ws.cell(1, headers[header]).column_letter].width = 24

    wb.save(args.workbook)
    save_cache(args.cache, cache)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    report = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "workbook": str(args.workbook),
        "backup": str(backup_path),
        "stats": dict(stats),
        "errorCount": len(errors),
        "errors": errors[:50],
        "changedCount": len(changed),
        "changedSample": changed[:50],
    }
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
