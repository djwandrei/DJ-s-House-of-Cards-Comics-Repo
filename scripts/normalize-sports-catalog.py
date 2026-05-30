#!/usr/bin/env python3
"""
Normalize the sports catalog so the storefront stops surfacing misleading
 team/grade/player data from older imports.

Why this exists:
- Older legacy imports sometimes use set names or placeholder labels in the
  `team` field (for example `Legacy Football Import` or `2013 Bowman`).
- Some modern items clearly mention a grader in the title, but the stored
  condition still says `Near mint or better`.
- Several items have enough metadata to restore player/team/autograph context,
  but the public JSON never received the cleanup.

This script keeps the cleanup repeatable by:
1. Normalizing the three sports source files.
2. Rebuilding the combined sports/full JSON files.
3. Refreshing the preloaded browser bundles that mirror those JSON files.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SPORT_FILES = [
    "products-baseball.json",
    "products-basketball.json",
    "products-football.json",
]

COMBINED_FILES = {
    "products-sports.json": [
        "products-baseball.json",
        "products-basketball.json",
        "products-football.json",
    ],
    "products.json": [
        "products-baseball.json",
        "products-basketball.json",
        "products-football.json",
        "products-comics.json",
        "products-collectibles.json",
    ],
}

PRELOADED_TARGETS = {
    "products-baseball.json": "products-data-baseball.js",
    "products-basketball.json": "products-data-basketball.js",
    "products-football.json": "products-data-football.js",
    "products-sports.json": "products-data-sports.js",
    "products.json": "products-data-full.js",
    "products-featured.json": "products-data-featured.js",
}

YEAR_SPAN_PATTERN = r"(?:19|20)\d{2}(?:-(?:\d{2}|\d{4}))?"

# These brands are useful for recognizing when the stored "team" value is
# really a set or manufacturer label instead of an actual franchise/school.
CARD_BRANDS = [
    "topps",
    "bowman",
    "donruss",
    "panini",
    "upper deck",
    "leaf",
    "fleer",
    "hoops",
    "score",
    "sage",
    "stadium club",
    "wild card",
    "press pass",
    "collector's edge",
    "collectors edge",
    "playoff",
    "prizm",
    "optic",
    "chrome",
    "revolution",
    "goodwin",
    "select",
    "mosaic",
    "elite",
    "plates and patches",
    "prestige",
    "contenders",
    "threads",
    "skybox",
    "spx",
    "sp authentic",
    "classics",
    "perez-steele",
]

LEADING_SET_PHRASES = [
    "upper deck",
    "press pass",
    "allen & ginter",
    "plates and patches",
    "elite extra edition",
    "goodwin champions",
    "rookies & stars",
    "sweet spot",
    "crown royale",
    "tier one",
    "leaf memories",
    "leaf metal",
    "leaf trinity",
    "metal draft",
    "premier draft",
    "stadium club",
    "wild card",
    "collector's edge",
    "collectors edge",
    "leaf pro set power",
    "pro set power",
    "pro set",
    "past & present",
    "nba hoops",
    "limited",
    "mcdonald's chrome",
    "mcdonalds chrome",
    "chrome mcdonald's",
    "chrome mcdonalds",
    "mcdonald's",
    "mcdonalds",
    "totally certified",
    "sp authentic",
    "topps heritage",
    "topps mcdonald's chrome",
    "topps mcdonalds chrome",
    "topps chrome mcdonald's",
    "topps chrome mcdonalds",
    "topps triple threads",
    "topps unrivaled",
    "topps update",
    "triple threads",
    "trinity",
    "bowman university chrome",
    "bowman university chorme",
    "bowman university best",
    "bowman university inception",
    "golden age",
    "bowman inception",
    "bowman sterling",
    "bowman u chrome",
    "bowman u best",
    "u chrome",
    "u best",
    "ud goodwin champions",
    "basketball rookie remnants",
    "rookie remnants",
    "donruss optic",
    "panini prizm",
    "panini prizm dp",
    "prizm dp",
    "ote inception",
    "artistry football",
    "stars & stripes",
    "leaf multigraphics",
    "multigraphics",
    "sportkings volume no. 4",
    "sportkings volume no 4",
    "series 1",
    "series 2",
    "sage hit",
    "university chrome",
    "university chorme",
    "university best",
    "university inception",
    "university",
    "totally",
    "certified",
    "unrivaled",
    "upper",
    "deck",
    "topps",
    "bowman",
    "sterling",
    "donruss",
    "panini",
    "leaf",
    "fleer",
    "hoops",
    "score",
    "sage",
    "hit",
    "press",
    "pass",
    "u chrome",
    "prizm",
    "optic",
    "chrome",
    "inception",
    "elite",
    "extra",
    "edition",
    "metal",
    "memories",
    "heritage",
    "update",
    "ote",
    "football",
    "draft",
    "revolution",
    "select",
    "mosaic",
    "prestige",
    "contenders",
    "skybox",
    "spx",
]

GENERIC_TEAM_PATTERNS = [
    re.compile(r"^(?:baseball|basketball|football|sports?)$", re.I),
    re.compile(r"^(?:baseball|basketball|football)\s+cards$", re.I),
    re.compile(r"^legacy\s+.*\s+import$", re.I),
    re.compile(rf"^(?:{YEAR_SPAN_PATTERN}\s+)?generation\s+now$", re.I),
]

TEAM_LOWERCASE_WORDS = {"of", "the", "and", "at", "for"}
CARD_BRAND_RE = re.compile("|".join(re.escape(brand) for brand in CARD_BRANDS), re.I)
GRADE_COMPANY_RE = re.compile(
    r"\b(PSA/DNA|PSA|BGS|BVG|BCCG|SGC|CGC|CSG|HGA|GMA|ISA|TAG|BECKETT)\b",
    re.I,
)

# College/pre-draft products should not be force-mapped to pro teams when the
# catalog never stored the school correctly in the first place.
COLLEGE_SET_RE = re.compile(
    r"\b(press pass|sage|leaf draft|all-american|senior bowl|college ticket|ncaa|"
    r"bowman u(?:niversity)?|prizm dp|panini prizm draft|mcdonald'?s chrome)\b",
    re.I,
)

INVALID_PLAYER_RE = re.compile(
    r"\b("
    r"most valuable player|hitting kings?|home run leaders?|batting leaders?|"
    r"scoring leaders?|rebounding leaders?|two famous fisherman|"
    r"crash lands|homer for crown|traded series|complete boxed set|"
    r"whole squad|future stars set|nba hoops"
    r")\b",
    re.I,
)

PLAYER_STOP_TOKEN_RE = re.compile(
    r"^(?:"
    r"Rookie|RC|Auto(?:graph)?|Autographs?|Autographed|Signature|Signatures|Signed|"
    r"Game[- ]?Worn|Authentic|Jersey|Patch|Relic|Memorabilia|Material|Materials|"
    r"Refractor|Prizm|Parallel|Variation|Bronze|Silver|Gold|Green|Blue|Purple|"
    r"Orange|Red|Aqua|Pink|Black|White|Yellow|Holo|Foil|Disco|Wave|Shimmer|"
    r"SP|SSP|Prospect|Ticket|Clear|Premier|Unity|Prime|Silhouettes|Threads|"
    r"Set|Complete|Lot|Proof|Print[- ]?Used|Plate|Picks|Insert|Mini|Helmet|"
    r"Campus|Legends|Debut|Flashing|Lights"
    r")$",
    re.I,
)
COLOR_SUFFIX_WORDS = {
    "aqua",
    "black",
    "blue",
    "bronze",
    "gold",
    "green",
    "orange",
    "pink",
    "platinum",
    "purple",
    "red",
    "silver",
    "white",
    "yellow",
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def normalize_space(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def canonical_key(value) -> str:
    normalized = (
        normalize_space(value)
        .lower()
        .replace(".", "")
        .replace("'", "")
        .replace("’", "")
    )
    return re.sub(r"[^a-z0-9]+", " ", normalized).strip()


def split_pipe_values(value) -> list[str]:
    normalized = normalize_space(value)
    if not normalized:
        return []
    return [normalize_space(part) for part in re.split(r"\s*\|\s*", normalized) if normalize_space(part)]


def title_case_token(token: str) -> str:
    raw = token.strip()
    if not raw:
        return ""

    if "'" in raw:
        lower = raw.lower()
        if lower.startswith("o'") and len(lower) > 2:
            return "O'" + lower[2:].capitalize()
        first, *rest = lower.split("'")
        suffix = "'".join(rest)
        return f"{first.capitalize()}'{suffix}" if suffix else first.capitalize()

    if re.fullmatch(r"([A-Za-z]\.){1,4}", raw):
        return raw.upper()
    if raw.isupper() and raw.isalpha() and 1 < len(raw) <= 3:
        return raw

    lower = raw.lower()
    if lower in {"ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"}:
        return lower.upper()
    if lower in {"jr", "sr", "jr.", "sr."}:
        return lower[:2].capitalize() + "."
    if lower in TEAM_LOWERCASE_WORDS:
        return lower
    if lower.startswith("mc") and len(lower) > 2:
        return "Mc" + lower[2:].capitalize()
    if raw.islower() or raw.isupper():
        return lower.capitalize()
    return raw


def title_case_value(value) -> str:
    """
    Apply display-safe title casing while preserving pipes and simple initials.
    """
    values = split_pipe_values(value) or [normalize_space(value)]
    normalized_parts: list[str] = []
    for chunk in values:
        words: list[str] = []
        for word in chunk.split():
            pieces = re.split(r"([-/])", word)
            rebuilt = "".join(
                title_case_token(piece) if piece not in "-/" else piece
                for piece in pieces
            )
            words.append(rebuilt)
        normalized_parts.append(" ".join(words))
    return " | ".join(part for part in normalized_parts if part)


def get_metadata(item: dict) -> tuple[dict, dict]:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    excel_fields = metadata.get("excelFields") if isinstance(metadata.get("excelFields"), dict) else {}
    return metadata, excel_fields


def detail_field(label: str, text: str) -> str:
    match = re.search(rf"{label}:\s*([^;\n]+)", text or "", re.I)
    return normalize_space(match.group(1)) if match else ""


def item_sport_key(item: dict) -> str:
    sport = normalize_space(item.get("sport") or item.get("category"))
    return canonical_key(sport)


def audience_copy(item: dict) -> str:
    sport = normalize_space(item.get("sport") or item.get("category"))
    league = normalize_space(item.get("league"))
    if sport and league:
        return f"{sport.lower()} fans, {league.upper()} collectors, and set builders"
    if sport:
        return f"{sport.lower()} fans and set builders"
    return "collectors and set builders"


def remove_team_parts_from_player(player_value: str, team_value: str) -> str:
    player_parts = split_pipe_values(player_value)
    team_keys = {canonical_key(part) for part in split_pipe_values(team_value)}
    if not player_parts or not team_keys:
        return player_value
    filtered = [part for part in player_parts if canonical_key(part) not in team_keys]
    return " | ".join(filtered)


def readable_list(value: str, prefix_the: bool = False) -> str:
    parts = split_pipe_values(value)
    if not parts:
        return ""
    if prefix_the:
        parts = [f"the {part}" for part in parts]
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return ", ".join(parts[:-1]) + f", and {parts[-1]}"


def generated_lead_sentence(item: dict, description: str, player_value: str, team_value: str) -> str:
    set_value = detail_field("Set", description)
    season_value = detail_field("Season", description)
    year_value = normalize_space(item.get("year"))

    if set_value:
        reference = f"{set_value} card"
    elif season_value:
        reference = f"{season_value} card"
    elif year_value:
        reference = f"{year_value} card"
    else:
        reference = "This card"

    if player_value and team_value:
        return (
            f"{reference} featuring {readable_list(player_value)} "
            f"with connections to {readable_list(team_value, prefix_the=True)}."
        )
    if player_value:
        return f"{reference} featuring {readable_list(player_value)}."
    if team_value:
        return f"{reference} centered on {readable_list(team_value, prefix_the=True)}."
    return f"{reference} highlighted in the title."


def is_generic_team(team_value, item: dict | None = None) -> bool:
    """
    Detect placeholder/set-style team values so we can blank them instead of
    keeping obviously wrong filter data in the UI.
    """
    team = normalize_space(team_value)
    if not team:
        return True

    if any(pattern.match(team) for pattern in GENERIC_TEAM_PATTERNS):
        return True

    if item is not None:
        reference_values = {
            normalize_space(item.get(key)).lower()
            for key in ("category", "sport", "league", "sourcePage")
            if normalize_space(item.get(key))
        }
        if team.lower() in reference_values:
            return True

    if re.search(r"\b\d{4}(?:-\d{2})?\b", team) and CARD_BRAND_RE.search(team):
        return True

    if CARD_BRAND_RE.search(team) and len(team.split()) <= 7:
        return True

    return False


def collect_text(item: dict) -> str:
    metadata, excel_fields = get_metadata(item)
    gallery = item.get("imageGallery") if isinstance(item.get("imageGallery"), list) else []
    values = [
        item.get("name"),
        item.get("description"),
        item.get("condition"),
        item.get("team"),
        item.get("playerAthlete"),
        item.get("legacyImageLabel"),
        item.get("image"),
        item.get("sport"),
        item.get("league"),
        metadata.get("playerAthlete"),
        excel_fields.get("Title"),
        excel_fields.get("Description"),
        excel_fields.get("C:Player/Athlete"),
        excel_fields.get("C:Team"),
        excel_fields.get("C:Features"),
        excel_fields.get("C:Autographed"),
        " ".join(str(value) for value in gallery),
    ]
    return normalize_space(" ".join(str(value) for value in values if value))


def extract_direct_player(item: dict) -> str:
    metadata, excel_fields = get_metadata(item)
    return normalize_space(
        item.get("playerAthlete")
        or metadata.get("playerAthlete")
        or excel_fields.get("C:Player/Athlete")
        or detail_field("Player", item.get("description", ""))
    )


def is_plausible_player_value(player_value: str) -> bool:
    player = normalize_space(player_value)
    if not player:
        return False

    if INVALID_PLAYER_RE.search(player):
        return False

    if canonical_key(player) in {"baseball", "basketball", "football", "sports"}:
        return False

    # One-token player values in this catalog are usually failed extractions
    # like `Draft`, `Broderick`, or `Otis`, not intentionally stored mononyms.
    if len(player.split()) == 1:
        return False

    # If the stored value still starts with a set phrase, it is more likely the
    # result of a previous bad extraction than a real player name.
    leading_stripped = strip_leading_set_phrases(player)
    if leading_stripped != player and len(leading_stripped.split()) < len(player.split()):
        return False

    return True


def clean_player_value(player_value: str) -> str:
    """
    Remove obvious set/category contamination from a stored player value while
    keeping legitimate multi-player values intact.
    """
    cleaned_parts: list[str] = []
    seen_parts: set[str] = set()
    for raw_part in split_pipe_values(player_value):
        stripped = strip_feature_suffixes(strip_leading_set_phrases(title_case_value(raw_part)))
        stripped = re.sub(r'\s+["“][^"”]+["”]', "", stripped)
        stripped = re.sub(r"\s+\d+(?:/\d+)?$", "", stripped)
        stripped = re.sub(r"\s*[+&]\s*$", "", stripped)
        stripped = normalize_space(stripped)
        key = canonical_key(stripped)
        if not stripped or key in {"baseball", "basketball", "football", "sports"}:
            continue
        if INVALID_PLAYER_RE.search(stripped):
            continue
        if re.search(r"[&+]", stripped) and len(re.findall(r"[A-Za-z]+", stripped)) < 3:
            continue
        if len(stripped.split()) == 1:
            continue
        if re.search(r"\d", stripped):
            continue
        if key in seen_parts:
            continue
        seen_parts.add(key)
        cleaned_parts.append(stripped)
    return " | ".join(cleaned_parts)


def extract_direct_team(item: dict) -> str:
    metadata, excel_fields = get_metadata(item)
    return normalize_space(
        item.get("team")
        or excel_fields.get("C:Team")
        or detail_field("Team", item.get("description", ""))
    )


def extract_direct_condition(item: dict) -> str:
    return normalize_space(item.get("condition"))


def resolve_league(item: dict) -> str:
    text = collect_text(item)
    if COLLEGE_SET_RE.search(text):
        return "NCAA"
    return normalize_space(item.get("league"))


def strip_feature_suffixes(text: str) -> str:
    cleaned = re.sub(
        r"\b("
        r"Rookie Card|Rookie|RC|Auto(?:graph)?s?|Autograph|Autographed|In-Person Autograph|"
        r"On-Card|Game[- ]Worn|Authentic Game[- ]Worn|Game[- ]Used|Game Materials?|"
        r"Patch|Jersey|Memorabilia|Relic|Insert|Set|Prospect Ticket|Prospect|"
        r"Clear|Unity|Premier|Prime|Silhouettes|Signatures?|Ticket|"
        r"Mini Helmet|Helmet|Bat|Bats|Pants|Ohio State|Campus Legends|Rise '?N Shine|Rise N Shine|"
        r"NBA Debut|Gameday Ticket|Flashing Lights|Pink Ice|Blue Red|Choice|"
        r"Foil|Border|Jumbo|Prizm|Refractor|Holo|"
        r"Disco|Wave|Shimmer|Parallel|Variation|SP|SSP|UER|DP|"
        r"Short Print|#/?.*|/\d+"
        r")\b",
        "",
        text,
        flags=re.I,
    )
    tokens = normalize_space(cleaned).split()
    while len(tokens) > 2 and tokens[-1].lower() in COLOR_SUFFIX_WORDS:
        tokens.pop()
    return normalize_space(" ".join(tokens))


def strip_leading_set_phrases(text: str) -> str:
    cleaned = normalize_space(text)
    for _ in range(8):
        updated = cleaned
        for phrase in sorted(LEADING_SET_PHRASES, key=len, reverse=True):
            updated = re.sub(rf"^{re.escape(phrase)}(?:\s+|$)", "", updated, flags=re.I)
        updated = normalize_space(updated)
        if updated == cleaned:
            break
        cleaned = updated
    return cleaned


def extract_player_guess(item: dict, known_players: list[str]) -> str:
    """
    Prefer explicit player metadata. Otherwise try known-player text matches,
    then fall back to the title prefix before the year/set.
    """
    direct = extract_direct_player(item)
    cleaned_direct = clean_player_value(direct)
    if cleaned_direct and is_plausible_player_value(cleaned_direct):
        return cleaned_direct

    title_candidate = extract_player_from_title(item)
    if title_candidate:
        return title_candidate

    haystack = collect_text(item).lower()
    matched_players: list[str] = []
    seen_keys: set[str] = set()
    for player in known_players:
        key = canonical_key(player)
        if key in seen_keys:
            continue
        if player.lower() in haystack:
            matched_players.append(player)
            seen_keys.add(key)
    if matched_players:
        return " | ".join(matched_players[:3])

    title = normalize_space(item.get("name"))
    prefix = re.split(rf"\b{YEAR_SPAN_PATTERN}\b", title, maxsplit=1)[0].strip(" -|,/")
    prefix = strip_feature_suffixes(prefix)

    if not prefix:
        # Many modern listings begin with the year and brand, so fall back to
        # parsing the text that comes after that set prefix.
        remainder = re.sub(rf"^{YEAR_SPAN_PATTERN}\s+", "", title)
        remainder = strip_leading_set_phrases(remainder)

        # Player names usually appear immediately after the set prefix on
        # modern titles, so capture the first run of likely name tokens before
        # feature/grade keywords start.
        candidate_tokens: list[str] = []
        for token in remainder.split():
            if re.fullmatch(YEAR_SPAN_PATTERN, token):
                break
            if token.startswith("#"):
                break
            if GRADE_COMPANY_RE.fullmatch(token):
                break
            if re.fullmatch(
                r"(Rookie|RC|Auto(?:graph)?|Autograph|Patch|Jersey|Memorabilia|"
                r"Relic|Refractor|Prizm|Parallel|Variation|Bronze|Silver|Gold|"
                r"Green|Blue|Purple|Orange|Red|Holo|SP|SSP|Prospect|Signature|"
                r"Signatures|Series|Proof|Print-Used|Plate|Picks)",
                token,
                re.I,
            ):
                break
            candidate_tokens.append(token)
            if len(candidate_tokens) >= 2 and not re.fullmatch(r"(Jr\.?|Sr\.?|II|III|IV|V)", token, re.I):
                break

        prefix = clean_player_value(" ".join(candidate_tokens))

    if (
        prefix
        and 1 <= len(prefix.split()) <= 4
        and not re.search(
            r"\b("
            r"league|leaders|all-star|series|famous|world|batting|home run|"
            r"scoring|rebounding|topps|bowman|donruss|panini|leaf|hoops|"
            r"fleer|score|press pass|sage|collector|edge|goodwin|upper deck|"
            r"perez-steele"
            r")\b",
            prefix,
            re.I,
        )
    ):
        return title_case_value(prefix)

    if re.search(r"\b(auto(graph)?|signature|signed)\b", title, re.I):
        last_tokens = prefix.split()[-2:]
        fallback_name = clean_player_value(" ".join(last_tokens))
        if fallback_name and 1 <= len(fallback_name.split()) <= 3:
            return fallback_name

    return ""


def extract_player_from_title(item: dict) -> str:
    """
    Re-derive the player directly from the listing title when an older pass
    accidentally kept set/feature text in the player field.
    """
    title = normalize_space(item.get("name"))
    if not title:
        return ""

    if re.search(r"\b(complete|set|lot|whole squad)\b", title, re.I) and not re.search(r"\b(auto|jersey|patch|relic|card)\b", title, re.I):
        return ""

    ted_williams_set = re.search(r"\bFleer\s+Ted\s+Williams\b", title, re.I)
    if ted_williams_set:
        return "Ted Williams"

    # Listings that start with the player name are the cleanest source: keep the
    # prefix before the first card year, then strip feature words from the end.
    prefix = re.split(rf"\b{YEAR_SPAN_PATTERN}\b", title, maxsplit=1)[0].strip(" -|,/")
    prefix = clean_player_value(prefix)
    if prefix and is_plausible_player_value(prefix):
        return prefix

    remainder = re.sub(rf"^{YEAR_SPAN_PATTERN}\s+", "", title)
    remainder = strip_leading_set_phrases(remainder)
    remainder = re.sub(r"^(?:Volume\s+No\.?\s+\d+\s+)", "", remainder, flags=re.I)
    remainder = normalize_space(remainder)
    if not remainder or INVALID_PLAYER_RE.search(remainder):
        return ""

    candidate_tokens: list[str] = []
    for token in remainder.split():
        clean_token = token.strip(" ,;:()[]")
        if not clean_token:
            continue
        if clean_token.startswith("#"):
            break
        if GRADE_COMPANY_RE.fullmatch(clean_token):
            break
        if PLAYER_STOP_TOKEN_RE.fullmatch(clean_token) and len(candidate_tokens) >= 2:
            break
        candidate_tokens.append(clean_token)
        if clean_token.lower().rstrip(".") in {"jr", "sr", "ii", "iii", "iv", "v"}:
            continue
        if len(candidate_tokens) >= 2:
            break

    candidate = clean_player_value(" ".join(candidate_tokens))
    if candidate and is_plausible_player_value(candidate):
        return candidate

    return ""


def extract_condition_candidate(text: str) -> str:
    match = GRADE_COMPANY_RE.search(text)
    if not match:
        return ""

    company = match.group(1).upper().replace("BECKETT", "Beckett")
    tail = text[match.end():]
    grade_match = re.match(
        r"[\s:\-/]*("
        r"[0-9]{1,2}(?:\.[0-9])?"
        r"(?:\s+AUTO\s*[0-9]{1,2}(?:\.[0-9])?)?"
        r"(?:\s+(?:PR|FR|GOOD|VG|VG-EX|EX|EX-MT|NM|NM-MT|MINT|OC|MC|ST|MK))?"
        r"|CERTIFIED\s+AUTHENTIC"
        r"|AUTHENTICATED"
        r"|AUTHENTIC"
        r"|GEM\s+MINT"
        r"|MINT"
        r"|PRISTINE(?:\s+[0-9]{1,2}(?:\.[0-9])?)?"
        r")",
        tail,
        re.I,
    )
    grade_text = normalize_space(grade_match.group(1)) if grade_match else "Authenticated"
    return f"{company} {grade_text}".strip()


def extract_grade_from_text(item: dict) -> str:
    """
    If a title/description/image label clearly includes a grading company, turn
    that into a canonical condition string such as `PSA 9 Mint`.
    """
    metadata, excel_fields = get_metadata(item)
    current = extract_direct_condition(item)

    grader = normalize_space(excel_fields.get("CD:Professional Grader - (ID: 27501)"))
    grade = normalize_space(excel_fields.get("CD:Grade - (ID: 27502)"))
    if grader:
        return f"{grader} {grade}".strip()

    text_candidate = extract_condition_candidate(collect_text(item))
    current_candidate = extract_condition_candidate(current)

    # If the current field already has a clean grade, keep it. Otherwise prefer
    # the richer text-derived candidate so truncated values like `BGS 9 Auto`
    # become `BGS 9 Auto 10`.
    if current_candidate and len(current_candidate) >= len(text_candidate):
        return current_candidate
    if text_candidate:
        return text_candidate
    return current or "Near mint or better"


def has_autograph(item: dict) -> bool:
    metadata, excel_fields = get_metadata(item)
    autograph_flag = normalize_space(excel_fields.get("C:Autographed")).lower()
    text = collect_text(item).lower()
    return autograph_flag == "yes" or bool(
        re.search(r"\b(auto(graph)?|signed|signature|on-card auto|sticker auto)\b", text)
    )


def should_skip_team_inference(item: dict) -> bool:
    """
    Do not infer a pro team for college/pre-draft products when the source never
    stored a reliable school/team field.
    """
    league = normalize_space(item.get("league")).lower()
    if league and league not in {"mlb", "nba", "nfl"}:
        return True
    text = collect_text(item)
    return bool(re.search(r"\b(ote|overtime elite|draft picks|premier draft|leaf draft)\b", text, re.I) or COLLEGE_SET_RE.search(text))


def should_trust_direct_team(item: dict, direct_team: str) -> bool:
    if not direct_team or is_generic_team(direct_team, item):
        return False

    description = str(item.get("description") or "")
    has_structured_team = bool(detail_field("Team", description))
    title = normalize_space(item.get("name"))

    # If the copy explicitly says the card is only "listed in the title" and
    # never carries a real Team field, a previously inferred team should not be
    # treated as authoritative on reruns.
    if (
        should_skip_team_inference(item)
        and re.search(r"\b(listed|highlighted) in the title\b", description, re.I)
        and not has_structured_team
    ):
        return False

    # Large lots and set bundles frequently inherited a stray team from older
    # spreadsheet matching. If that team is not actually mentioned in the title,
    # prefer to re-derive it instead of trusting the stale stored value.
    if (
        re.search(r"\b(lot|set)\b|\(x\d+\)", title, re.I)
        and direct_team.lower() not in title.lower()
        and not has_structured_team
    ):
        return False

    # Legacy leader/all-star cards often cover multiple players and should not
    # inherit a random team from a prior heuristic pass.
    if (
        not has_structured_team
        and re.search(r"\b(imported from the legacy|legacy)\b", description, re.I)
        and re.search(r"\b(leader|leaders|all-star|scoring|rebounding|batting|home run)\b", title, re.I)
    ):
        return False

    return True


def build_known_player_team_maps(records_by_file: dict[str, list[dict]]) -> tuple[list[str], dict[tuple[str, str], Counter], dict[tuple[str, str], dict[str, list[int]]], list[str]]:
    """
    Build two useful lookups:
    - known players for fuzzy title matching
    - player -> team/year history from records that already have a trustworthy team
    """
    known_players: set[str] = set()
    known_teams: set[str] = set()

    for records in records_by_file.values():
        for item in records:
            player = extract_direct_player(item)
            team = extract_direct_team(item)
            if player:
                for part in split_pipe_values(clean_player_value(player)):
                    known_players.add(part)
            if team and not is_generic_team(team, item):
                for part in split_pipe_values(title_case_value(team)):
                    known_teams.add(part)

    # Seed a richer player/team history using both direct player metadata and
    # title-derived guesses when the item already has a trustworthy team.
    player_team_counts: dict[tuple[str, str], Counter] = defaultdict(Counter)
    player_team_years: dict[tuple[str, str], dict[str, list[int]]] = defaultdict(lambda: defaultdict(list))
    ordered_players = sorted(known_players, key=len, reverse=True)

    for records in records_by_file.values():
        for item in records:
            direct_team = extract_direct_team(item)
            if not direct_team or is_generic_team(direct_team, item):
                continue

            team_parts = split_pipe_values(title_case_value(direct_team))
            player_guess = extract_player_guess(item, ordered_players)
            player_parts = split_pipe_values(player_guess)
            if not player_parts:
                continue

            item_year = item.get("year")
            numeric_year = int(item_year) if str(item_year).isdigit() else None

            # Safe mapping cases:
            # - one player -> one team
            # - multiple players -> one shared team
            # - same number of players and teams
            if len(team_parts) == 1:
                assignments = [(player, team_parts[0]) for player in player_parts]
            elif len(player_parts) == len(team_parts):
                assignments = list(zip(player_parts, team_parts))
            else:
                assignments = []

            for player_part, team_part in assignments:
                player_key = (item_sport_key(item), canonical_key(player_part))
                player_team_counts[player_key][team_part] += 1
                if numeric_year:
                    player_team_years[player_key][team_part].append(numeric_year)
                known_players.add(player_part)
                known_teams.add(team_part)

    return (
        sorted(known_players, key=len, reverse=True),
        player_team_counts,
        player_team_years,
        sorted(known_teams, key=len, reverse=True),
    )


def choose_best_team_for_player(player: str, item: dict, item_year: int | None, player_team_counts: dict[tuple[str, str], Counter], player_team_years: dict[tuple[str, str], dict[str, list[int]]]) -> str:
    player_key = (item_sport_key(item), canonical_key(player))
    counts = player_team_counts.get(player_key)
    if not counts:
        return ""

    if item_year is None:
        return counts.most_common(1)[0][0]

    team_options: list[tuple[int, int, str]] = []
    for team, count in counts.items():
        years = player_team_years.get(player_key, {}).get(team, [])
        distance = min((abs(year - item_year) for year in years), default=9999)
        team_options.append((distance, -count, team))

    team_options.sort()
    return team_options[0][2] if team_options else ""


def resolve_team(item: dict, player_value: str, known_teams: list[str], player_team_counts: dict[tuple[str, str], Counter], player_team_years: dict[tuple[str, str], dict[str, list[int]]]) -> str:
    """
    Resolve team in this order:
    1. Trust an explicit non-generic team from the record/metadata.
    2. If the team name already appears in the title/description, use it.
    3. For pro products, infer from the player's known team history near the
       card's year. Otherwise leave blank instead of keeping a set name.
    """
    direct_team = extract_direct_team(item)
    if should_trust_direct_team(item, direct_team):
        return title_case_value(direct_team)

    # Only let the title/description confirm a team. Once a bad team label gets
    # written into the record, reading the team field back here would make that
    # bad inference "self-confirming" on every future run.
    metadata, excel_fields = get_metadata(item)
    haystack = normalize_space(
        " ".join(
            str(value)
            for value in [
                item.get("name"),
                item.get("condition"),
                item.get("legacyImageLabel"),
                item.get("image"),
                excel_fields.get("Title"),
            ]
            if value
        )
    ).lower()
    matched_teams: list[str] = []
    matched_keys: set[str] = set()
    for team in known_teams:
        key = canonical_key(team)
        if key in matched_keys:
            continue
        if team.lower() in haystack:
            matched_teams.append(team)
            matched_keys.add(key)
    if matched_teams:
        return " | ".join(matched_teams[:3])

    if should_skip_team_inference(item):
        return ""

    item_year = item.get("year")
    numeric_year = int(item_year) if str(item_year).isdigit() else None
    inferred_teams: list[str] = []
    seen_teams: set[str] = set()
    for player_part in split_pipe_values(player_value):
        candidate = choose_best_team_for_player(player_part, item, numeric_year, player_team_counts, player_team_years)
        key = canonical_key(candidate)
        if candidate and key not in seen_teams:
            inferred_teams.append(candidate)
            seen_teams.add(key)
    return " | ".join(inferred_teams[:3])


def refresh_description(item: dict, player_value: str, team_value: str, condition_value: str, autograph_value: bool) -> str:
    """
    Keep the most visible structured parts of the description aligned with the
    corrected catalog fields.
    """
    description = str(item.get("description") or "")
    if not description:
        return description

    if re.search(r"\bA strong addition for\b", description, re.I):
        description = re.sub(
            r"^.*?(?=\s*A strong addition for\b)",
            generated_lead_sentence(item, description, player_value, team_value) + " ",
            description,
            count=1,
            flags=re.I,
        )

    if player_value:
        description = re.sub(r"(Player:\s*)([^;\n]+)", rf"\1{player_value}", description, flags=re.I)
    else:
        description = re.sub(r"(?:;\s*)?Player:\s*[^;\n]+", "", description, flags=re.I)
    if team_value:
        description = re.sub(r"(Team:\s*)([^;\n]+)", rf"\1{team_value}", description, flags=re.I)
    else:
        description = re.sub(r"(?:;\s*)?Team:\s*[^;\n]+", "", description, flags=re.I)

    if condition_value:
        condition_label = "Graded" if GRADE_COMPANY_RE.search(condition_value) else "Ungraded"
        description = re.sub(r"(Condition:\s*)([^;\n]+)", rf"\1{condition_label}", description, flags=re.I)

    sport_value = normalize_space(item.get("sport") or item.get("category"))
    league_value = normalize_space(item.get("league"))
    if sport_value:
        description = re.sub(r"(Sport:\s*)([^;\n]+)", rf"\1{sport_value}", description, flags=re.I)
    if league_value:
        description = re.sub(r"(League:\s*)([^;\n]+)", rf"\1{league_value}", description, flags=re.I)
        description = re.sub(
            r"A strong addition for .*?set builders",
            f"A strong addition for {audience_copy(item)}",
            description,
            count=1,
            flags=re.I,
        )

    if autograph_value and re.search(r"Features:\s*([^;\n\.]+)", description, re.I):
        def _append_autograph(match: re.Match) -> str:
            features = normalize_space(match.group(1))
            if re.search(r"\bAutograph\b", features, re.I):
                return match.group(0)
            joiner = " | " if features else ""
            return f"Features: {features}{joiner}Autograph"

        description = re.sub(r"Features:\s*([^;\n\.]+)", _append_autograph, description, flags=re.I)

    return normalize_space(description.replace(" ;", ";"))


def sync_metadata_fields(item: dict, player_value: str, team_value: str) -> None:
    metadata, excel_fields = get_metadata(item)
    if not metadata:
        return
    metadata["playerAthlete"] = player_value
    if excel_fields:
        excel_fields["C:Player/Athlete"] = player_value
        excel_fields["C:Team"] = team_value
    item["metadata"] = metadata


def normalize_sports_records(records_by_file: dict[str, list[dict]]) -> dict[str, int]:
    known_players, player_team_counts, player_team_years, known_teams = build_known_player_team_maps(records_by_file)
    stats = Counter()

    for file_name, records in records_by_file.items():
        for item in records:
            player_value = extract_player_guess(item, known_players)
            team_value = resolve_team(item, player_value, known_teams, player_team_counts, player_team_years)
            player_value = clean_player_value(remove_team_parts_from_player(player_value, team_value))
            condition_value = extract_grade_from_text(item)
            autograph_value = has_autograph(item)

            # Keep sport populated so old imports behave like the richer rows.
            if not normalize_space(item.get("sport")):
                item["sport"] = item.get("category")

            # Prefer an explicit college/draft override first, then fall back to
            # stored metadata when the source already carried a useful league.
            metadata, excel_fields = get_metadata(item)
            resolved_league = resolve_league(item)
            if not resolved_league and normalize_space(excel_fields.get("C:League")):
                resolved_league = normalize_space(excel_fields.get("C:League"))
            if resolved_league and resolved_league != normalize_space(item.get("league")):
                item["league"] = resolved_league
                stats["leagues_updated"] += 1

            original_player = normalize_space(item.get("playerAthlete"))
            original_team = normalize_space(item.get("team"))
            original_condition = normalize_space(item.get("condition"))

            if player_value and player_value != original_player:
                item["playerAthlete"] = player_value
                stats["players_updated"] += 1
            elif original_player and not player_value and not is_plausible_player_value(original_player):
                item["playerAthlete"] = ""
                stats["players_cleared"] += 1

            if team_value != original_team:
                item["team"] = team_value
                if team_value:
                    stats["teams_updated"] += 1
                else:
                    stats["teams_cleared"] += 1

            if condition_value and condition_value != original_condition:
                item["condition"] = condition_value
                if GRADE_COMPANY_RE.search(condition_value) and not GRADE_COMPANY_RE.search(original_condition):
                    stats["new_graded_conditions"] += 1
                else:
                    stats["conditions_updated"] += 1

            if autograph_value:
                stats["autograph_confirmed"] += 1

            item["description"] = refresh_description(item, player_value, team_value, condition_value, autograph_value)
            sync_metadata_fields(item, player_value, team_value)

        stats[f"processed_{file_name}"] = len(records)

    return dict(stats)


def load_featured_rankings() -> dict[int, int]:
    featured_path = ROOT / "products-featured.json"
    if not featured_path.exists():
        return {}

    rankings: dict[int, int] = {}
    for index, item in enumerate(read_json(featured_path), start=1):
        current_id = item.get("id")
        if current_id is None:
            continue
        rankings[int(current_id)] = index
    return rankings


def apply_featured_rankings(records_by_file: dict[str, list[dict]]) -> None:
    rankings = load_featured_rankings()
    if not rankings:
        return

    for records in records_by_file.values():
        for item in records:
            current_id = item.get("id")
            rank = rankings.get(int(current_id)) if current_id is not None else None
            item["isFeatured"] = bool(rank)
            item["sortRank"] = rank or 0


def rebuild_combined_json() -> None:
    for target_name, source_names in COMBINED_FILES.items():
        combined_rows: list[dict] = []
        for source_name in source_names:
            combined_rows.extend(read_json(ROOT / source_name))
        write_json(ROOT / target_name, combined_rows)


def rebuild_featured_json() -> None:
    """
    Keep the featured feed aligned with the latest source records without
    changing its curated order.
    """
    featured_path = ROOT / "products-featured.json"
    if not featured_path.exists():
        return

    featured_rows = read_json(featured_path)
    full_rows = read_json(ROOT / "products.json")
    full_by_id = {int(item["id"]): item for item in full_rows if "id" in item}

    refreshed_rows = []
    for item in featured_rows:
        current_id = item.get("id")
        replacement = full_by_id.get(int(current_id)) if current_id is not None else None
        refreshed_rows.append(replacement or item)

    write_json(featured_path, refreshed_rows)


def rebuild_preloaded_bundles() -> None:
    for source_name, target_name in PRELOADED_TARGETS.items():
        payload = read_json(ROOT / source_name)
        bundle = (
            f'window.DJ_PRELOADED_SOURCE = "{source_name}";\n'
            f"window.DJ_PRELOADED_PRODUCTS = {json.dumps(payload, ensure_ascii=False, separators=(',', ':'))};\n"
        )
        (ROOT / target_name).write_text(bundle, encoding="utf-8")


def count_nonblank_generic_teams(records_by_file: dict[str, list[dict]]) -> dict[str, int]:
    counts = {}
    for file_name, records in records_by_file.items():
        counts[file_name] = sum(
            1
            for item in records
            if normalize_space(item.get("team")) and is_generic_team(item.get("team"), item)
        )
    return counts


def main() -> None:
    sports_records = {file_name: read_json(ROOT / file_name) for file_name in SPORT_FILES}
    before_counts = count_nonblank_generic_teams(sports_records)

    stats = normalize_sports_records(sports_records)
    apply_featured_rankings(sports_records)

    for file_name, records in sports_records.items():
        write_json(ROOT / file_name, records)

    rebuild_combined_json()
    rebuild_featured_json()
    rebuild_preloaded_bundles()

    refreshed_records = {file_name: read_json(ROOT / file_name) for file_name in SPORT_FILES}
    after_counts = count_nonblank_generic_teams(refreshed_records)

    print("Normalization complete.")
    for key in sorted(stats):
        print(f"  {key}: {stats[key]}")
    for file_name in SPORT_FILES:
        print(
            f"  generic_team_labels[{file_name}]: "
            f"{before_counts[file_name]} -> {after_counts[file_name]}"
        )


if __name__ == "__main__":
    main()
