#!/usr/bin/env python3
"""Improve the eBay bulk upload workbook using the current site catalog data."""

from __future__ import annotations

import json
import re
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.beckett_legacy_pricing import extract_card_number, normalize_spaces, player_guess, set_guess


GRADE_RE = re.compile(r"\b(PSA|BGS|SGC|CGC|HGA|BCCG|GAI|CSG)\s*([0-9](?:\.\d)?|10)\b", re.I)
AUTO_RE = re.compile(r"\b(auto(graph)?s?|autographed|signed|signature|signatures|on-card)\b", re.I)
SEASON_RE = re.compile(r"^((?:19|20)\d{2}-(?:\d{2}))\b")
YEAR_RE = re.compile(r"^((?:19|20)\d{2})\b")

MANUFACTURER_PATTERNS = [
    (r"\bcollector'?s edge\b", "Collector's Edge"),
    (r"\bjust minors\b", "Just Minors"),
    (r"\bpress pass\b", "Press Pass"),
    (r"\bupper deck\b|\bsp authentic\b|\bspx\b|\bud\b|\buda\b|\bgoodwin\b|\bultimate collection\b", "Upper Deck"),
    (r"\btopps\b", "Topps"),
    (r"\bbowman\b", "Bowman"),
    (r"\bpanini\b|\bprizm\b|\boptic\b|\bselect\b|\bchronicles\b|\bcrown royale\b|\bcontenders\b|\bhoops\b|\btotally certified\b|\bplates and patches\b|\brookies & stars\b|\bepix\b", "Panini"),
    (r"\bdonruss\b|\bplayoff\b|\bleaf certified materials\b|\babsolute memorabilia\b", "Donruss"),
    (r"\bleaf\b", "Leaf"),
    (r"\bsage\b", "Sage"),
    (r"\bscore\b", "Score"),
    (r"\bfleer\b|\bflair\b", "Fleer"),
    (r"\bonyx\b", "Onyx"),
    (r"\bwild card\b", "Wild Card"),
    (r"\bpacific\b", "Pacific"),
]

