#!/usr/bin/env python3
"""Verify current local asset references and quarantine deleted-product-only assets."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote


ASSET_RE = re.compile(r"""(?P<path>assets/[A-Za-z0-9_@%+.,'()&/#\- ]+\.(?:avif|gif|jpe?g|png|svg|webp|woff2?))""", re.IGNORECASE)
TEXT_SUFFIXES = {
    ".css", ".html", ".js", ".json", ".mjs", ".txt", ".webmanifest", ".xml"
}
PRODUCT_ASSET_FIELDS = (
    "image",
    "imageGallery",
    "itemPhotoUrl",
    "itemPhotoUrls",
    "htmlImageUrls",
    "legacyImageLabel",
)
RASTER_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--products", default="products.json")
    parser.add_argument("--old-products", default="")
    parser.add_argument("--output-dir", default="outputs")
    parser.add_argument("--review-dir", default="")
    return parser.parse_args()


def normalize_asset_path(value: Any) -> str:
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return ""
    if raw.lower().startswith(("http://", "https://", "data:", "blob:")):
        return ""
    if "assets/" in raw.lower():
        index = raw.lower().find("assets/")
        raw = raw[index:]
    raw = raw.split("?", 1)[0]
    raw = unquote(raw).lstrip("./").lstrip("/")
    return raw if raw.lower().startswith("assets/") else ""


def product_asset_paths(product: dict[str, Any]) -> set[str]:
    output: set[str] = set()
    for field in PRODUCT_ASSET_FIELDS:
        value = product.get(field)
        values = value if isinstance(value, list) else [value]
        for item in values:
            path = normalize_asset_path(item)
            if path:
                output.add(path)
                path_object = Path(path)
                if (
                    path_object.suffix.lower() in RASTER_SUFFIXES
                    and not path.lower().startswith("assets/thumbnails/")
                ):
                    relative = path_object.relative_to("assets")
                    output.add((Path("assets/thumbnails") / relative).with_suffix(".webp").as_posix())
    return output


def scan_site_references(root: Path) -> dict[str, set[str]]:
    references: dict[str, set[str]] = defaultdict(set)
    ignored_roots = {".git", "assets", "dist", "outputs"}
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        relative = path.relative_to(root)
        if relative.parts and relative.parts[0] in ignored_roots:
            continue
        if relative.name.startswith("products") and relative.suffix.lower() in {".js", ".json"}:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for match in ASSET_RE.finditer(content):
            asset = normalize_asset_path(match.group("path"))
            if asset:
                references[asset].add(relative.as_posix())
    return references


def load_old_products(root: Path, explicit_path: str) -> list[dict[str, Any]]:
    if explicit_path:
        return json.loads(Path(explicit_path).read_text(encoding="utf-8-sig"))
    result = subprocess.run(
        ["git", "show", "HEAD^:products.json"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(result.stdout)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    products_path = (root / args.products).resolve()
    output_dir = (root / args.output_dir).resolve()
    current = json.loads(products_path.read_text(encoding="utf-8"))
    old = load_old_products(root, args.old_products)
    current_by_id = {int(product["id"]): product for product in current}
    old_by_id = {int(product["id"]): product for product in old}
    removed_ids = sorted(set(old_by_id) - set(current_by_id))

    current_product_refs: dict[str, set[int]] = defaultdict(set)
    for product_id, product in current_by_id.items():
        for asset in product_asset_paths(product):
            current_product_refs[asset].add(product_id)
    site_refs = scan_site_references(root)
    required_assets = set(current_product_refs) | set(site_refs)
    missing_required = sorted(
        asset for asset in required_assets if not (root / asset).is_file()
    )

    deleted_refs: dict[str, set[int]] = defaultdict(set)
    for product_id in removed_ids:
        for asset in product_asset_paths(old_by_id[product_id]):
            deleted_refs[asset].add(product_id)
    quarantine_candidates = sorted(
        asset
        for asset in deleted_refs
        if asset not in required_assets and (root / asset).is_file()
    )
    protected_deleted_assets = sorted(
        asset for asset in deleted_refs if asset in required_assets
    )

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    review_relative = (
        Path(args.review_dir)
        if args.review_dir
        else Path("assets") / f"deleted-item-review-{timestamp}"
    )
    review_dir = (root / review_relative).resolve()
    moves: list[dict[str, Any]] = []
    for asset in quarantine_candidates:
        source = (root / asset).resolve()
        destination = review_dir / Path(asset).relative_to("assets")
        listing_ids = sorted(deleted_refs[asset])
        record = {
            "source": asset,
            "destination": destination.relative_to(root).as_posix(),
            "deletedProductIds": listing_ids,
            "deletedProducts": [
                {
                    "id": product_id,
                    "name": old_by_id[product_id].get("name", ""),
                    "category": old_by_id[product_id].get("category", ""),
                }
                for product_id in listing_ids
            ],
        }
        moves.append(record)

    report = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "applied": False,
        "currentProductCount": len(current),
        "oldProductCount": len(old),
        "removedProductIds": removed_ids,
        "currentProductAssetReferenceCount": len(current_product_refs),
        "siteAssetReferenceCount": len(site_refs),
        "requiredLocalAssetCount": len(required_assets),
        "requiredAssets": sorted(required_assets),
        "missingRequiredAssets": missing_required,
        "deletedProductAssetReferenceCount": len(deleted_refs),
        "quarantineCandidateCount": len(quarantine_candidates),
        "protectedDeletedAssetCount": len(protected_deleted_assets),
        "protectedDeletedAssets": protected_deleted_assets,
        "reviewDirectory": review_relative.as_posix(),
        "moves": moves,
    }
    write_json(output_dir / "asset-presence-and-deleted-item-review.json", report)
    print(
        json.dumps(
            {
                key: value
                for key, value in report.items()
                if key not in {"moves", "protectedDeletedAssets", "removedProductIds", "requiredAssets"}
            }
            | {
                "removedProductIdCount": len(removed_ids),
                "moveSample": moves[:5],
            },
            indent=2,
        )
    )
    if missing_required:
        raise RuntimeError(f"{len(missing_required)} required local assets are missing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
