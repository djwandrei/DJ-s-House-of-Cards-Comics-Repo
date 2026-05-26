"""Remove storefront description copy from Legacy Site listings.

Legacy records already carry their useful buyer-facing details in structured
fields such as year, condition, price, source page, gallery, team, and player.
Keeping generated prose in ``description`` makes the modal redundant, so this
script clears that field for every Legacy Site listing and refreshes the
preloaded JavaScript catalog bundles.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

PRODUCT_FILES = [
    "products.json",
    "products-baseball.json",
    "products-basketball.json",
    "products-football.json",
    "products-comics.json",
    "products-collectibles.json",
    "products-sports.json",
    "products-featured.json",
]

PRELOADED_TARGETS = {
    "products.json": "products-data-full.js",
    "products-baseball.json": "products-data-baseball.js",
    "products-basketball.json": "products-data-basketball.js",
    "products-football.json": "products-data-football.js",
    "products-comics.json": "products-data-comics.js",
    "products-collectibles.json": "products-data-collectibles.js",
    "products-sports.json": "products-data-sports.js",
    "products-featured.json": "products-data-featured.js",
}

REPORT_PATH = ROOT / "outputs" / "codex-legacy-descriptions" / "legacy-description-removal-report.json"


def compact(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\r", " ").replace("\n", " ").split()).strip()


def metadata(product: dict[str, Any]) -> dict[str, Any]:
    value = product.get("metadata")
    return value if isinstance(value, dict) else {}


def is_legacy_listing(product: dict[str, Any]) -> bool:
    if compact(product.get("legacyImageLabel")) or compact(product.get("sourcePage")):
        return True

    if "legacy" in compact(product.get("description")).lower():
        return True

    try:
        metadata_text = json.dumps(metadata(product), sort_keys=True)
    except TypeError:
        metadata_text = str(metadata(product))
    return "legacy" in metadata_text.lower()


def load_catalog(file_name: str) -> list[dict[str, Any]]:
    path = ROOT / file_name
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, list):
        raise ValueError(f"{file_name} is not a JSON array")
    return data


def write_catalog(file_name: str, data: list[dict[str, Any]]) -> None:
    path = ROOT / file_name
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(data, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")


def write_preloaded_bundle(source_file: str, data: list[dict[str, Any]]) -> None:
    target = ROOT / PRELOADED_TARGETS[source_file]
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    target.write_text(
        f'window.DJ_PRELOADED_SOURCE = "{source_file}";\n'
        f"window.DJ_PRELOADED_PRODUCTS = {payload};\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    report: dict[str, Any] = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "files": [],
    }

    for file_name in PRODUCT_FILES:
        data = load_catalog(file_name)
        legacy_count = 0
        cleared_count = 0

        for product in data:
            if not is_legacy_listing(product):
                continue

            legacy_count += 1
            if compact(product.get("description")):
                cleared_count += 1
            product["description"] = ""

        write_catalog(file_name, data)
        write_preloaded_bundle(file_name, data)
        report["files"].append(
            {
                "file": file_name,
                "totalProducts": len(data),
                "legacyListings": legacy_count,
                "clearedDescriptions": cleared_count,
                "preloadedBundle": PRELOADED_TARGETS[file_name],
            }
        )

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
