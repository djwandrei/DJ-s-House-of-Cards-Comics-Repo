#!/usr/bin/env python3
"""Sync confirmed legacy Beckett title and price updates into Supabase.

The static product files are rebuilt from the Beckett Legacy workbook, but the
live storefront reads Supabase when backend mode is enabled. This script patches
only the buyer-facing fields that the workbook owns, leaving remote media and
admin-only fields untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKBOOK = (
    Path.home()
    / "Documents"
    / "eBay Docs"
    / "Listing Automation"
    / "Beckett Legacy Pricing Review.xlsx"
)
REPORT_PATH = ROOT / "outputs" / "supabase-legacy-sync-report.json"
SUPABASE_URL = "https://gkqdymnmczabcggvigce.supabase.co"
SUPABASE_KEY = "sb_publishable_BHrJWQtop2ovkpOMOd9w3A_-9MTaeGG"
ADMIN_EMAIL = "djwandrei@gmail.com"


def request_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None, body: Any = None) -> Any:
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: {error.code} {detail}") from error


def auth_token(password: str) -> str:
    url = f"{SUPABASE_URL}/auth/v1/token?grant_type=password"
    headers = {
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
    }
    data = request_json(url, method="POST", headers=headers, body={"email": ADMIN_EMAIL, "password": password})
    token = str((data or {}).get("access_token") or "").strip()
    if not token:
        raise RuntimeError("Supabase auth did not return an access token.")
    return token


def get_headers(ws) -> dict[str, int]:
    return {str(cell.value).strip(): cell.column - 1 for cell in ws[1] if cell.value}


def matched_legacy_ids(workbook_path: Path) -> set[int]:
    wb = load_workbook(workbook_path, read_only=True, data_only=True)
    ws = wb["Legacy Beckett Pricing"]
    headers = get_headers(ws)
    product_col = headers["Product ID"]
    status_col = headers["Match Status"]
    title_col = headers["Beckett Matched Title"]
    ids: set[int] = set()

    for row in ws.iter_rows(min_row=2, values_only=True):
        try:
            product_id = int(row[product_col])
        except (TypeError, ValueError):
            continue
        status = str(row[status_col] or "").strip().lower()
        title = str(row[title_col] or "").strip()
        if status == "matched" and title:
            ids.add(product_id)

    return ids


def to_remote_patch(product: dict[str, Any]) -> dict[str, Any]:
    price = product.get("price")
    year = product.get("year")
    return {
        "name": str(product.get("name") or "").strip(),
        "team": str(product.get("team") or "").strip(),
        "year": int(year) if isinstance(year, int) or str(year or "").isdigit() else None,
        "condition": str(product.get("condition") or "").strip(),
        "price": price if isinstance(price, (int, float)) else None,
        "price_label": str(product.get("priceLabel") or "").strip(),
        "display_price": str(product.get("displayPrice") or "").strip(),
        "league": str(product.get("league") or "").strip(),
        "sport": str(product.get("sport") or "").strip(),
        "player_athlete": str(product.get("playerAthlete") or "").strip(),
    }


def get_remote_rows(ids: list[int], token: str) -> dict[int, dict[str, Any]]:
    if not ids:
        return {}
    id_list = ",".join(str(item) for item in ids)
    query = urllib.parse.urlencode({"select": "id,name,price_label"})
    url = f"{SUPABASE_URL}/rest/v1/products?{query}&id=in.({id_list})"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    rows = request_json(url, headers=headers) or []
    return {int(row["id"]): row for row in rows}


def patch_remote_product(product_id: int, patch: dict[str, Any], token: str) -> None:
    query = urllib.parse.urlencode({"id": f"eq.{product_id}"})
    url = f"{SUPABASE_URL}/rest/v1/products?{query}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    request_json(url, method="PATCH", headers=headers, body=patch)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    parser.add_argument("--password", default=os.environ.get("SUPABASE_ADMIN_PASSWORD", ""))
    parser.add_argument("--delay", type=float, default=0.02)
    args = parser.parse_args()

    if not args.password:
        raise SystemExit("Set SUPABASE_ADMIN_PASSWORD or pass --password.")

    products = {int(item["id"]): item for item in json.loads((ROOT / "products.json").read_text(encoding="utf-8"))}
    ids = sorted(product_id for product_id in matched_legacy_ids(args.workbook) if product_id in products)
    token = auth_token(args.password)
    before = get_remote_rows(ids, token)

    changed: list[dict[str, Any]] = []
    for product_id in ids:
        product = products[product_id]
        remote = before.get(product_id, {})
        if (
            str(remote.get("name") or "").strip() == str(product.get("name") or "").strip()
            and str(remote.get("price_label") or "").strip() == str(product.get("priceLabel") or "").strip()
        ):
            continue

        patch = to_remote_patch(product)
        patch_remote_product(product_id, patch, token)
        changed.append(
            {
                "id": product_id,
                "oldName": remote.get("name", ""),
                "newName": product.get("name", ""),
                "oldPriceLabel": remote.get("price_label", ""),
                "newPriceLabel": product.get("priceLabel", ""),
            }
        )
        time.sleep(max(0, args.delay))

    after = get_remote_rows(ids, token)
    remaining = []
    for product_id in ids:
        local = products[product_id]
        remote = after.get(product_id, {})
        if (
            str(remote.get("name") or "").strip() != str(local.get("name") or "").strip()
            or str(remote.get("price_label") or "").strip() != str(local.get("priceLabel") or "").strip()
        ):
            remaining.append(
                {
                    "id": product_id,
                    "localName": local.get("name", ""),
                    "remoteName": remote.get("name", ""),
                    "localPriceLabel": local.get("priceLabel", ""),
                    "remotePriceLabel": remote.get("price_label", ""),
                }
            )

    report = {
        "matchedLegacyRows": len(ids),
        "changedRows": len(changed),
        "remainingMismatches": len(remaining),
        "changed": changed,
        "remaining": remaining,
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if not remaining else 1


if __name__ == "__main__":
    raise SystemExit(main())
