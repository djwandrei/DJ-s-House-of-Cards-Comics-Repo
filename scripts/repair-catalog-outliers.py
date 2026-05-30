#!/usr/bin/env python3
"""
Apply high-confidence catalog fixes that are too specific for the generic
normalizer.

Why this exists:
- Some rows need one-off player/team/category repairs that depend on the exact
  title, not a broad heuristic.
- A few sports cards landed in the wrong category file and need to move before
  launch.
- Several school/team labels only need a spelling cleanup.

Run this after `normalize-sports-catalog.py`.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NORMALIZER_PATH = ROOT / "scripts" / "normalize-sports-catalog.py"


def load_normalizer():
    spec = importlib.util.spec_from_file_location("normalize_sports_catalog", NORMALIZER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


normalizer = load_normalizer()

CATEGORY_FILES = [
    "products-baseball.json",
    "products-basketball.json",
    "products-football.json",
    "products-comics.json",
    "products-collectibles.json",
]

TEAM_REPLACEMENTS = {
    "Arkansas Razor Backs": "Arkansas Razorbacks",
    "Auborn Tigers": "Auburn Tigers",
    "Portland Trailblazers": "Portland Trail Blazers",
}

ROW_MOVES = [
    {
        "id": 1381,
        "from": "products-basketball.json",
        "to": "products-baseball.json",
        "updates": {
            "category": "Baseball",
            "sport": "Baseball",
            "league": "USA Baseball",
            "playerAthlete": "Devereaux Harrison",
            "team": "",
        },
    },
    {
        "id": 1382,
        "from": "products-basketball.json",
        "to": "products-baseball.json",
        "updates": {
            "category": "Baseball",
            "sport": "Baseball",
            "league": "USA Baseball",
            "playerAthlete": "Landon Stump",
            "team": "",
        },
    },
    {
        "id": 1383,
        "from": "products-basketball.json",
        "to": "products-baseball.json",
        "updates": {
            "category": "Baseball",
            "sport": "Baseball",
            "league": "USA Baseball",
            "playerAthlete": "Will Sanders",
            "team": "",
        },
    },
    {
        "id": 1559,
        "from": "products-collectibles.json",
        "to": "products-basketball.json",
        "updates": {
            "category": "Basketball",
            "sport": "Basketball",
            "league": "NBA",
            "playerAthlete": "Peyton Watson | Vince Williams Jr.",
            "team": "Denver Nuggets | Memphis Grizzlies",
        },
    },
    {
        "id": 860,
        "from": "products-baseball.json",
        "to": "products-basketball.json",
        "updates": {
            "category": "Basketball",
            "sport": "Basketball",
            "league": "NBA",
            "playerAthlete": "Trajan Langdon",
            "team": "Cleveland Cavaliers",
        },
    },
    {
        "id": 2172,
        "from": "products-basketball.json",
        "to": "products-collectibles.json",
        "updates": {
            "category": "Collectibles",
            "sport": "Golf",
            "league": "PGA",
            "playerAthlete": "Tiger Woods",
            "team": "",
        },
    },
    {
        "id": 2380,
        "from": "products-basketball.json",
        "to": "products-collectibles.json",
        "updates": {
            "category": "Collectibles",
            "sport": "Golf",
            "league": "PGA",
            "playerAthlete": "Tiger Woods",
            "team": "",
        },
    },
]

ROW_UPDATES = {
    "products-baseball.json": {
        15: {"team": "New York Yankees | Milwaukee Braves"},
        22: {"playerAthlete": "Mickey Mantle", "team": "New York Yankees"},
        23: {
            "playerAthlete": "Richie Ashburn | Willie Mays",
            "team": "Philadelphia Phillies | San Francisco Giants",
        },
        86: {
            "playerAthlete": "Roberto Clemente | Hank Aaron | Willie Mays",
            "team": "Pittsburgh Pirates | Milwaukee Braves | San Francisco Giants",
        },
        852: {"playerAthlete": "Dizzy Trout | Steve Trout"},
        862: {"playerAthlete": "Jason Lane", "team": "Houston Astros"},
    },
    "products-basketball.json": {
        417: {"playerAthlete": "Larry Bird", "team": "Boston Celtics"},
        418: {"playerAthlete": "Larry Bird", "team": "Boston Celtics"},
        887: {"playerAthlete": "Acie Law IV", "team": "Atlanta Hawks"},
        1005: {
            "playerAthlete": "Derrick Rose | Dwyane Wade | Dirk Nowitzki | John Wall",
            "team": "Chicago Bulls | Miami Heat | Dallas Mavericks | Washington Wizards",
        },
        1082: {"team": "Orlando Magic"},
        1139: {"playerAthlete": "R.J. Barrett", "team": "New York Knicks"},
        1142: {"playerAthlete": "R.J. Barrett", "team": "New York Knicks"},
        1144: {"playerAthlete": "Wendell Carter Jr.", "team": "Chicago Bulls"},
        1157: {
            "playerAthlete": "Kevin Durant | Kyrie Irving | James Harden",
            "team": "Brooklyn Nets",
        },
        1168: {
            "playerAthlete": "LeBron James | Stephen Curry | Luka Dončić | Giannis Antetokounmpo | Nikola Jokić | Shai Gilgeous-Alexander",
            "team": "",
        },
        1170: {"playerAthlete": "", "team": ""},
        1171: {"playerAthlete": "", "team": ""},
        1172: {"playerAthlete": "", "team": ""},
        1315: {
            "playerAthlete": "Marcus Carr | Marvel Allen",
            "team": "",
            "league": "NCAA",
        },
        1324: {"team": ""},
        1345: {
            "playerAthlete": "Daimion Collins",
            "team": "Kentucky Wildcats",
            "league": "NCAA",
        },
        2374: {
            "playerAthlete": "Juju Watkins | Hailey Van Lith",
            "team": "",
            "league": "NCAA",
        },
        2485: {
            "playerAthlete": "Labaron Philon",
            "team": "",
            "league": "NCAA",
        },
        2528: {
            "playerAthlete": "Donovan Clingan",
            "team": "",
            "league": "NCAA",
        },
        2681: {
            "playerAthlete": "Ace Bailey",
            "team": "",
        },
    },
    "products-football.json": {
        544: {
            "playerAthlete": "A.J. Hawk",
            "team": "Ohio State Buckeyes",
            "league": "NCAA",
        },
        556: {
            "team": "USC Trojans",
            "league": "NCAA",
        },
        562: {
            "team": "USC Trojans",
            "league": "NCAA",
        },
        867: {"team": "Jacksonville Jaguars"},
        889: {"playerAthlete": "Malcolm Kelly", "team": "Washington Redskins"},
        1048: {"playerAthlete": "Mike Gillislee", "team": "Miami Dolphins"},
        1049: {"playerAthlete": "Tavarres King", "team": "Denver Broncos"},
        1090: {"playerAthlete": "Scott Crichton", "team": "Minnesota Vikings"},
        1017: {"team": "Houston Texans"},
        2384: {
            "playerAthlete": "Kasim Hill | Hasaan Hypolite | Brandon Porter",
            "league": "NCAA",
        },
    },
}


def split_pipe_values(value: str) -> list[str]:
    return normalizer.split_pipe_values(value)


def read_json(path: Path):
    return normalizer.read_json(path)


def write_json(path: Path, data) -> None:
    normalizer.write_json(path, data)


def apply_team_replacements(team_value: str) -> str:
    parts = split_pipe_values(team_value)
    if not parts:
        return team_value
    updated = [TEAM_REPLACEMENTS.get(part, part) for part in parts]
    return " | ".join(updated)


def sync_metadata_fields(item: dict) -> None:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    excel_fields = metadata.get("excelFields") if isinstance(metadata.get("excelFields"), dict) else {}

    metadata["sport"] = item.get("sport", "")
    metadata["league"] = item.get("league", "")
    metadata["playerAthlete"] = item.get("playerAthlete", "")

    if excel_fields:
        excel_fields["C:Sport"] = item.get("sport", "")
        excel_fields["C:League"] = item.get("league", "")
        excel_fields["C:Player/Athlete"] = item.get("playerAthlete", "")
        excel_fields["C:Team"] = item.get("team", "")

    item["metadata"] = metadata


def refresh_row(item: dict) -> None:
    item["team"] = apply_team_replacements(item.get("team", ""))
    sync_metadata_fields(item)
    item["description"] = normalizer.refresh_description(
        item,
        item.get("playerAthlete", ""),
        item.get("team", ""),
        item.get("condition", ""),
        normalizer.has_autograph(item),
    )


def sort_rows(rows: list[dict]) -> None:
    rows.sort(key=lambda row: int(row.get("id", 0)))


def dedupe_rows(rows: list[dict]) -> None:
    deduped: dict[int, dict] = {}
    for row in rows:
        deduped[int(row.get("id", 0))] = row
    rows[:] = list(deduped.values())


def move_rows(records_by_file: dict[str, list[dict]]) -> None:
    for move in ROW_MOVES:
        source_rows = records_by_file[move["from"]]
        target_rows = records_by_file[move["to"]]
        row = next((item for item in source_rows if int(item.get("id", -1)) == move["id"]), None)
        if row is None:
            continue
        source_rows.remove(row)
        target_rows[:] = [item for item in target_rows if int(item.get("id", -1)) != move["id"]]
        row.update(move["updates"])
        refresh_row(row)
        target_rows.append(row)


def apply_row_updates(records_by_file: dict[str, list[dict]]) -> None:
    for file_name, updates in ROW_UPDATES.items():
        rows_by_id = {int(item.get("id", -1)): item for item in records_by_file[file_name]}
        for row_id, fields in updates.items():
            row = rows_by_id.get(row_id)
            if row is None:
                continue
            row.update(fields)
            refresh_row(row)


def normalize_existing_rows(records_by_file: dict[str, list[dict]]) -> None:
    for file_name, rows in records_by_file.items():
        changed = file_name in {
            "products-baseball.json",
            "products-basketball.json",
            "products-football.json",
            "products-collectibles.json",
        }
        if not changed:
            continue
        for row in rows:
            updated_team = apply_team_replacements(row.get("team", ""))
            if updated_team != row.get("team", ""):
                row["team"] = updated_team
                refresh_row(row)


def main() -> None:
    records_by_file = {file_name: read_json(ROOT / file_name) for file_name in CATEGORY_FILES}
    move_rows(records_by_file)
    apply_row_updates(records_by_file)
    normalize_existing_rows(records_by_file)
    normalizer.apply_featured_rankings(records_by_file)

    for rows in records_by_file.values():
        dedupe_rows(rows)
        sort_rows(rows)

    for file_name, rows in records_by_file.items():
        write_json(ROOT / file_name, rows)

    normalizer.rebuild_combined_json()
    normalizer.rebuild_featured_json()
    normalizer.rebuild_preloaded_bundles()
    print("Catalog outlier repair complete.")


if __name__ == "__main__":
    main()
