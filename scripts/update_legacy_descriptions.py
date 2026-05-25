"""Refresh buyer-facing descriptions for Legacy Site listings.

The storefront keeps product data in JSON catalogs plus JavaScript preloaded
fallback bundles. This script updates both surfaces from the same product
records so cache/script fallback shoppers see identical copy.
"""

from __future__ import annotations

import json
import re
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

SPORT_CARD_CATEGORIES = {
    "Baseball": "baseball card",
    "Basketball": "basketball card",
    "Football": "football card",
    "Sports": "sports card",
}

REPORT_PATH = ROOT / "outputs" / "codex-legacy-descriptions" / "legacy-description-update-report.json"


def compact(value: Any) -> str:
    if value is None:
        return ""
    return " ".join(str(value).replace("\r", " ").replace("\n", " ").split()).strip()


def metadata(product: dict[str, Any]) -> dict[str, Any]:
    value = product.get("metadata")
    return value if isinstance(value, dict) else {}


def first_present(*values: Any) -> str:
    for value in values:
        text = compact(value)
        if text:
            return text
    return ""


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


def clean_team(team: str) -> str:
    return re.sub(r"\s+BB$", "", compact(team)).strip()


def item_kind(product: dict[str, Any]) -> str:
    category = compact(product.get("category"))
    if category in SPORT_CARD_CATEGORIES:
        return SPORT_CARD_CATEGORIES[category]
    if compact(product.get("sport")) or compact(metadata(product).get("beckettSport")):
        return "sports card"
    if category == "Comics":
        return "comic book"
    if category == "Collectibles":
        return "collectible"
    return "item"


def display_price(product: dict[str, Any]) -> str:
    price = first_present(product.get("displayPrice"), product.get("priceLabel"))
    if price:
        return price

    raw_price = product.get("price")
    if isinstance(raw_price, (int, float)):
        return f"${raw_price:,.2f}"
    return ""


def image_count(product: dict[str, Any]) -> int:
    images: list[str] = []
    for key in ("image", "imageGallery", "itemPhotoUrls", "htmlImageUrls"):
        value = product.get(key)
        if isinstance(value, str):
            images.append(value)
        elif isinstance(value, list):
            images.extend(item for item in value if isinstance(item, str))

    unique_images = {compact(image) for image in images if compact(image)}
    return len(unique_images)


def noted_terms(product: dict[str, Any]) -> list[str]:
    name = compact(product.get("name"))
    terms: list[str] = []
    checks = [
        (r"\bRC\b|rookie", "rookie card notation"),
        (r"\bUER\b|error|variation", "variation/error notation"),
        (r"auto|autograph|signed", "autograph signal"),
        (r"jersey|patch|relic|memorabilia", "memorabilia signal"),
        (r"refractor", "refractor signal"),
        (r"/\d{2,5}\b", "serial-numbered notation"),
    ]
    for pattern, label in checks:
        if re.search(pattern, name, flags=re.IGNORECASE):
            terms.append(label)
    return terms


def details_for(product: dict[str, Any]) -> list[str]:
    meta = metadata(product)
    details: list[str] = []

    source = compact(product.get("sourcePage"))
    if source:
        details.append(f"Source: {source}")

    year = first_present(product.get("yearLabel"), product.get("year"))
    if year:
        details.append(f"Year: {year}")

    league = compact(product.get("league"))
    if league:
        details.append(f"League: {league}")

    brand = first_present(meta.get("beckettBrand"), meta.get("manufacturer"), meta.get("manufacturerCompany"))
    if brand:
        details.append(f"Brand: {brand}")

    card_number = first_present(meta.get("beckettCardNumber"))
    if card_number:
        details.append(f"Card number: {card_number}")

    if compact(product.get("category")) == "Comics":
        details.insert(0, "Category: Comics")

    terms = noted_terms(product)
    if terms:
        details.append(f"Noted terms: {', '.join(terms)}")

    photos = image_count(product)
    if photos:
        details.append(f"Photos: {photos}")

    return details


def build_description(product: dict[str, Any]) -> str:
    meta = metadata(product)
    name = compact(product.get("name")) or "this item"
    category = compact(product.get("category"))
    kind = item_kind(product)
    source = compact(product.get("sourcePage"))
    player = first_present(product.get("playerAthlete"), product.get("player"))
    team = clean_team(first_present(product.get("team"), meta.get("beckettTeam")))

    if category in {"Comics", "Collectibles"}:
        source_label = source or category.lower()
        first_sentence = f"Legacy Site listing for {name}, preserved from the {source_label} section."
    elif kind.endswith("card"):
        first_sentence = f"Legacy Site listing for {name}, a {kind}"
        if player:
            first_sentence += f" featuring {player}"
        if team:
            first_sentence += f" for {team}"
        first_sentence += "."
    else:
        first_sentence = f"Legacy Site listing for {name}, preserved from the prior storefront catalog."

    condition = compact(product.get("condition"))
    price = display_price(product)
    is_guide_range = "guide range" in condition.lower() or "price guide" in condition.lower()
    if is_guide_range and price:
        second_sentence = f"Legacy guide range is listed as {price}."
    elif condition and price:
        second_sentence = f"Condition is listed as {condition}; storefront price is {price}."
    elif condition:
        second_sentence = f"Condition is listed as {condition}."
    elif price:
        second_sentence = f"Storefront price is {price}."
    else:
        second_sentence = "Review the gallery photos for the exact item shown."

    details = details_for(product)
    sentences = [first_sentence, second_sentence]
    if details:
        sentences.append(f"Details: {'; '.join(details)}.")
    if "Review the gallery photos" not in second_sentence:
        sentences.append("Review the gallery photos for the exact item shown.")

    return " ".join(sentence for sentence in sentences if sentence)


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
    target_name = PRELOADED_TARGETS[source_file]
    target = ROOT / target_name
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    target.write_text(
        f'window.DJ_PRELOADED_SOURCE = "{source_file}";\n'
        f"window.DJ_PRELOADED_PRODUCTS = {payload};\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> None:
    canonical = load_catalog("products.json")
    canonical_descriptions = {
        int(product["id"]): build_description(product)
        for product in canonical
        if product.get("id") is not None and is_legacy_listing(product)
    }

    report: dict[str, Any] = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "canonicalLegacyListings": len(canonical_descriptions),
        "files": [],
    }

    for file_name in PRODUCT_FILES:
        data = load_catalog(file_name)
        updated = 0
        legacy_count = 0
        improved_count = 0

        for product in data:
            product_id = product.get("id")
            description = None
            if product_id is not None:
                try:
                    description = canonical_descriptions.get(int(product_id))
                except (TypeError, ValueError):
                    description = None

            if description is None and is_legacy_listing(product):
                description = build_description(product)

            if description:
                legacy_count += 1
            if description and product.get("description") != description:
                product["description"] = description
                updated += 1
            if "Legacy Site listing for" in compact(product.get("description")):
                improved_count += 1

        write_catalog(file_name, data)
        write_preloaded_bundle(file_name, data)
        report["files"].append(
            {
                "file": file_name,
                "totalProducts": len(data),
                "legacyListings": legacy_count,
                "improvedLegacyDescriptions": improved_count,
                "updatedDescriptionsThisRun": updated,
                "preloadedBundle": PRELOADED_TARGETS[file_name],
            }
        )

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
