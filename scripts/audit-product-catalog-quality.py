#!/usr/bin/env python3
"""Audit storefront product data for attributes, core fields, and photos.

The checks are intentionally conservative. They fix or report issues where the
catalog already carries enough evidence, and leave uncertain player/team/photo
identity questions in a review list instead of guessing.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS_PATH = ROOT / "products.json"
OUTPUT_DIR = ROOT / "outputs" / "catalog-quality-audit"

PRODUCT_FILES = {
    "products.json": lambda items: items,
    "products-baseball.json": lambda items: [item for item in items if item.get("category") == "Baseball"],
    "products-basketball.json": lambda items: [item for item in items if item.get("category") == "Basketball"],
    "products-football.json": lambda items: [item for item in items if item.get("category") == "Football"],
    "products-comics.json": lambda items: [item for item in items if item.get("category") == "Comics"],
    "products-collectibles.json": lambda items: [item for item in items if item.get("category") in {"Collectibles", "Other"}],
    "products-sports.json": lambda items: [item for item in items if item.get("category") in {"Baseball", "Basketball", "Football"}],
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

BOOTSTRAP_FILES = {
    "products-baseball.json": "products-bootstrap-baseball.json",
    "products-basketball.json": "products-bootstrap-basketball.json",
    "products-football.json": "products-bootstrap-football.json",
    "products-comics.json": "products-bootstrap-comics.json",
    "products-collectibles.json": "products-bootstrap-collectibles.json",
}

BOOTSTRAP_PRODUCT_LIMIT = 48
STORE_FIELDS = {
    "id", "name", "category", "team", "year", "condition", "price", "priceLabel",
    "displayPrice", "image", "imageGallery", "description", "photoHostPageUrl",
    "legacyImageLabel", "sourcePage", "league", "sport", "playerAthlete",
    "attributes", "copyCount", "isFeatured", "isDeleted", "sortRank",
}
STORE_METADATA_FIELDS = {"conditionNotes", "playerAthlete"}
STORE_EXCEL_FIELDS = {"Title", "C:Features", "C:Autographed"}

ATTRIBUTE_ORDER = [
    "Autograph",
    "Rookie",
    "Serial Numbered",
    "One of One",
    "Short Print",
    "Memorabilia",
    "Parallel/Variety",
    "Insert",
    "Error",
]
ATTRIBUTE_INDEX = {value: index for index, value in enumerate(ATTRIBUTE_ORDER)}

AUTOGRAPH_RE = re.compile(
    r"\bauto(?:s|graph(?:ed|s)?|graphed|s)?\b|\bau\b|\bsigned\b|\bsignatures\b|"
    r"\bsigs?\b|\bink\b|\bscript(?:s)?\b|\binscriptions?\b|\bpenmanship\b|"
    r"\bsignature(?!\s+rookies)\b|"
    r"\bpsa/dna certified authentic\b|\b(?:sticker|on-card|hard-signed)\s+auto\b|"
    r"\bsignature\s+(?:series|shots|marks|materials|patch|jersey|memorabilia|autographs?)\b",
    re.I,
)
ROOKIE_RE = re.compile(r"\brookies?\b|\brc\b|\brookie related\b|\brated rookie\b|\bpre[- ]rookie\b", re.I)
ONE_OF_ONE_RE = re.compile(r"\bone\s+of\s+one\b|\b1\s*of\s*1\b|\b1/1\b|\bprinting plate\b|\bpre[- ]production proof\b", re.I)
SHORT_PRINT_RE = re.compile(r"\bshort[- ]print\b|\bssp\b", re.I)
MEMORABILIA_RE = re.compile(
    r"\bmemorabilia\b|\brelics?\b|\bjerseys?\b|\bjsy\b|\bpatch(?:es)?\b|\bswatches?\b|"
    r"\bfabric\b|\bmaterials?\b|\bgame[- ](?:used|worn|bat)\b|\bpiece\s+of\s+the\s+game\b|"
    r"\bplayer[- ]worn\b|\bclubhouse collection\b|\b(?:black gold|throwback|rookie team|team)\s+threads\b|"
    r"\bhot numbers game used\b|\bauthentic fabric\b|\bfabric of the future\b|\bsp game bat edition\b|"
    r"\bbat kings\b|\bautograph-bat\b|\bpants\b|\bby the letter\b",
    re.I,
)
BARE_BAT_MEMORABILIA_RE = re.compile(r"\bbat\b", re.I)
BAT_PHOTO_POSE_RE = re.compile(r"\bbat\s+(?:in|behind|over)|\bholding bat\b|\bknob of bat\b", re.I)
PARALLEL_RE = re.compile(
    r"\bparallel\b|\bvariation\b|\bvariety\b|\brefractors?\b|\bprizms?\b|\bfoils?\b|"
    r"\bholo(?:foil)?\b|\bshimmer\b|\bwave\b|\blava\b|\bpulsar\b|\bspeckle\b|\bmojo\b|"
    r"\bice\b|\bglitter\b|\bsapphire\b|\bx-?fractor\b|\bdie[- ]cut\b|\bpress proof\b|"
    r"\b(?:gold|silver|bronze|blue|red|green|purple|orange|pink|black|aqua|yellow|fuchsia|lime|"
    r"cyan|white|emerald|sepia)\s+(?:border|foil|parallel|refractor|prizm|holo|wave|shimmer|glitter|proof)\b",
    re.I,
)
INSERT_RE = re.compile(r"\binserts?\b|\bcase hit\b|\bvariation insert\b", re.I)
ERROR_RE = re.compile(r"\berrors?\b|\berr\b|\buer\b|\bwrong back\b|\bmisspell(?:ed|ing)\b|\bmisprint\b", re.I)
EXPLICIT_SERIAL_RE = re.compile(
    r"\bserial[- ](?:ly[- ])?numbered\b|\bnumbered\s+(?:to|/)\s*\d+\b|"
    r"\blimited\s+to\s+\d+\b|\bone\s+of\s+one\b|\b1\s*of\s*1\b|\b1/1\b",
    re.I,
)
SERIAL_CONTEXT_RE = re.compile(
    r"\b(?:gold|silver|bronze|blue|red|green|purple|orange|pink|black|aqua|yellow|fuchsia|lime|"
    r"cyan|white|emerald|sepia|tie-dye|rainbow|platinum|foil|border|parallel|refractor|prizm|holo|"
    r"shimmer|wave|lava|pulsar|speckle|mojo|ice|glitter|chrome|optic|choice|cosmic|sapphire|"
    r"x-?fractor|die[- ]cut|press proof|aspirations|status|mirror|prime|the finals|playoff ticket|"
    r"premium stock|masterpieces|limited|numbered|serial|short print|sp|ssp|auto|autographs?|signature|signatures?|"
    r"au|sigs?|patch|relic|memorabilia|jersey|materials?|swatch|prospect)\b",
    re.I,
)
SLASH_SERIAL_RE = re.compile(r"/\s*(\d{1,4})\b")
COMMON_SERIAL_DENOMINATORS = {
    1, 4, 5, 10, 15, 18, 20, 24, 25, 30, 35, 40, 49, 50, 75, 88, 99,
    100, 125, 149, 150, 175, 199, 200, 249, 250, 275, 299, 300, 350,
    399, 400, 425, 450, 499, 500, 550, 600, 820, 999,
}
YEAR_RE = re.compile(r"\b(19\d{2}|20\d{2})(?:-\d{2})?\b")
NUMBERED_SUFFIX_RE = re.compile(r"\s*(?:\((\d{1,3})\)|-\s*(\d{1,3}))\s*$")
STOP_TOKENS = {
    "the", "and", "with", "card", "cards", "set", "lot", "rookie", "auto", "autograph",
    "autographs", "refractor", "refractors", "prizm", "parallel", "serial", "numbered",
    "near", "mint", "better", "psa", "bgs", "sgc", "cgc", "topps", "panini", "upper",
    "deck", "bowman", "leaf", "donruss", "fleer", "chrome",
}
NON_PERSON_PLAYER_LABELS = {
    "national league",
    "american league",
    "nl",
    "al",
}
TEAM_CARD_RE = re.compile(r"\b(?:TC|team card)\b", re.I)
SET_OR_LOT_RE = re.compile(
    r"\b(?:complete|boxed)\s+set\b|\bset\s+of\b|\blot\b|\bwhole\s+squad\b|"
    r"\bbase\s+\+|\(x\d+\)|\bteam\s+card\b|\bTC\b",
    re.I,
)
PLAYER_AFTER_CARD_NUMBER_RE = re.compile(r"#\S+\s+([^#/+]+)")
NON_NAME_TITLE_SUFFIX_RE = re.compile(
    r"\s+\b(?:PSA|BGS|SGC|CGC|RC|AU|AUTO|AUTOGRAPH|AUTOGRAPHS|ROOKIE|ROOKIES|"
    r"REFRACTOR|REFRACTORS|RELIC|RELICS|PATCH|JERSEY|JSY|ARM\s+BACK|MIN|"
    r"PRIZM|FOIL|SP|SSP)\b.*$",
    re.I,
)
CARD_CODE_PREFIX_RE = re.compile(r"^-?[A-Z]{1,5}\d{0,3}\s+")
CARD_DESCRIPTOR_WORD_RE = re.compile(
    r"\b(?:bowman|chrome|prospects?|refractors?|autographs?|autos?|elite|extra|edition|"
    r"franchise|futures|signatures?|topps|tribute|triple|threads|museum|collection|"
    r"marquee|relics?|rookie|draft|ultimate|brilliance|gold|standard|finest|certified|"
    r"leaf|prizm|donruss|panini|goodwin|champions|platinum|totally|prime|marks|tomorrow|"
    r"university|proven|mettle|coins?|copper|game|worn)\b",
    re.I,
)
GRADE_OR_SERIAL_FRAGMENT_RE = re.compile(
    r"^(?:\d+(?:\.\d+)?\s*(?:-?\s*(?:MT|MINT|NM|NM-MT|EX|EX-MT|VG|GOOD|AUTO(?:\s*\d+)?))?|"
    r"\d+(?:\.\d+)?|-\s*)$",
    re.I,
)
CARD_DESCRIPTOR_PLAYER_PREFIX_RE = re.compile(
    r"^(?:"
    r"bowman(?: chrome| draft| sterling)?|chrome|draft|prospects?|blue|gold|orange|red|purple|green|"
    r"refractors?|autographs?|autos?|elite|extra|edition|franchise|futures|signatures?|"
    r"leaf|ultimate|metal|topps|tribute|triple|threads|museum|collection|marquee|"
    r"acclaimed|impressions|monumental|markings|relics?|unity|legend|proven|mettle|coins?|"
    r"copper|silver|aspirations|status|rookie|rc|prospect|pride"
    r")[\s-]+",
    re.I,
)

FIELD_FIXES: dict[int, dict[str, Any]] = {
    443: {
        "playerAthlete": "Dirk Nowitzki | Rodrigue Beaubois | Tyson Chandler | Jason Kidd | Caron Butler | Shawn Marion",
    },
    868: {
        "playerAthlete": "Ivan Rodriguez",
    },
    873: {
        "playerAthlete": "Jake Westbrook",
    },
    2767: {
        "playerAthlete": "Willie Mays",
    },
    888: {
        "team": "",
        "playerAthlete": "Carrie Fisher",
    },
    921: {
        "team": "Chicago Cubs",
        "playerAthlete": "Randy Wells",
    },
    1108: {
        "team": "",
        "playerAthlete": "Obi-Wan Kenobi | Chewbacca",
    },
    1159: {
        "playerAthlete": "Zach LaVine | DeMar DeRozan | Lonzo Ball",
    },
    1160: {
        "playerAthlete": "Darius Garland | Donovan Mitchell",
    },
    1161: {
        "playerAthlete": "Luka Doncic | Kyrie Irving | Dirk Nowitzki",
    },
    1165: {
        "playerAthlete": "Kevin Durant | Amen Thompson | Alperen Sengun",
    },
    1166: {
        "playerAthlete": "Tyrese Haliburton",
    },
    2171: {
        "team": "",
        "sport": "Tennis",
        "playerAthlete": "Maria Sharapova",
    },
    2680: {
        "team": "",
        "playerAthlete": "Hyunsung Park",
    },
    3136: {
        "playerAthlete": "Derrion Reid",
    },
}


@dataclass
class Issue:
    product_id: Any
    title: str
    severity: str
    issue_type: str
    current: Any = ""
    expected: Any = ""
    evidence: str = ""


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def metadata(product: dict[str, Any]) -> dict[str, Any]:
    value = product.get("metadata")
    return value if isinstance(value, dict) else {}


def excel_fields(product: dict[str, Any]) -> dict[str, Any]:
    value = metadata(product).get("excelFields")
    return value if isinstance(value, dict) else {}


def split_features(value: Any) -> list[str]:
    return [part.strip() for part in text(value).split("|") if part.strip()]


def ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value not in ATTRIBUTE_INDEX or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return sorted(out, key=lambda item: ATTRIBUTE_INDEX[item])


def has_serial_numbered_signal(title: str) -> bool:
    if EXPLICIT_SERIAL_RE.search(title):
        return True
    for segment in re.split(r"\s+\+\s+", title):
        for match in SLASH_SERIAL_RE.finditer(segment):
            denominator = int(match.group(1))
            after = segment[match.end() : match.end() + 30]
            if re.match(r"^\s*(?:cards?|pcs?|boxes?|packs?)\b", after, re.I):
                continue
            before = segment[max(0, match.start() - 90) : match.start()]
            if denominator in COMMON_SERIAL_DENOMINATORS:
                return True
            if 1900 <= denominator <= 2035 and not SERIAL_CONTEXT_RE.search(before):
                continue
            if not SERIAL_CONTEXT_RE.search(before):
                continue
            return True
    return False


def has_memorabilia_signal(full_blob: str, title_blob: str) -> bool:
    if MEMORABILIA_RE.search(full_blob):
        return True
    return bool(BARE_BAT_MEMORABILIA_RE.search(title_blob) and not BAT_PHOTO_POSE_RE.search(title_blob))


def expected_attributes(product: dict[str, Any]) -> list[str]:
    fields = excel_fields(product)
    md = metadata(product)
    condition_notes = md.get("conditionNotes")
    if isinstance(condition_notes, list):
        condition_notes_text = " ".join(text(item) for item in condition_notes)
    else:
        condition_notes_text = text(condition_notes)

    title_blob = " ".join(
        text(value)
        for value in [
            product.get("name"),
            fields.get("Title"),
            product.get("condition"),
            product.get("legacyImageLabel"),
        ]
    )
    full_blob = " ".join(
        text(value)
        for value in [
            product.get("name"),
            product.get("description"),
            product.get("condition"),
            condition_notes_text,
            product.get("priceLabel"),
            product.get("playerAthlete"),
            md.get("playerAthlete"),
            product.get("team"),
            product.get("legacyImageLabel"),
            fields.get("Title"),
            fields.get("Description"),
            fields.get("C:Features"),
            fields.get("C:Autographed"),
            fields.get("C:Player/Athlete"),
            fields.get("C:Team"),
        ]
    )

    features = split_features(fields.get("C:Features"))
    values = [feature for feature in features if feature in ATTRIBUTE_INDEX]
    if ROOKIE_RE.search(full_blob):
        values.append("Rookie")
    if AUTOGRAPH_RE.search(full_blob) or text(fields.get("C:Autographed")).lower() == "yes":
        values.append("Autograph")
    if has_serial_numbered_signal(title_blob):
        values.append("Serial Numbered")
    if ONE_OF_ONE_RE.search(full_blob):
        values.append("One of One")
    if SHORT_PRINT_RE.search(full_blob):
        values.append("Short Print")
    if has_memorabilia_signal(full_blob, title_blob):
        values.append("Memorabilia")
    if PARALLEL_RE.search(title_blob):
        values.append("Parallel/Variety")
    if INSERT_RE.search(full_blob):
        values.append("Insert")
    if ERROR_RE.search(full_blob):
        values.append("Error")
    if not features and isinstance(product.get("attributes"), list):
        existing = [value for value in product.get("attributes") if value in ATTRIBUTE_INDEX]
        if "Serial Numbered" in existing and hasSerialNumberingContextCompat(title_blob):
            values.append("Serial Numbered")
        if "Autograph" in existing and AUTOGRAPH_RE.search(full_blob):
            values.append("Autograph")
        if "Memorabilia" in existing and has_memorabilia_signal(full_blob, title_blob):
            values.append("Memorabilia")

    return ordered_unique(values)


def hasSerialNumberingContextCompat(value: str) -> bool:
    return bool(SERIAL_CONTEXT_RE.search(value))


def parse_title_year(name: str) -> int | None:
    match = YEAR_RE.search(name)
    if not match:
        return None
    year = int(match.group(1))
    return year if 1900 <= year <= 2035 else None


def strip_diacritics(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    return "".join(char for char in normalized if not unicodedata.combining(char))


def normalize_compare(value: Any) -> str:
    normalized = strip_diacritics(text(value)).lower().replace("&", "and")
    return re.sub(r"\s+", " ", normalized).strip()


def normalize_team(value: Any) -> str:
    normalized = normalize_compare(value)
    normalized = re.sub(r"\s+(bb|fb|bk)$", "", normalized)
    return normalized


def path_is_external(value: str) -> bool:
    return value.lower().startswith(("http://", "https://", "data:"))


def local_reference_exists(reference: str) -> bool:
    if not reference or path_is_external(reference):
        return True
    normalized = reference.replace("/", "\\")
    return (ROOT / normalized).exists()


def filename_without_number(reference: str) -> tuple[str, int | None]:
    stem = Path(reference.split("?", 1)[0]).stem
    match = NUMBERED_SUFFIX_RE.search(stem)
    number = None
    if match:
        number = int(match.group(1) or match.group(2))
        stem = stem[: match.start()].strip()
    return normalize_slug(stem), number


def normalize_slug(value: str) -> str:
    value = strip_diacritics(value).replace("\u2019", "'")
    value = value.replace("’", "'")
    value = re.sub(r"[/\\#()&+.,:;'`]", " ", value.lower())
    value = re.sub(r"\b\d{1,4}\b", " ", value)
    value = re.sub(r"\bx\d+\b", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def tokens(value: str) -> set[str]:
    return {token for token in normalize_slug(value).split() if len(token) >= 3 and token not in STOP_TOKENS}


def title_photo_score(title: str, reference: str) -> float:
    title_tokens = tokens(title)
    file_tokens = tokens(Path(reference.split("?", 1)[0]).stem)
    if not title_tokens or not file_tokens:
        return 1.0
    return len(title_tokens & file_tokens) / max(1, min(len(title_tokens), len(file_tokens)))


def gallery_sort_key(reference: str) -> tuple[str, int]:
    base, number = filename_without_number(reference)
    return base, number or 0


def sorted_gallery_if_confident(gallery: list[str]) -> list[str] | None:
    if len(gallery) < 2 or any(path_is_external(item) for item in gallery):
        return None
    parts = [filename_without_number(item) for item in gallery]
    bases = {base for base, number in parts if number is not None}
    if len(bases) != 1 or any(number is None for _, number in parts):
        return None
    sorted_gallery = sorted(gallery, key=gallery_sort_key)
    return sorted_gallery if sorted_gallery != gallery else None


def is_non_person_player_label(value: Any) -> bool:
    return normalize_compare(value) in NON_PERSON_PLAYER_LABELS


def player_parts(value: Any) -> list[str]:
    return [part.strip() for part in re.split(r"\s*[|]\s*", text(value)) if part.strip()]


def is_grade_or_serial_fragment(value: str) -> bool:
    raw = text(value)
    if GRADE_OR_SERIAL_FRAGMENT_RE.match(raw):
        return True
    without_grade_words = re.sub(
        r"\b(?:AUTO|AU|MT|MINT|NM|NM-MT|EX|EX-MT|VG|GOOD|PSA|BGS|SGC|CGC)\b",
        " ",
        raw,
        flags=re.I,
    )
    return bool(re.search(r"\d", without_grade_words) and not re.search(r"[A-Za-z]", without_grade_words))


def clean_player_descriptor(value: str) -> str:
    cleaned = text(value)
    previous = None
    while cleaned and cleaned != previous:
        previous = cleaned
        cleaned = CARD_DESCRIPTOR_PLAYER_PREFIX_RE.sub("", cleaned).strip(" -")
    return cleaned


def clean_player_athlete_value(value: Any) -> str:
    parts: list[str] = []
    for part in player_parts(value):
        if is_grade_or_serial_fragment(part):
            continue
        cleaned = part.strip(" -")
        if cleaned and not is_grade_or_serial_fragment(cleaned):
            parts.append(cleaned)
    return " | ".join(parts)


def clean_title_person_fragment(value: str) -> str:
    cleaned = re.sub(r"\s+PSA\s+\d.*$", "", text(value), flags=re.I)
    cleaned = re.sub(r"\s+\b(?:AS|MVP|RB|UER|DP)\b.*$", "", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+#.*$", "", cleaned)
    return cleaned.strip(" -")


def extract_slash_title_players(title: str) -> str:
    if "/" not in title:
        return ""
    parts = [clean_title_person_fragment(part) for part in title.split("/")[1:]]
    players = [part for part in parts if part and not re.search(r"\bleaders?\b|\bTC\b", part, re.I)]
    return " | ".join(players)


def clean_inferred_player_name(value: str) -> str:
    cleaned = text(value).strip(" -")
    cleaned = re.split(r"\s*/\s*\d+", cleaned, maxsplit=1)[0]
    cleaned = NON_NAME_TITLE_SUFFIX_RE.sub("", cleaned)
    cleaned = CARD_CODE_PREFIX_RE.sub("", cleaned).strip(" -")
    return cleaned


def infer_player_from_card_number_title(title: str) -> str:
    match = PLAYER_AFTER_CARD_NUMBER_RE.search(title)
    if not match:
        return ""
    inferred = clean_inferred_player_name(match.group(1))
    inferred_tokens = [token for token in re.split(r"\s+", inferred) if token]
    if len(inferred_tokens) < 2 or len(inferred_tokens) > 5:
        return ""
    if CARD_DESCRIPTOR_WORD_RE.search(inferred):
        return ""
    return inferred


def listing_can_lack_single_player(product: dict[str, Any]) -> bool:
    title = text(product.get("name"))
    return bool(TEAM_CARD_RE.search(title) or SET_OR_LOT_RE.search(title))


def expected_field_fixes(product: dict[str, Any]) -> dict[str, Any]:
    fixes = dict(FIELD_FIXES.get(int(product.get("id") or -1), {}))
    title = text(product.get("name"))
    current_player = fixes.get("playerAthlete", product.get("playerAthlete"))
    team = text(fixes.get("team", product.get("team")))

    if text(current_player):
        cleaned_player = clean_player_athlete_value(current_player)
        if cleaned_player != text(current_player):
            fixes["playerAthlete"] = cleaned_player
            current_player = cleaned_player

    inferred_player = infer_player_from_card_number_title(title)
    if inferred_player and text(current_player) and CARD_DESCRIPTOR_WORD_RE.search(text(current_player)):
        fixes["playerAthlete"] = inferred_player
        current_player = inferred_player

    if is_non_person_player_label(current_player):
        fixes["playerAthlete"] = extract_slash_title_players(title)
    elif text(current_player) and team and normalize_compare(current_player) == normalize_compare(team):
        title_players = extract_slash_title_players(title)
        if title_players:
            fixes["playerAthlete"] = title_players
        elif TEAM_CARD_RE.search(title):
            fixes["playerAthlete"] = ""

    return {
        key: value
        for key, value in fixes.items()
        if product.get(key) != value
    }


def compact_product(product: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in STORE_FIELDS:
        if key in product:
            out[key] = product[key]
    md = metadata(product)
    store_md: dict[str, Any] = {}
    for key in STORE_METADATA_FIELDS:
        if key in md:
            store_md[key] = md[key]
    fields = excel_fields(product)
    if fields:
        store_fields = {key: value for key, value in fields.items() if key in STORE_EXCEL_FIELDS and value not in ("", None)}
        if store_fields:
            store_md["excelFields"] = store_fields
    if store_md:
        out["metadata"] = store_md
    return out


def write_json(path: Path, value: Any) -> None:
    if path.name == "products.json":
        serialized = json.dumps(value, ensure_ascii=False, indent=2)
    else:
        serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    path.write_text(serialized + "\n", encoding="utf-8")


def write_bundle(source_name: str, path: Path, items: list[dict[str, Any]]) -> None:
    content = "\n".join(
        [
            f"window.DJ_PRELOADED_SOURCE = {json.dumps(source_name)};",
            f"window.DJ_PRELOADED_PRODUCTS = {json.dumps([compact_product(item) for item in items], ensure_ascii=False, separators=(',', ':'))};",
            "",
        ]
    )
    path.write_text(content, encoding="utf-8")


def rebuild_catalog_files(products: list[dict[str, Any]]) -> None:
    for source_name, selector in PRODUCT_FILES.items():
        subset = selector(products)
        is_full_catalog = source_name == "products.json"
        write_json(ROOT / source_name, subset if is_full_catalog else [compact_product(item) for item in subset])
        bundle = DATA_BUNDLE_FILES.get(source_name)
        if bundle:
            write_bundle(source_name, ROOT / bundle, subset)
        bootstrap = BOOTSTRAP_FILES.get(source_name)
        if bootstrap:
            write_json(
                ROOT / bootstrap,
                {
                    "source": source_name,
                    "total": len(subset),
                    "products": [compact_product(item) for item in subset[:BOOTSTRAP_PRODUCT_LIMIT]],
                },
            )


def audit_product(product: dict[str, Any], image_owners: dict[str, list[Any]]) -> tuple[list[Issue], dict[str, Any]]:
    issues: list[Issue] = []
    fixes: dict[str, Any] = {}
    pid = product.get("id")
    title = text(product.get("name"))
    fields = excel_fields(product)
    md = metadata(product)

    def add(severity: str, issue_type: str, current: Any = "", expected: Any = "", evidence: str = "") -> None:
        issues.append(Issue(pid, title, severity, issue_type, current, expected, evidence))

    expected_year = parse_title_year(title)
    if expected_year and product.get("year") != expected_year:
        add("fixable", "year_mismatch", product.get("year"), expected_year, "first catalog year in title")
        fixes["year"] = expected_year

    for field_name, expected_value in expected_field_fixes(product).items():
        add("fixable", f"{field_name}_mismatch", product.get(field_name), expected_value, "title/site metadata cleanup")
        fixes[field_name] = expected_value

    expected = expected_attributes(product)
    existing = [value for value in (product.get("attributes") or []) if value in ATTRIBUTE_INDEX]
    if fields.get("C:Features"):
        feature_values = split_features(fields.get("C:Features"))
        unknown_features = [value for value in feature_values if value not in ATTRIBUTE_INDEX]
        if unknown_features:
            add("review", "unknown_feature_value", "|".join(unknown_features), "", "metadata.excelFields.C:Features")
    if existing != expected:
        add("fixable", "attribute_mismatch", existing, expected, "title/condition/workbook metadata")
        fixes["attributes"] = expected

    if fields.get("C:Autographed"):
        wanted_auto = "Yes" if AUTOGRAPH_RE.search(title) else "No"
        if text(fields.get("C:Autographed")) != wanted_auto and AUTOGRAPH_RE.search(title):
            add("fixable", "autographed_field_mismatch", fields.get("C:Autographed"), wanted_auto, "title contains autograph language")
            fixes.setdefault("excelFields", {})["C:Autographed"] = wanted_auto

    if fields:
        for field_name, product_key in [
            ("C:Sport", "sport"),
            ("C:Team", "team"),
            ("C:Player/Athlete", "playerAthlete"),
        ]:
            product_value = text(product.get(product_key))
            excel_value = text(fields.get(field_name))
            if product_value and not excel_value:
                add("fixable", f"missing_excel_{field_name}", "", product_value, "site field is populated")
                fixes.setdefault("excelFields", {})[field_name] = product_value
            elif product_value and excel_value and normalize_compare(product_value) != normalize_compare(excel_value):
                add("fixable", f"site_excel_{field_name}_mismatch", excel_value, product_value, "site field differs from workbook metadata")
                fixes.setdefault("excelFields", {})[field_name] = product_value

    for meta_key, product_key in [("sport", "sport"), ("playerAthlete", "playerAthlete")]:
        product_value = text(product.get(product_key))
        meta_value = text(md.get(meta_key))
        if product_value and meta_value and normalize_compare(product_value) != normalize_compare(meta_value):
            add("fixable", f"site_metadata_{meta_key}_mismatch", meta_value, product_value, "site field differs from import metadata")
            fixes.setdefault("metadataFields", {})[meta_key] = product_value

    if md.get("beckettTeam") and text(product.get("team")):
        beckett_team = normalize_team(md.get("beckettTeam"))
        site_team = normalize_team(product.get("team"))
        if beckett_team and site_team and beckett_team != site_team:
            add("review", "beckett_team_mismatch", md.get("beckettTeam"), product.get("team"), "legacy Beckett team differs from site team")

    if md.get("beckettSport") and text(product.get("sport")):
        if normalize_compare(md.get("beckettSport")) != normalize_compare(product.get("sport")):
            add("review", "beckett_sport_mismatch", md.get("beckettSport"), product.get("sport"), "legacy Beckett sport differs from site sport")

    player = text(product.get("playerAthlete"))
    if player and player.lower() not in {"none", "n/a"}:
        title_tokens = tokens(title)
        unmatched = []
        for part in player_parts(player):
            if is_non_person_player_label(part) or is_grade_or_serial_fragment(part):
                continue
            part_tokens = {token for token in tokens(part) if token not in {"jr", "sr"}}
            if part_tokens and not (part_tokens & title_tokens):
                unmatched.append(part)
        if unmatched:
            add("review", "player_not_visible_in_title", player, "", f"unmatched player parts: {', '.join(unmatched[:4])}")
    elif product.get("category") in {"Baseball", "Basketball", "Football"} and not listing_can_lack_single_player(product):
        add("review", "missing_player_athlete", player, "", "sports card without playerAthlete")

    image = text(product.get("image"))
    gallery = [text(item) for item in product.get("imageGallery") or [] if text(item)]
    if not image:
        add("review", "missing_primary_image", "", "", "image field empty")
    if image and not local_reference_exists(image):
        add("review", "missing_primary_image_asset", image, "", "local image path not found")
    for ref in gallery:
        if not local_reference_exists(ref):
            add("review", "missing_gallery_image_asset", ref, "", "local gallery path not found")

    if image and gallery and gallery[0] != image:
        if image in gallery:
            add("fixable", "primary_image_not_first_in_gallery", gallery[0], image, "primary image should be gallery item 1")
            fixes["imageGallery"] = [image] + [item for item in gallery if item != image]
        else:
            add("fixable", "primary_image_missing_from_gallery", gallery, image, "primary image should be included in gallery")
            fixes["imageGallery"] = [image] + gallery

    ordered = sorted_gallery_if_confident(gallery)
    if ordered:
        add("fixable", "gallery_order_mismatch", gallery, ordered, "same filename base with numeric photo suffixes")
        fixes["imageGallery"] = ordered
        fixes["image"] = ordered[0]

    if image and "placeholder" in image.lower():
        issue_type = "pre_2000_placeholder_primary_image" if (product.get("year") or 9999) < 2000 else "placeholder_primary_image"
        add("review", issue_type, image, "", "catalog image path is a placeholder")
    elif image and not path_is_external(image):
        score = title_photo_score(title, image)
        if score < 0.34:
            add("review", "low_title_image_filename_match", image, f"score={score:.2f}", "filename tokens weakly match product title")

    for ref in [image, *gallery]:
        if ref and not path_is_external(ref) and "placeholder" not in ref.lower():
            image_owners[ref.replace("\\", "/")].append(pid)

    item_photo_urls = md.get("itemPhotoUrls")
    if isinstance(item_photo_urls, list) and item_photo_urls and gallery:
        external_gallery_count = sum(1 for item in gallery if path_is_external(item))
        if external_gallery_count and len(item_photo_urls) != external_gallery_count:
            add("review", "hosted_photo_count_mismatch", len(item_photo_urls), external_gallery_count, "metadata.itemPhotoUrls vs external gallery")

    return issues, fixes


def apply_fixes(product: dict[str, Any], fixes: dict[str, Any]) -> bool:
    changed = False
    for key in ["year", "team", "sport", "league", "playerAthlete", "image", "imageGallery", "attributes"]:
        if key in fixes and product.get(key) != fixes[key]:
            if key == "attributes" and not fixes[key]:
                product.pop("attributes", None)
            else:
                product[key] = fixes[key]
            changed = True

    if fixes.get("excelFields"):
        md = product.setdefault("metadata", {})
        fields = md.setdefault("excelFields", {})
        for key, value in fixes["excelFields"].items():
            if fields.get(key) != value:
                fields[key] = value
                changed = True
    if fixes.get("metadataFields"):
        md = product.setdefault("metadata", {})
        for key, value in fixes["metadataFields"].items():
            if md.get(key) != value:
                md[key] = value
                changed = True
    return changed


def write_reports(issues: list[Issue], summary: dict[str, Any], touched: list[dict[str, Any]]) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    issue_rows = [issue.__dict__ for issue in issues]
    (OUTPUT_DIR / "product-quality-issues.json").write_text(
        json.dumps(issue_rows, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with (OUTPUT_DIR / "product-quality-issues.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=["product_id", "title", "severity", "issue_type", "current", "expected", "evidence"],
        )
        writer.writeheader()
        writer.writerows(issue_rows)
    (OUTPUT_DIR / "product-quality-summary.json").write_text(
        json.dumps({**summary, "touchedProducts": touched}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if summary.get("mode") == "fix":
        (OUTPUT_DIR / "applied-product-quality-fixes.json").write_text(
            json.dumps(touched, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        with (OUTPUT_DIR / "applied-product-quality-fixes.csv").open("w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(
                fh,
                fieldnames=["id", "title", "category", "fields_changed", "changes", "primary_file", "regenerated_files"],
            )
            writer.writeheader()
            writer.writerows(touched)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fix", action="store_true", help="Apply conservative fixes and rebuild product files.")
    args = parser.parse_args()

    products = json.loads(PRODUCTS_PATH.read_text(encoding="utf-8"))
    all_issues: list[Issue] = []
    pending_fixes: dict[Any, dict[str, Any]] = {}
    image_owners: dict[str, list[Any]] = defaultdict(list)

    for product in products:
        issues, fixes = audit_product(product, image_owners)
        all_issues.extend(issues)
        if fixes:
            pending_fixes[product.get("id")] = fixes

    duplicate_image_issues: list[Issue] = []
    product_title_by_id = {product.get("id"): text(product.get("name")) for product in products}
    for reference, owners in image_owners.items():
        unique_owners = sorted(set(owners), key=lambda value: str(value))
        if len(unique_owners) > 1:
            duplicate_image_issues.append(
                Issue(
                    product_id=",".join(str(owner) for owner in unique_owners[:10]),
                    title="; ".join(product_title_by_id.get(owner, "") for owner in unique_owners[:3]),
                    severity="review",
                    issue_type="image_reused_by_multiple_products",
                    current=reference,
                    expected="",
                    evidence=f"{len(unique_owners)} products share this exact image path",
                )
            )
    all_issues.extend(duplicate_image_issues)

    touched: list[dict[str, Any]] = []
    if args.fix:
        for product in products:
            fixes = pending_fixes.get(product.get("id"))
            if not fixes:
                continue
            changes = {
                key: {"from": product.get(key), "to": value}
                for key, value in fixes.items()
                if key not in {"excelFields", "metadataFields"} and product.get(key) != value
            }
            if fixes.get("excelFields"):
                current_fields = excel_fields(product)
                excel_changes = {
                    key: {"from": current_fields.get(key), "to": value}
                    for key, value in fixes["excelFields"].items()
                    if current_fields.get(key) != value
                }
                if excel_changes:
                    changes["metadata.excelFields"] = excel_changes
            if fixes.get("metadataFields"):
                current_metadata = metadata(product)
                metadata_changes = {
                    key: {"from": current_metadata.get(key), "to": value}
                    for key, value in fixes["metadataFields"].items()
                    if current_metadata.get(key) != value
                }
                if metadata_changes:
                    changes["metadata"] = metadata_changes
            if apply_fixes(product, fixes):
                touched.append(
                    {
                        "id": product.get("id"),
                        "title": product.get("name"),
                        "category": product.get("category"),
                        "fields_changed": "|".join(changes.keys()),
                        "changes": json.dumps(changes, ensure_ascii=False, separators=(",", ":")),
                        "primary_file": "products.json",
                        "regenerated_files": "all category/public product JSON, data JS, and bootstrap snapshots",
                    }
                )
        rebuild_catalog_files(products)

    counts = Counter(issue.issue_type for issue in all_issues)
    severities = Counter(issue.severity for issue in all_issues)
    summary = {
        "mode": "fix" if args.fix else "audit",
        "productCount": len(products),
        "issueCount": len(all_issues),
        "severityCounts": dict(severities),
        "issueTypeCounts": dict(counts),
        "fixableProductCount": len(pending_fixes),
        "appliedFixProductCount": len(touched),
        "reportDirectory": str(OUTPUT_DIR),
    }
    write_reports(all_issues, summary, touched)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
