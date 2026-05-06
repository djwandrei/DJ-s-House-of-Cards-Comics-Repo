#!/usr/bin/env python3
"""Sync the latest Cards to remove/add workbook delta into Supabase.

The add/remove importer updates the static catalog first, then writes a JSON
report describing which rows were added, removed, or had photos replaced. This
script uses that report as the source of truth for the remote backend so we do
not have to push the entire catalog for a small batch update.
"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPORT = ROOT / "outputs" / "cards-remove-add-report.json"
DEFAULT_PRODUCTS = ROOT / "products.json"
SYNC_REPORT = ROOT / "outputs" / "supabase-cards-add-remove-sync-report.json"
SUPABASE_URL = "https://gkqdymnmczabcggvigce.supabase.co"
SUPABASE_KEY = "sb_publishable_BHrJWQtop2ovkpOMOd9w3A_-9MTaeGG"
ADMIN_EMAIL = "djwandrei@gmail.com"


def request_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None, body: Any = None) -> Any:
    payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=payload, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed: {error.code} {detail}") from error


def admin_token(password: str) -> str:
    response = request_json(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json"},
        body={"email": ADMIN_EMAIL, "password": password},
    )
    token = str((response or {}).get("access_token") or "").strip()
    if not token:
        raise RuntimeError("Supabase auth did not return an access token.")
    return token


def product_id(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def report_ids(report: dict[str, Any]) -> tuple[list[int], list[int]]:
    upsert_ids: set[int] = set()
    delete_ids: set[int] = set()

    for row in report.get("added", []):
        item_id = product_id(row.get("productId"))
        if item_id is not None:
            upsert_ids.add(item_id)

    for row in report.get("photoReplacements", []):
        item_id = product_id(row.get("productId"))
        if item_id is not None:
            upsert_ids.add(item_id)

    for row in report.get("removed", []):
        item_id = product_id(row.get("productId"))
        if item_id is not None:
            delete_ids.add(item_id)

    return sorted(upsert_ids), sorted(delete_ids)


def to_remote_row(product: dict[str, Any]) -> dict[str, Any]:
    """Convert the storefront product shape into the Supabase table shape."""

    price = product.get("price")
    year = product.get("year")
    return {
        "id": product.get("id"),
        "name": str(product.get("name") or "").strip(),
        "category": str(product.get("category") or "").strip(),
        "team": str(product.get("team") or "").strip(),
        "year": int(year) if isinstance(year, int) or str(year or "").isdigit() else None,
        "condition": str(product.get("condition") or "").strip(),
        "price": price if isinstance(price, (int, float)) else None,
        "price_label": str(product.get("priceLabel") or "").strip(),
        "image": str(product.get("image") or "").strip(),
        "image_gallery": product.get("imageGallery") or [],
        "description": str(product.get("description") or "").strip(),
        "photo_host_page_url": str(product.get("photoHostPageUrl") or "").strip(),
        "legacy_image_label": str(product.get("legacyImageLabel") or "").strip(),
        "source_page": str(product.get("sourcePage") or "").strip(),
        "league": str(product.get("league") or "").strip(),
        "sport": str(product.get("sport") or "").strip(),
        "player_athlete": str(product.get("playerAthlete") or "").strip(),
        "display_price": str(product.get("displayPrice") or product.get("priceLabel") or "").strip(),
        "copy_count": int(product.get("copyCount") or 1),
        "item_photo_url": str(product.get("itemPhotoUrl") or "").strip(),
        "item_photo_urls": product.get("itemPhotoUrls") or [],
        "html_full_link": str(product.get("htmlFullLink") or "").strip(),
        "html_image_urls": product.get("htmlImageUrls") or [],
        "metadata": product.get("metadata") or {},
        "is_featured": bool(product.get("isFeatured")),
        "is_deleted": False,
        "sort_rank": int(product.get("sortRank") or 0),
    }


def chunked(items: list[Any], size: int) -> list[list[Any]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def upsert_products(rows: list[dict[str, Any]], token: str, batch_size: int, delay: float) -> int:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f"{SUPABASE_URL}/rest/v1/products?on_conflict=id"
    total = 0
    for batch in chunked(rows, batch_size):
        request_json(url, method="POST", headers=headers, body=batch)
        total += len(batch)
        time.sleep(max(delay, 0))
    return total


def soft_delete_products(ids: list[int], token: str, batch_size: int, delay: float) -> int:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }
    total = 0
    for batch in chunked(ids, batch_size):
        id_list = ",".join(str(item) for item in batch)
        url = f"{SUPABASE_URL}/rest/v1/products?id=in.({id_list})"
        request_json(url, method="PATCH", headers=headers, body={"is_deleted": True})
        total += len(batch)
        time.sleep(max(delay, 0))
    return total


def count_visible_products(token: str) -> int | None:
    url = f"{SUPABASE_URL}/rest/v1/products?select=id&is_deleted=eq.false"
    request = urllib.request.Request(
        url,
        method="HEAD",
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {token}",
            "Prefer": "count=exact",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        content_range = response.headers.get("Content-Range", "")
    if "/" not in content_range:
        return None
    try:
        return int(content_range.rsplit("/", 1)[1])
    except ValueError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--products", type=Path, default=DEFAULT_PRODUCTS)
    parser.add_argument("--password", default=os.environ.get("SUPABASE_ADMIN_PASSWORD", ""))
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--delay", type=float, default=0.05)
    args = parser.parse_args()

    if not args.password:
        raise SystemExit("Set SUPABASE_ADMIN_PASSWORD or pass --password.")

    report = json.loads(args.report.read_text(encoding="utf-8"))
    products = {int(row["id"]): row for row in json.loads(args.products.read_text(encoding="utf-8"))}
    upsert_ids, delete_ids = report_ids(report)
    upsert_rows = [to_remote_row(products[item_id]) for item_id in upsert_ids if item_id in products]
    missing_local = sorted(set(upsert_ids) - products.keys())

    token = admin_token(args.password)
    upserted = upsert_products(upsert_rows, token, max(args.batch_size, 1), args.delay)
    deleted = soft_delete_products(delete_ids, token, max(args.batch_size, 1), args.delay)
    visible_count = count_visible_products(token)

    sync_report = {
        "report": str(args.report),
        "products": str(args.products),
        "upsertRequested": len(upsert_ids),
        "upserted": upserted,
        "softDeleteRequested": len(delete_ids),
        "softDeleted": deleted,
        "missingLocalUpsertIds": missing_local,
        "remoteVisibleCount": visible_count,
    }
    SYNC_REPORT.parent.mkdir(parents=True, exist_ok=True)
    SYNC_REPORT.write_text(json.dumps(sync_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(sync_report, ensure_ascii=False, indent=2))
    return 0 if not missing_local else 1


if __name__ == "__main__":
    raise SystemExit(main())
