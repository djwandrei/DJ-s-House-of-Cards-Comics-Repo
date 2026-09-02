#!/usr/bin/env python3
"""Verify current local asset references and review deleted-product-only assets."""

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
DISPLAY_PRODUCT_ASSET_FIELDS = (
    "image",
    "imageGallery",
)
OPERATIONAL_PRODUCT_ASSET_FIELDS = (
    "itemPhotoUrl",
    "itemPhotoUrls",
    "htmlImageUrls",
    "legacyImageLabel",
)
PRODUCT_ASSET_FIELDS = DISPLAY_PRODUCT_ASSET_FIELDS + OPERATIONAL_PRODUCT_ASSET_FIELDS
THUMBNAIL_ELIGIBLE_ROOTS = {
    "baseball-cards",
    "basketball-cards",
    "collectibles",
    "comics",
    "ebay listing photos",
    "personal collection",
    "football-cards",
}
IGNORED_REFERENCE_ROOTS = {
    ".codex",
    ".deploy",
    ".git",
    ".superdesign",
    "assets",
    "dist",
    "node_modules",
    "output",
    "outputs",
    "supabase-analytics",
    "supabase-sports-analytics",
    "tmp",
    ".tmp",
}
NON_STOREFRONT_REFERENCE_ROOTS = {
    ".github",
    ".githooks",
    ".shopify",
    "docs",
    "Optimization Research",
    "prototypes",
    "reports",
    "scripts",
    "supabase",
    "supabase-analytics-pbp",
}
# Catalog data is handled separately below.  Other text files should be small
# source/configuration files; skipping oversized exports avoids reading private
# analytics dumps that cannot be deployed as storefront source.
MAX_REFERENCE_FILE_BYTES = 2 * 1024 * 1024


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


def product_asset_paths(
    product: dict[str, Any], fields: tuple[str, ...] = PRODUCT_ASSET_FIELDS
) -> set[str]:
    output: set[str] = set()
    for field in fields:
        value = product.get(field)
        values = value if isinstance(value, list) else [value]
        for item in values:
            path = normalize_asset_path(item)
            if path:
                output.add(path)
    return output


def generated_thumbnail_path(asset: str) -> str:
    """Mirror the optional storefront thumbnail convention from core.js."""
    path = Path(asset)
    if (
        not asset.lower().startswith("assets/")
        or asset.lower().startswith("assets/thumbnails/")
        or len(path.parts) < 3
        or path.parts[1].lower() not in THUMBNAIL_ELIGIBLE_ROOTS
        or path.suffix.lower() == ".svg"
    ):
        return ""
    return (Path("assets/thumbnails") / Path(*path.parts[1:])).with_suffix(".webp").as_posix()


def source_text_files(root: Path) -> list[Path]:
    """Return tracked or unignored source files without walking bulk-data trees."""
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    files: list[Path] = []
    seen: set[Path] = set()
    for raw_path in result.stdout.decode("utf-8", errors="surrogateescape").split("\0"):
        if not raw_path:
            continue
        path = root / raw_path
        relative = path.relative_to(root)
        if (
            not path.is_file()
            or path.suffix.lower() not in TEXT_SUFFIXES
            or (
                relative.parts
                and relative.parts[0]
                in IGNORED_REFERENCE_ROOTS | NON_STOREFRONT_REFERENCE_ROOTS
            )
        ):
            continue
        try:
            if path.stat().st_size > MAX_REFERENCE_FILE_BYTES:
                continue
        except OSError:
            continue
        if path not in seen:
            seen.add(path)
            files.append(path)
    return files


def scan_site_references(root: Path) -> tuple[dict[str, set[str]], int]:
    references: dict[str, set[str]] = defaultdict(set)
    source_files = source_text_files(root)
    for path in source_files:
        relative = path.relative_to(root)
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
    return references, len(source_files)


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
    current_operational_refs: dict[str, set[int]] = defaultdict(set)
    for product_id, product in current_by_id.items():
        for asset in product_asset_paths(product, DISPLAY_PRODUCT_ASSET_FIELDS):
            current_product_refs[asset].add(product_id)
        for asset in product_asset_paths(product, OPERATIONAL_PRODUCT_ASSET_FIELDS):
            current_operational_refs[asset].add(product_id)
    site_refs, scanned_source_file_count = scan_site_references(root)
    required_assets = set(current_product_refs) | set(site_refs)
    missing_required = sorted(
        asset for asset in required_assets if not (root / asset).is_file()
    )
    optional_thumbnail_assets = sorted(
        thumbnail
        for asset in current_product_refs
        if (thumbnail := generated_thumbnail_path(asset))
        and not (root / thumbnail).is_file()
    )
    missing_operational_assets = sorted(
        asset for asset in current_operational_refs if not (root / asset).is_file()
    )

    deleted_refs: dict[str, set[int]] = defaultdict(set)
    for product_id in removed_ids:
        for asset in product_asset_paths(old_by_id[product_id], DISPLAY_PRODUCT_ASSET_FIELDS):
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
        "currentOperationalAssetReferenceCount": len(current_operational_refs),
        "siteAssetReferenceCount": len(site_refs),
        "scannedSourceFileCount": scanned_source_file_count,
        "requiredLocalAssetCount": len(required_assets),
        "requiredAssets": sorted(required_assets),
        "missingRequiredAssets": missing_required,
        "missingOperationalAssets": missing_operational_assets,
        "missingOptionalThumbnailAssets": optional_thumbnail_assets,
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
                if key not in {
                    "moves",
                    "protectedDeletedAssets",
                    "removedProductIds",
                    "requiredAssets",
                    "missingRequiredAssets",
                    "missingOperationalAssets",
                    "missingOptionalThumbnailAssets",
                }
            }
            | {
                "removedProductIdCount": len(removed_ids),
                "missingRequiredAssetCount": len(missing_required),
                "missingOperationalAssetCount": len(missing_operational_assets),
                "missingOptionalThumbnailCount": len(optional_thumbnail_assets),
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