PARALLEL_PATTERNS = [
    ("X-Fractor", [r"\bx-?fractor\b"]),
    ("Refractor", [r"\brefractor(s)?\b"]),
    ("Prizm", [r"\bprizm(s)?\b"]),
    ("Chrome", [r"\bchrome\b"]),
    ("Optic", [r"\boptic\b"]),
    ("Holo", [r"\bholo\b"]),
    ("Mojo", [r"\bmojo\b"]),
    ("Shimmer", [r"\bshimmer\b"]),
    ("Speckle", [r"\bspeckle\b"]),
    ("Lava", [r"\blava\b"]),
    ("Pulsar", [r"\bpulsar\b"]),
    ("Wave", [r"\bwave\b"]),
    ("Foil", [r"\bfoil\b"]),
    ("Die-Cut", [r"\bdie-?cut\b"]),
    ("Sepia", [r"\bsepia\b"]),
    ("Tiffany", [r"\btiffany\b"]),
    ("Ice", [r"\bice\b"]),
    ("Glitter", [r"\bglitter\b"]),
    ("Aqua", [r"\baqua\b"]),
    ("Fuchsia", [r"\bfuchsia\b"]),
    ("Blue", [r"\bblue\b"]),
    ("Red", [r"\bred\b"]),
    ("Green", [r"\bgreen\b"]),
    ("Gold", [r"\bgold\b"]),
    ("Silver", [r"\bsilver\b"]),
    ("Purple", [r"\bpurple\b"]),
    ("Orange", [r"\borange\b"]),
    ("Pink", [r"\bpink\b"]),
    ("Black", [r"\bblack\b"]),
    ("Bronze", [r"\bbronze\b"]),
    ("Yellow", [r"\byellow\b"]),
]
COLOR_LABELS = {"Aqua", "Fuchsia", "Blue", "Red", "Green", "Gold", "Silver", "Purple", "Orange", "Pink", "Black", "Bronze", "Yellow"}
SET_FIXUPS = {
    "Collector s Edge": "Collector's Edge",
    "Rookies Stars": "Rookies & Stars",
}
MANUAL_TITLE_OVERRIDES = {
    "1997 Just Minors Zach Sorensen Limited Edition Rookie Auto SP": {
        "C:Set": "1997 Just Minors",
        "C:Player/Athlete": "Zach Sorensen",
    },
    "2005 Upper Deck Ultimate Collection Jake Westbrook Young Stars Rookie Patch /20": {
        "C:Player/Athlete": "Jake Westbrook",
    },
    "2007 Ultimate Collection Jamarcus Russell Brady Quinn Rookie Material Patch /99": {
        "C:Set": "2007 Ultimate Collection",
        "C:Player/Athlete": "JaMarcus Russell | Brady Quinn",
    },
    "2008 Donruss Celebrity Cuts Carrie Fisher Silver Foil /499 #12 Star Wars": {
        "C:Player/Athlete": "Carrie Fisher",
        "C:Team": "",
    },
    "2008 SP Malcolm Kelly Rookie Threads Green Dual Patch /75 #RT-MK": {
        "C:Manufacturer": "Upper Deck",
        "C:Set": "2008 SP Rookie Threads",
    },
    "2015 Topps Star Wars Journey To Force Awakens Sticker Obi-Wan + Chewbacca SP Set": {
        "C:Player/Athlete": "Obi-Wan Kenobi | Chewbacca",
        "C:Team": "",
    },
    "2012-13 Panini Past & Present Rise 'N Shine Insert Set (x20) Rose Wade Dirk Wall": {
        "C:Set": "2012-13 Panini Past & Present",
    },
    "2022 Fire Justin Turner /299 + Trea Die-Cut + Gold Kershaw & Dodgers RC Set": {
        "C:Manufacturer": "Topps",
        "C:Set": "2022 Topps Fire",
    },
    "2022 Donruss Fernando Tatis Jr Marvels Silver Shimmer Holo + Diamond King Insert": {
        "C:Set": "2022 Donruss",
    },
    "2023 Big League Jacob Degrom Black /25 + Corey Seager Refractor + Rangers Rookie": {
        "C:Manufacturer": "Topps",
        "C:Set": "2023 Topps Big League",
    },
    "2023 SportKings Vol No. 4 Ricky Rudd Race Worn Relic Card #LSM-58": {
        "C:Manufacturer": "Sage",
        "C:Set": "2023 SportKings Volume 4",
        "C:Player/Athlete": "Ricky Rudd",
        "C:Sport": "Auto Racing",
        "C:League": "NASCAR",
        "C:Team": "",
    },
    "2023 Sportkings Volume No. 4 Darrell Green Game Worn Relic Patch #LSM-68": {
        "C:Manufacturer": "Sage",
        "C:Set": "2023 SportKings Volume 4",
    },
    "2023 Sportkings Volume No. 4 Rich Gannon Game Worn Relic Patch #LSM-70": {
        "C:Manufacturer": "Sage",
        "C:Set": "2023 SportKings Volume 4",
    },
    "2023 Topps Series 1 Stars of MLB Near Complete Set - 27 / 30 Cards": {
        "C:Player/Athlete": "",
    },
    "2023-24 Goodwin Champions Maria Sharapova All World Red /299 Tennis SP Set (x8)": {
        "C:Set": "2023-24 Goodwin Champions",
        "C:Player/Athlete": "Maria Sharapova",
        "C:Sport": "Tennis",
        "C:Team": "",
    },
    "2025 Topps Chrome UFC Hyunsung Park Red White Blue Prizm Rookie /88": {
        "C:Player/Athlete": "Hyunsung Park",
        "C:Team": "",
    },
}


def backup_file(path: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.stem}.backup-{stamp}{path.suffix}")
    shutil.copy2(path, backup)
    return backup


def title_prefix(title: str, year: str | int | None) -> str:
    title = normalize_spaces(title)
    season_match = SEASON_RE.search(title)
    if season_match:
        return season_match.group(1)
    year_match = YEAR_RE.search(title)
    if year_match:
        return year_match.group(1)
    return str(year or "")


