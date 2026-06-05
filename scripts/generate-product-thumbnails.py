"""
Generate non-destructive product thumbnails under assets/thumbnails/.

The script reads product image references from products.json, keeps the original
asset tree intact, and writes WebP thumbnails into a mirrored folder structure:

  <asset-root>/<collection-folder>/<image-file>.jpg
  -> assets/thumbnails/<collection-folder>/<image-file>.webp

This is intentionally separate from the originals so the storefront can use
smaller images for product cards and thumb rails while modal/detail views keep
the full-size files.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageFile, ImageOps

ImageFile.LOAD_TRUNCATED_IMAGES = True

SUPPORTED_RASTER_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass
class ThumbnailResult:
    generated: int = 0
    skipped: int = 0
    missing: int = 0
    errors: int = 0
    original_bytes: int = 0
    thumbnail_bytes: int = 0


def iter_catalog_images(products: list[dict]) -> Iterable[str]:
    seen: set[str] = set()
    for product in products:
      for value in [product.get("image"), *(product.get("imageGallery") or [])]:
        image_path = str(value or "").strip()
        if not image_path.lower().startswith("assets/"):
            continue
        if image_path in seen:
            continue
        seen.add(image_path)
        yield image_path


def thumbnail_path_for(root: Path, asset_path: str) -> Path:
    relative = Path(asset_path.replace("\\", "/")).relative_to("assets")
    return (root / "assets" / "thumbnails" / relative).with_suffix(".webp")


def source_path_for(root: Path, asset_path: str) -> Path:
    return root / Path(asset_path.replace("\\", "/"))


def generate_thumbnail(source_path: Path, target_path: Path, max_size: int, quality: int) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(source_path) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode not in {"RGB", "RGBA"}:
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        save_kwargs = {"format": "WEBP", "quality": quality, "method": 6}
        if image.mode == "RGBA":
            save_kwargs["lossless"] = False
        image.save(target_path, **save_kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate storefront thumbnails.")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]), help="Project root")
    parser.add_argument("--max-size", type=int, default=640, help="Max width/height in pixels")
    parser.add_argument("--quality", type=int, default=78, help="WebP quality")
    parser.add_argument("--force", action="store_true", help="Regenerate even when the thumbnail is current")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    catalog_path = root / "products.json"
    products = json.loads(catalog_path.read_text(encoding="utf-8"))

    result = ThumbnailResult()

    for asset_path in iter_catalog_images(products):
        source_path = source_path_for(root, asset_path)
        target_path = thumbnail_path_for(root, asset_path)

        if source_path.suffix.lower() not in SUPPORTED_RASTER_EXTENSIONS:
            result.skipped += 1
            continue

        if not source_path.exists():
            result.missing += 1
            continue

        source_stat = source_path.stat()
        result.original_bytes += source_stat.st_size

        if (
            not args.force
            and target_path.exists()
            and target_path.stat().st_mtime >= source_stat.st_mtime
        ):
            result.skipped += 1
            result.thumbnail_bytes += target_path.stat().st_size
            continue

        try:
            generate_thumbnail(source_path, target_path, args.max_size, args.quality)
            result.generated += 1
            result.thumbnail_bytes += target_path.stat().st_size
        except Exception:
            result.errors += 1

    print(json.dumps({
        "generated": result.generated,
        "skipped": result.skipped,
        "missing": result.missing,
        "errors": result.errors,
        "original_bytes": result.original_bytes,
        "thumbnail_bytes": result.thumbnail_bytes,
        "thumbnail_root": str(root / "assets" / "thumbnails")
    }, indent=2))
    return 0 if result.errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
