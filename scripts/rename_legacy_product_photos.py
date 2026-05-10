"""Rename legacy product photos to match their current storefront titles.

The storefront references product images from JSON bundles, so every filesystem
move in this script is paired with a reference rewrite and a product-bundle
rebuild. The generated filenames preserve the product title as closely as
Windows and URL-safe paths allow; invalid filename characters are replaced with
readable separators, and extra gallery photos receive a numeric suffix.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from collections import defaultdict
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "outputs" / "legacy-photo-rename-report.json"
PRODUCT_FILES = {
    "products.json": lambda items: items,
    "products-baseball.json": lambda items: [item for item in items if item.get("category") == "Baseball"],
    "products-basketball.json": lambda items: [item for item in items if item.get("category") == "Basketball"],
    "products-football.json": lambda items: [item for item in items if item.get("category") == "Football"],
    "products-comics.json": lambda items: [item for item in items if item.get("category") == "Comics"],
    "products-collectibles.json": lambda items: [item for item in items if item.get("category") == "Collectibles"],
    "products-sports.json": lambda items: [
        item for item in items if item.get("category") in {"Baseball", "Basketball", "Football"}
    ],
    "products-featured.json": lambda items: [item for item in items if item.get("isFeatured")],
}
DATA_BUNDLE_FILES = {
    "products.json": "products-data-full.js",
    "products-baseball.json": "products-data-baseball.js",
    "products-basketball.json": "products-data-basketball.js",
    "products-football.json": "products-data-football.js",
    "products-comics.json": "products-data-comics.js",
    "products-collectibles.json": "products-data-collectibles.js",
    "products-sports.json": "products-data-sports.js",
    "products-featured.json": "products-data-featured.js",
}
IMAGE_LIST_FIELDS = ("imageGallery", "itemPhotoUrls", "htmlImageUrls")
IMAGE_VALUE_FIELDS = ("image", "itemPhotoUrl")
INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1F]')
WHITESPACE_RE = re.compile(r"\s+")
LEGACY_SOURCE_PREFIXES = (
    "Baseball",
    "Basketball",
    "Football",
    "DC",
    "Marvel",
    "Sports Collectibles",
    "Other Comics",
)
EXCLUDED_ASSET_PARTS = {"thumbnails", "fonts", "about-original"}
EXCLUDED_FILENAMES = {
    "placeholder-baseball.svg",
    "placeholder-basketball.svg",
    "placeholder-football.svg",
    "placeholder-comics.svg",
    "placeholder-card.svg",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rename legacy product image files and update product data references.")
    parser.add_argument("--apply", action="store_true", help="Perform moves/copies and rewrite product bundles.")
    parser.add_argument("--max-name-length", type=int, default=180, help="Maximum filename stem length before suffix/ext.")
    return parser.parse_args()


def load_products() -> list[dict[str, Any]]:
    return json.loads((ROOT / "products.json").read_text(encoding="utf-8"))


def is_legacy_product(product: dict[str, Any]) -> bool:
    description = str(product.get("description") or "").lower()
    source_page = str(product.get("sourcePage") or "")
    return bool(
        product.get("legacyImageLabel")
        or description.startswith("imported from the legacy")
        or source_page.startswith(LEGACY_SOURCE_PREFIXES)
    )


def is_local_product_asset(path: str) -> bool:
    if not path or not path.startswith("assets/"):
        return False
    pure = PurePosixPath(path)
    if pure.name in EXCLUDED_FILENAMES:
        return False
    if pure.suffix.lower() not in {".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"}:
        return False
    return not any(part in EXCLUDED_ASSET_PARTS for part in pure.parts)


def normalize_asset_path(path: str) -> str:
    return path.replace("\\", "/").split("?", 1)[0]


def product_image_paths(product: dict[str, Any]) -> list[str]:
    paths: list[str] = []
    for field in IMAGE_VALUE_FIELDS:
        value = product.get(field)
        if isinstance(value, str):
            paths.append(normalize_asset_path(value))
    for field in IMAGE_LIST_FIELDS:
        values = product.get(field)
        if isinstance(values, list):
            paths.extend(normalize_asset_path(value) for value in values if isinstance(value, str))

    seen: set[str] = set()
    unique_paths: list[str] = []
    for path in paths:
        if path in seen or not is_local_product_asset(path):
            continue
        seen.add(path)
        unique_paths.append(path)
    return unique_paths


def safe_filename_stem(title: str, max_length: int) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub(" - ", title)
    cleaned = WHITESPACE_RE.sub(" ", cleaned).strip(" .-_")
    cleaned = cleaned.replace("’", "'")
    if not cleaned:
        cleaned = "legacy-product-photo"
    return cleaned[:max_length].rstrip(" .-_")


def thumbnail_path_for(asset_path: str) -> str:
    pure = PurePosixPath(asset_path)
    if len(pure.parts) < 2:
        return ""
    return str(PurePosixPath("assets", "thumbnails", *pure.parts[1:]).with_suffix(".webp")).replace("\\", "/")


def unique_target(parent: PurePosixPath, stem: str, suffix: str, ext: str, claimed: set[str]) -> str:
    base = f"{stem}{suffix}".strip()
    candidate = str(parent / f"{base}{ext}")
    counter = 2
    while candidate in claimed or ((ROOT / candidate).exists() and candidate not in claimed):
        candidate = str(parent / f"{base} - {counter}{ext}")
        counter += 1
    claimed.add(candidate)
    return candidate.replace("\\", "/")


def preferred_target(old_path: str, parent: PurePosixPath, stem: str, suffix: str, ext: str, claimed: set[str]) -> str:
    """Return the title-matched path without renaming files that already match.

    The script may be run more than once while product data already references
    title-based filenames. In that case, keeping the current path prevents
    accidental " - 2" suffix creep on every rerun.
    """
    desired = str(parent / f"{stem}{suffix}{ext}").replace("\\", "/")
    if old_path == desired:
        claimed.add(desired)
        return desired
    return unique_target(parent, stem, suffix, ext, claimed)


def build_assignments(products: list[dict[str, Any]], max_name_length: int) -> tuple[list[dict[str, Any]], dict[int, dict[str, str]]]:
    assignments: list[dict[str, Any]] = []
    per_product_replacements: dict[int, dict[str, str]] = defaultdict(dict)
    claimed_targets: set[str] = set()

    for product in products:
        if not is_legacy_product(product):
            continue
        paths = product_image_paths(product)
        if not paths:
            continue

        product_id = int(product["id"])
        stem = safe_filename_stem(str(product.get("name") or f"Product {product_id}"), max_name_length)
        for index, old_path in enumerate(paths, start=1):
            pure = PurePosixPath(old_path)
            suffix = "" if index == 1 else f" - {index}"
            new_path = preferred_target(old_path, pure.parent, stem, suffix, pure.suffix.lower(), claimed_targets)
            per_product_replacements[product_id][old_path] = new_path
            assignments.append(
                {
                    "productId": product_id,
                    "productName": product.get("name"),
                    "oldPath": old_path,
                    "newPath": new_path,
                    "thumbnailOldPath": thumbnail_path_for(old_path),
                    "thumbnailNewPath": thumbnail_path_for(new_path),
                }
            )
    return assignments, per_product_replacements


def replace_product_paths(product: dict[str, Any], replacements: dict[str, str]) -> bool:
    changed = False
    for field in IMAGE_VALUE_FIELDS:
        value = product.get(field)
        normalized = normalize_asset_path(value) if isinstance(value, str) else ""
        if normalized in replacements:
            product[field] = replacements[normalized]
            changed = True
    for field in IMAGE_LIST_FIELDS:
        values = product.get(field)
        if not isinstance(values, list):
            continue
        updated_values = [replacements.get(normalize_asset_path(value), value) if isinstance(value, str) else value for value in values]
        if updated_values != values:
            product[field] = updated_values
            changed = True
    metadata = product.get("metadata")
    if isinstance(metadata, dict):
        thumb = normalize_asset_path(metadata.get("thumbnailPath")) if isinstance(metadata.get("thumbnailPath"), str) else ""
        if thumb:
            thumb_replacements = {thumbnail_path_for(old): thumbnail_path_for(new) for old, new in replacements.items()}
            if thumb in thumb_replacements:
                metadata["thumbnailPath"] = thumb_replacements[thumb]
                changed = True
    return changed


def write_json(path: Path, data: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def write_data_bundle(source_name: str, bundle_path: Path, data: list[dict[str, Any]]) -> None:
    serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    bundle_path.write_text(
        f'window.DJ_PRELOADED_SOURCE = "{source_name}";\n'
        f"window.DJ_PRELOADED_PRODUCTS = {serialized}\n"
        ";\n",
        encoding="utf-8",
    )


def rebuild_product_files(products: list[dict[str, Any]]) -> None:
    for source_name, selector in PRODUCT_FILES.items():
        subset = selector(products)
        write_json(ROOT / source_name, subset)
        write_data_bundle(source_name, ROOT / DATA_BUNDLE_FILES[source_name], subset)


def move_or_copy_asset_group(old_path: str, group: list[dict[str, Any]], dry_run: bool) -> tuple[list[dict[str, str]], list[str]]:
    file_ops: list[dict[str, str]] = []
    errors: list[str] = []
    source = ROOT / old_path
    if not source.exists():
        errors.append(f"Missing source asset: {old_path}")
        return file_ops, errors

    unique_targets = []
    seen = set()
    for item in group:
        target = item["newPath"]
        if target not in seen:
            unique_targets.append(target)
            seen.add(target)

    first_target = ROOT / unique_targets[0]
    if not dry_run:
        first_target.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != first_target.resolve():
            if first_target.exists():
                errors.append(f"Target already exists: {unique_targets[0]}")
                return file_ops, errors
            source.rename(first_target)
    file_ops.append({"operation": "move" if old_path != unique_targets[0] else "keep", "from": old_path, "to": unique_targets[0]})

    for target in unique_targets[1:]:
        target_path = ROOT / target
        if not dry_run:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if target_path.exists():
                errors.append(f"Target already exists: {target}")
                continue
            shutil.copy2(first_target, target_path)
        file_ops.append({"operation": "copy", "from": unique_targets[0], "to": target})

    return file_ops, errors


def move_or_copy_thumbnail_group(old_thumb_path: str, target_thumb_paths: list[str], dry_run: bool) -> tuple[list[dict[str, str]], list[str]]:
    file_ops: list[dict[str, str]] = []
    errors: list[str] = []
    source = ROOT / old_thumb_path
    if not old_thumb_path or not source.exists():
        return file_ops, errors

    unique_targets = []
    seen = set()
    for target in target_thumb_paths:
        if target and target not in seen:
            unique_targets.append(target)
            seen.add(target)
    if not unique_targets:
        return file_ops, errors

    first_target = ROOT / unique_targets[0]
    if not dry_run:
        first_target.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != first_target.resolve():
            if first_target.exists():
                errors.append(f"Thumbnail target already exists: {unique_targets[0]}")
                return file_ops, errors
            source.rename(first_target)
    file_ops.append({"operation": "move-thumbnail" if old_thumb_path != unique_targets[0] else "keep-thumbnail", "from": old_thumb_path, "to": unique_targets[0]})

    for target in unique_targets[1:]:
        target_path = ROOT / target
        if not dry_run:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if target_path.exists():
                errors.append(f"Thumbnail target already exists: {target}")
                continue
            shutil.copy2(first_target, target_path)
        file_ops.append({"operation": "copy-thumbnail", "from": unique_targets[0], "to": target})
    return file_ops, errors


def main() -> int:
    args = parse_args()
    products = load_products()
    assignments, per_product_replacements = build_assignments(products, args.max_name_length)

    old_path_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for assignment in assignments:
        old_path_groups[assignment["oldPath"]].append(assignment)

    file_ops: list[dict[str, str]] = []
    errors: list[str] = []
    for old_path, group in old_path_groups.items():
        ops, group_errors = move_or_copy_asset_group(old_path, group, dry_run=not args.apply)
        file_ops.extend(ops)
        errors.extend(group_errors)

    # Some legacy .jpg/.jpeg pairs share one generated thumbnail stem. Process
    # thumbnails as their own groups so one source thumbnail can feed every new
    # title-matched thumbnail path before the original is moved.
    thumbnail_groups: dict[str, list[str]] = defaultdict(list)
    for assignment in assignments:
        old_thumb = assignment["thumbnailOldPath"]
        new_thumb = assignment["thumbnailNewPath"]
        if old_thumb and new_thumb:
            thumbnail_groups[old_thumb].append(new_thumb)

    for old_thumb, target_thumbs in thumbnail_groups.items():
        thumb_ops, thumb_errors = move_or_copy_thumbnail_group(old_thumb, target_thumbs, dry_run=not args.apply)
        file_ops.extend(thumb_ops)
        errors.extend(thumb_errors)

    changed_products = 0
    if args.apply and not errors:
        for product in products:
            replacements = per_product_replacements.get(int(product["id"]), {})
            if replacements and replace_product_paths(product, replacements):
                changed_products += 1
        rebuild_product_files(products)

    report = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "mode": "apply" if args.apply else "dry-run",
        "legacyProductsWithLocalImages": len(per_product_replacements),
        "uniqueSourceAssets": len(old_path_groups),
        "assignmentCount": len(assignments),
        "changedProducts": changed_products if args.apply else 0,
        "fileOperationCount": len(file_ops),
        "errors": errors,
        "sampleAssignments": assignments[:50],
        "sampleFileOperations": file_ops[:80],
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