def raw_set_guess(product: dict) -> str:
    title = normalize_spaces(product.get("name", ""))
    if not title:
        return ""
    prefix = title_prefix(title, product.get("year"))
    work = title
    if prefix and work.lower().startswith(prefix.lower()):
        work = work[len(prefix) :].lstrip(" -")
    player = normalize_spaces(player_guess(product))
    card_number = extract_card_number(title)
    end_positions: list[int] = []
    if player:
        idx = work.lower().find(player.lower())
        if idx >= 0:
            end_positions.append(idx)
    if card_number:
        match = re.search(rf"#\s*{re.escape(card_number)}\b", work, re.I)
        if match:
            end_positions.append(match.start())
    if end_positions:
        work = work[: min(end_positions)]
    work = re.sub(
        r"\b(Rookie|RC|Auto(?:graph)?|Autographed|Signed|Patch|Relic|Jersey|Memorabilia|Game[- ]Used|Game[- ]Worn|Serial Numbered)\b.*$",
        "",
        work,
        flags=re.I,
    )
    work = normalize_spaces(work.strip(" -,+/"))
    if len(work.split()) > 8:
        return ""
    if prefix and work and not work.startswith(prefix):
        return normalize_spaces(f"{prefix} {work}")
    return work


def normalize_set_value(product: dict) -> str:
    guess = normalize_spaces(raw_set_guess(product))
    if not guess:
        guess = normalize_spaces(set_guess(product))
    if not guess:
        return ""
    for source, target in SET_FIXUPS.items():
        guess = re.sub(rf"\b{re.escape(source)}\b", target, guess, flags=re.I)
    return guess


def normalize_manufacturer(title: str) -> str:
    for pattern, value in MANUFACTURER_PATTERNS:
        if re.search(pattern, title, re.I):
            return value
    return ""


def remove_entity_phrases(title: str, product: dict) -> str:
    work = normalize_spaces(title)
    for phrase in [normalize_set_value(product), product.get("playerAthlete"), product.get("team")]:
        phrase = normalize_spaces(phrase)
        if not phrase:
            continue
        work = re.sub(re.escape(phrase), " ", work, flags=re.I)
    return normalize_spaces(work)


def derive_parallel_variety(title: str, product: dict) -> str:
    # Remove the set name before looking for parallel clues so we do not
    # mistake set branding like Bowman Chrome, Panini Prizm, or Turkey Red
    # for an actual eBay parallel/variation value.
    work = remove_entity_phrases(title, product).lower()
    has_parallel_context = bool(
        re.search(r"refractor|prizm|parallel|x-?fractor|mojo|shimmer|speckle|lava|pulsar|wave|foil|die-?cut|sepia|tiffany|ice|glitter|chrome|optic|holo", work)
    )
    found: list[str] = []
    for label, patterns in PARALLEL_PATTERNS:
        if label in COLOR_LABELS and not has_parallel_context and not re.search(r"/\d+", work):
            continue
        if any(re.search(pattern, work, re.I) for pattern in patterns):
            found.append(label)
    # Keep order stable and remove duplicates.
    unique = list(dict.fromkeys(found))
    return "|".join(unique)


def derive_features(title: str, description: str, product: dict) -> str:
    title = title.lower()
    description = (description or "").lower()
    features: list[str] = []
    if re.search(r"\brookie\b|\brc\b", title):
        features.append("Rookie")
    if re.search(r"\bsp\b|\bssp\b|short print", title):
        features.append("Short Print")
    if re.search(r"\b1/1\b|one of one", title) or title.count("1/1"):
        features.append("One of One")
    if re.search(r"/\d+|serial numbered", title) or re.search(r"/\d+|serial numbered", description):
        features.append("Serial Numbered")
    if re.search(r"jersey|patch|relic|game[- ]used|game[- ]worn|threads|material|memorabilia|helmet", title) or re.search(
        r"jersey|patch|relic|game[- ]used|game[- ]worn|threads|material|memorabilia|helmet", description
    ):
        features.append("Memorabilia")
    if derive_parallel_variety(title, product):
        features.append("Parallel/Variety")
    return "|".join(features)


def parse_grading(condition: str) -> tuple[str, str]:
    match = GRADE_RE.search(condition or "")
    if not match:
        return "", ""
    grader = match.group(1).upper()
    grade = match.group(2)
    return grader, grade


def apply_manual_overrides(ws, row_num: int, idx: dict[str, int], title: str, changes: Counter) -> None:
    overrides = MANUAL_TITLE_OVERRIDES.get(title, {})
    for column_name, desired in overrides.items():
        cell = ws.cell(row=row_num, column=idx[column_name])
        existing = cell.value
        normalized_existing = normalize_spaces(existing)
        normalized_desired = normalize_spaces(desired)
        if normalized_existing == normalized_desired:
            continue
        cell.value = desired
        changes["manual_override_updates"] += 1


def main() -> int:
    workbook_path = Path(r"C:\Users\djwan\Documents\eBay Docs\Listing Automation\Ebay Bulk Upload with HTML.xlsx")
    products = {p["name"]: p for p in json.loads(Path("products.json").read_text(encoding="utf-8"))}
    backup = backup_file(workbook_path)
    wb = load_workbook(workbook_path)
    ws = wb["Sheet1"]
    headers = [ws.cell(row=1, column=c).value for c in range(1, ws.max_column + 1)]
    idx = {header: position + 1 for position, header in enumerate(headers)}

    changes = Counter()
    for row_num in range(2, ws.max_row + 1):
        title = ws.cell(row=row_num, column=idx["Title"]).value
        if not title or title not in products:
            continue
        product = products[title]
        description = product.get("description", "")
        condition = normalize_spaces(product.get("condition", ""))

        # Fill set/manufacturer/season only when the current cells are blank.
        if ws.cell(row=row_num, column=idx["C:Set"]).value in (None, ""):
            set_value = normalize_set_value(product)
            if set_value:
                ws.cell(row=row_num, column=idx["C:Set"]).value = set_value
                changes["set_filled"] += 1

        if ws.cell(row=row_num, column=idx["C:Manufacturer"]).value in (None, ""):
            manufacturer = normalize_manufacturer(title)
            if manufacturer:
                ws.cell(row=row_num, column=idx["C:Manufacturer"]).value = manufacturer
                changes["manufacturer_filled"] += 1

        season_cell = ws.cell(row=row_num, column=idx["C:Season"])
        expected_season = title_prefix(title, product.get("year"))
        if expected_season and season_cell.value in (None, ""):
            season_cell.value = expected_season
            changes["season_filled"] += 1
        elif expected_season and str(season_cell.value) != expected_season and SEASON_RE.search(title):
            season_cell.value = expected_season
            changes["season_corrected"] += 1

        # Populate the missing parallel/variety column when the title makes it explicit.
        if ws.cell(row=row_num, column=idx["C:Parallel/Variety"]).value in (None, ""):
            variety = derive_parallel_variety(title, product)
            if variety:
                ws.cell(row=row_num, column=idx["C:Parallel/Variety"]).value = variety
                changes["parallel_filled"] += 1

        # Fill missing features using the existing workbook vocabulary.
        if ws.cell(row=row_num, column=idx["C:Features"]).value in (None, ""):
            features = derive_features(title, description, product)
            if features:
                ws.cell(row=row_num, column=idx["C:Features"]).value = features
                changes["features_filled"] += 1

        # Keep autograph flags aligned with the current listing title.
        expected_auto = "Yes" if AUTO_RE.search(title) else "No"
        auto_cell = ws.cell(row=row_num, column=idx["C:Autographed"])
        if str(auto_cell.value or "") != expected_auto:
            auto_cell.value = expected_auto
            changes["autographed_updated"] += 1

        grader, grade = parse_grading(condition)
        if grader and grade:
            ws.cell(row=row_num, column=idx["Condition ID"]).value = "2750-Graded"
            if ws.cell(row=row_num, column=idx["CD:Professional Grader - (ID: 27501)"]).value in (None, ""):
                ws.cell(row=row_num, column=idx["CD:Professional Grader - (ID: 27501)"]).value = grader
                changes["grader_filled"] += 1
            if ws.cell(row=row_num, column=idx["CD:Grade - (ID: 27502)"]).value in (None, ""):
                ws.cell(row=row_num, column=idx["CD:Grade - (ID: 27502)"]).value = grade
                changes["grade_filled"] += 1
            ws.cell(row=row_num, column=idx["CD:Card Condition - (ID: 40001)"]).value = None
        else:
            if "brand new" not in condition.lower() and ws.cell(row=row_num, column=idx["CD:Card Condition - (ID: 40001)"]).value in (None, ""):
                ws.cell(row=row_num, column=idx["CD:Card Condition - (ID: 40001)"]).value = "Near mint or better - (ID: 400010)"
                changes["card_condition_filled"] += 1

        # Exact-title fixes for the handful of rows where legacy imports left
        # set words or placeholder text in player/team/manufacturer fields.
        apply_manual_overrides(ws, row_num, idx, title, changes)

    wb.save(workbook_path)
    print(f"Backup created: {backup}")
    print(dict(changes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
