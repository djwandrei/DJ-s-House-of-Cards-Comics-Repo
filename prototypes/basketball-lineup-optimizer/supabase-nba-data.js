// The app is deployed as static ES modules; retain the release revision here
// as well so the data adapter and normalization rules update together.
import { normalizeDataset } from "./player-data.js?v=__LINEUP_LAB_ASSET_VERSION__";

const MINIMUM_SUPPORTED_SEASON = 1980;
// This version is shared with player-projection.js by contract.  Keep the
// adapter-side literal local so the browser data module remains independent of
// the optimizer and can be reused by diagnostics without importing solver
// code.  A version mismatch is rejected by the optimizer rather than silently
// treating an old payload as responsibility evidence.
const RESPONSIBILITY_EVIDENCE_VERSION = "scout-responsibility-evidence-v1";
const TRUSTED_MEDIA_HOSTS = new Set([
  "www.basketball-reference.com",
  "cdn.ssref.net",
  "iili.io",
]);

function requireSeasonEndYear(value) {
  const seasonEndYear = Number(value);
  if (!Number.isInteger(seasonEndYear) || seasonEndYear < MINIMUM_SUPPORTED_SEASON || seasonEndYear > 2200) {
    throw new Error(`Season must be a whole ending year from ${MINIMUM_SUPPORTED_SEASON} onward.`);
  }
  return seasonEndYear;
}

function requireTeamCode(value) {
  const teamCode = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,8}$/.test(teamCode)) {
    throw new Error("A valid NBA team code is required.");
  }
  return teamCode;
}

function requireSeasonPhase(value) {
  const seasonPhase = String(value ?? "regular").trim().toLowerCase();
  if (!['regular', 'playoffs'].includes(seasonPhase)) {
    throw new Error("Season phase must be regular or playoffs.");
  }
  return seasonPhase;
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required in the saved player row.`);
  return text;
}

function requireNonNegativeNumber(value, label, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} must be a non-negative${integer ? " whole" : ""} number in the saved player row.`);
  }
  return number;
}

function optionalNonNegativeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// Advanced Basketball Reference metrics such as BPM can legitimately be
// negative, so they need a separate optional-number helper from the raw
// box-score total helper above. Returning `null` keeps missing provider values
// distinct from a genuine zero in the fan-analysis layer.
function optionalFiniteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeMetricObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, metric]) => [String(key), optionalFiniteNumber(metric)])
      .filter(([, metric]) => metric !== null),
  );
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize the optional player-season evidence contract.
 *
 * The selected player-pool row remains a real team stint because that answers
 * "who played for this team?". Reliability is a different question. A traded
 * player's available season across teams is the better sample for judging
 * whether his rate is established. The shared reader sums the imported real
 * team rows, preserving missing fields instead of relying on SQL SUM's
 * null-skipping behavior. This does not certify complete source coverage.
 *
 * Missing optional columns stay missing rather than becoming zero. That lets
 * the optimizer fall back metric by metric without treating an incomplete
 * future import as evidence that the player produced nothing.
 */
function seasonEvidenceForRow(row) {
  if (!isPlainObject(row)) return null;
  const aliases = {
    games: ["games_played", "games"],
    minutes: ["minutes_played", "minutes"],
    fieldGoalsMade: ["field_goals_made", "fieldGoalsMade"],
    fieldGoalsAttempted: ["field_goals_attempted", "fieldGoalsAttempted"],
    threePointFieldGoalsMade: ["three_point_field_goals_made", "threePointFieldGoalsMade"],
    threePointFieldGoalsAttempted: ["three_point_field_goals_attempted", "threePointFieldGoalsAttempted"],
    freeThrowsMade: ["free_throws_made", "freeThrowsMade"],
    freeThrowsAttempted: ["free_throws_attempted", "freeThrowsAttempted"],
    totalRebounds: ["total_rebounds", "totalRebounds", "rebounds"],
    assists: ["assists"],
    steals: ["steals"],
    blocks: ["blocks"],
    turnovers: ["turnovers"],
    points: ["points"],
  };
  const totals = {};
  for (const [target, candidates] of Object.entries(aliases)) {
    // An explicitly missing canonical field must not be rescued by a stale
    // alias. Counts accept numeric strings, but never boolean/blank coercion.
    const source = candidates.find((key) => Object.hasOwn(row, key));
    if (!source) continue;
    const raw = row[source];
    if (typeof raw !== "number" && (typeof raw !== "string" || !/^\d+$/.test(raw))) continue;
    const value = Number(raw);
    if (Number.isSafeInteger(value) && value >= 0) totals[target] = value;
  }

  // A season-wide claim needs both an appearance count and total minutes.
  // Without those anchors, a partial payload cannot safely replace the
  // selected-team rate or establish a season-level role size.
  if (!(totals.games > 0) || !(totals.minutes > 0)) return null;

  const advanced = safeMetricObject(
    isPlainObject(row.season_advanced_metrics)
      ? row.season_advanced_metrics
      : row.advanced_metrics,
  );
  const playerPossessions = optionalNonNegativeNumber(
    row.player_possessions ?? row.estimated_player_possessions ?? row.possessions,
    null,
  );
  const playerPossessionsPerGame = optionalNonNegativeNumber(
    row.player_possessions_per_game ?? row.estimated_player_possessions_per_game ?? row.possessions_per_game,
    null,
  );
  return {
    totals,
    advanced,
    teamStintCount: optionalNonNegativeNumber(row.team_stint_count, null),
    playerPossessions,
    playerPossessionsPerGame,
    source: {
      scope: "season-wide",
      method: "aggregate of imported real-team rows for this player, season, and phase",
      // Neither the legacy aggregate nor the read-only reader independently
      // reconciles every source game/team. Keep that limitation machine-readable.
      completeness: "imported-rows-only",
      ...(row.evidence_contract === "imported-team-totals-v1"
        ? { missingFieldPolicy: "unavailable-if-any-contributor-missing" }
        : {}),
      ...(typeof row.evidence_completeness === "string" && row.evidence_completeness.trim()
        ? { completeness: row.evidence_completeness.trim() }
        : {}),
      ...(typeof row.evidence_source_revision === "string" && row.evidence_source_revision.trim()
        ? { sourceRevision: row.evidence_source_revision.trim() }
        : {}),
      ...(typeof row.evidence_contract === "string" && row.evidence_contract.trim()
        && row.evidence_contract !== "imported-team-totals-v1"
        ? { evidenceContract: row.evidence_contract.trim() }
        : {}),
    },
  };
}

function integerCount(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Build the narrow responsibility contract consumed by the optimizer.
 *
 * Possession-ending involvement is intentionally derived only when the
 * season-wide row contains a complete, matching FGA + FTA + turnover count.
 * A season total can hide a missing trade-team stat because SQL SUM skips
 * nulls; `seasonEvidenceForRow()` preserves those nulls, and this helper
 * refuses to turn the partial numerator into a confident role prior.  The
 * result is descriptive evidence—not a usage percentage, touch count, or
 * causal prediction of what happens when a coach changes a player's role.
 */
export function responsibilityEvidenceForSeason(seasonEvidence) {
  if (!isPlainObject(seasonEvidence) || !isPlainObject(seasonEvidence.totals)) return null;
  const totals = seasonEvidence.totals;
  const readTotal = (...keys) => {
    const key = keys.find(candidate => Object.hasOwn(totals, candidate));
    return key === undefined ? null : integerCount(totals[key]);
  };
  const games = readTotal("games", "gamesPlayed", "games_played");
  const minutes = readTotal("minutes", "minutesPlayed", "minutes_played");
  if (!(games > 0) || !(minutes > 0)) return null;

  const fieldGoalAttempts = readTotal("fieldGoalsAttempted", "field_goal_attempts", "field_goals_attempted");
  const freeThrowAttempts = readTotal("freeThrowsAttempted", "free_throw_attempts", "free_throws_attempted");
  const turnovers = readTotal("turnovers", "turnoverCount", "turnover_count");
  const per36 = value => Number.isFinite(value) ? (value * 36) / minutes : null;
  const source = seasonEvidence.source || {};
  // Do not fill a missing component with zero. Zero is accepted only when the
  // source explicitly supplied an actual zero count. A separately certified
  // Scout advanced value is the sole fallback for a row whose raw component
  // counts are incomplete; the ordinary imported-rows-only view cannot use
  // this branch because its SQL aggregation may hide a trade-team gap.
  let offensiveInvolvement;
  let derivation = "season-wide complete box counts: FGA + 0.44 × FTA + TOV";
  if (fieldGoalAttempts !== null && freeThrowAttempts !== null && turnovers !== null) {
    offensiveInvolvement = fieldGoalAttempts + (0.44 * freeThrowAttempts) + turnovers;
  } else {
    const advanced = seasonEvidence.advanced || {};
    const advancedValue = [
      advanced.offensiveInvolvementPer36,
      advanced.offensive_involvement_per_36,
      advanced.possessionEndingInvolvementPer36,
      advanced.possession_ending_involvement_per_36,
    ].map(value => optionalNonNegativeNumber(value, null)).find(value => value !== null);
    const certifiedAdvanced = /^scout[-_]/i.test(String(source.completeness || ""))
      || String(source.evidenceContract || "").toLowerCase().includes("scout");
    if (!certifiedAdvanced || advancedValue === undefined) return null;
    offensiveInvolvement = advancedValue * minutes / 36;
    derivation = "independently certified Scout offensive-involvement rate";
  }
  return {
    version: RESPONSIBILITY_EVIDENCE_VERSION,
    scope: "season-wide",
    games,
    verifiedGames: games,
    minutes,
    officialMinutes: minutes,
    minutesPerGame: minutes / games,
    offensiveInvolvement,
    offensiveInvolvementPer36: per36(offensiveInvolvement),
    fieldGoalAttempts,
    fieldGoalAttemptsPer36: per36(fieldGoalAttempts),
    freeThrowAttempts,
    freeThrowAttemptsPer36: per36(freeThrowAttempts),
    turnovers,
    turnoversPer36: per36(turnovers),
    assists: readTotal("assists", "assistCount", "assist_count"),
    assistsPer36: per36(readTotal("assists", "assistCount", "assist_count")),
    sourceRevision: typeof source.sourceRevision === "string" ? source.sourceRevision : null,
    completeness: typeof source.completeness === "string"
      ? source.completeness
      : "counts-complete-within-imported-rows",
    method: derivation,
  };
}

/**
 * Build one strict evidence row per player. Extra player rows are ignored so a
 * future batched endpoint may safely return a superset, but duplicate or
 * cross-season rows fail closed instead of silently attaching the wrong sample.
 */
function seasonEvidenceByPlayerId(rows, { playerIds, season, seasonPhase }) {
  const evidence = new Map();
  if (!Array.isArray(rows)) return evidence;
  const allowedIds = new Set(playerIds.map((id) => String(id)));
  const seenIds = new Set();
  for (const row of rows) {
    if (!isPlainObject(row)) throw new Error("Season-wide evidence rows must be objects.");
    const playerId = requireText(row.player_id ?? row.playerId, "Season evidence player ID");
    if (!allowedIds.has(playerId)) continue;
    const rowSeason = requireSeasonEndYear(row.season_end_year ?? row.seasonEndYear);
    const phaseValue = row.season_phase ?? row.seasonPhase;
    if (typeof phaseValue !== "string" || !phaseValue.trim()) {
      throw new Error("Season-wide evidence must identify its season phase explicitly.");
    }
    const rowPhase = requireSeasonPhase(phaseValue);
    if (rowSeason !== season || rowPhase !== seasonPhase) {
      throw new Error(`Season-wide evidence for ${playerId} does not match the selected season and phase.`);
    }
    if (seenIds.has(playerId)) {
      throw new Error(`Duplicate season-wide evidence was returned for ${playerId}.`);
    }
    seenIds.add(playerId);
    const normalized = seasonEvidenceForRow(row);
    if (normalized) evidence.set(playerId, normalized);
  }
  return evidence;
}

function safeHttpsUrl(value) {
  // The public database view exposes only rights-confirmed media, but retain
  // this browser-side allowlist as a second boundary before a URL reaches an
  // image element. It protects the tool if a future import record is malformed.
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" && TRUSTED_MEDIA_HOSTS.has(url.hostname)
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function divideByGames(value, games) {
  return optionalNonNegativeNumber(value) / games;
}

function percentage(made, attempted) {
  const attempts = optionalNonNegativeNumber(attempted);
  if (attempts === 0) return 0;
  return optionalNonNegativeNumber(made) / attempts;
}

function effectiveFieldGoalPercentage(fieldGoalsMade, threePointFieldGoalsMade, fieldGoalsAttempted) {
  const attempts = optionalNonNegativeNumber(fieldGoalsAttempted);
  if (attempts === 0) return 0;
  return (optionalNonNegativeNumber(fieldGoalsMade) + (0.5 * optionalNonNegativeNumber(threePointFieldGoalsMade))) / attempts;
}

function phaseLabel(seasonPhase) {
  return seasonPhase === "playoffs" ? "Playoffs" : "Regular season";
}

function sourcePositionCodes(value) {
  // Supabase returns `career_profile_positions` as an array, while the season
  // table's `listed_position` is text. Accept both shapes at this boundary so
  // one malformed optional profile field cannot make a valid team stint fail.
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => String(entry ?? "")
    .toUpperCase()
    .split(/[\s/,|;+\-]+/)
    .filter(Boolean)))];
}

function normalizedRotationPositions(value) {
  // Rotation previews use the same three broad position buckets as the
  // optimizer. Keeping every eligible bucket matters for hybrid listings such
  // as PF-C: that player can be shown as both a forward and a center rather
  // than being reduced to whichever role happened to appear first.
  const positionMap = {
    G: "G",
    PG: "G",
    SG: "G",
    F: "F",
    SF: "F",
    PF: "F",
    C: "C",
  };
  const positions = sourcePositionCodes(value)
    .map((token) => positionMap[token])
    .filter(Boolean);
  return [...new Set(positions)];
}

function positionEvidenceForRow(row) {
  // The profile's career positions are verified player-level eligibility. The
  // season table's `Pos` is still retained separately because it is the only
  // source in this model that describes the selected historical stint.
  const seasonListedCodes = sourcePositionCodes(row.listed_position || row.player_primary_position);
  const careerProfileCodes = sourcePositionCodes(row.career_profile_positions);
  const eligibleCodes = [...new Set([...seasonListedCodes, ...careerProfileCodes])];
  return {
    seasonListed: normalizedRotationPositions(seasonListedCodes),
    careerProfile: normalizedRotationPositions(careerProfileCodes),
    eligible: normalizedRotationPositions(eligibleCodes),
    sourceText: String(row.career_profile_position_text ?? "").trim(),
    sourceUrl: safeHttpsUrl(row.career_profile_source_url),
    usesCareerProfile: careerProfileCodes.length > 0,
  };
}

function eligiblePositionTextForRow(row) {
  const evidence = positionEvidenceForRow(row);
  if (!evidence.eligible.length) return "";
  // `normalizeDataset()` owns conversion from exact source labels (PG, PF,
  // etc.) to broad G/F/C buckets. Pass all verified labels through unchanged
  // so an alternate position reaches the exact constraint solver.
  const seasonListedCodes = sourcePositionCodes(row.listed_position || row.player_primary_position);
  const careerProfileCodes = sourcePositionCodes(row.career_profile_positions);
  return [...new Set([...seasonListedCodes, ...careerProfileCodes])].join("/");
}

function defaultBasketballReferenceTotalsUrl(seasonEndYear, seasonPhase) {
  const leagueYear = requireSeasonEndYear(seasonEndYear);
  return seasonPhase === "playoffs"
    ? `https://www.basketball-reference.com/playoffs/NBA_${leagueYear}_totals.html`
    : `https://www.basketball-reference.com/leagues/NBA_${leagueYear}_totals.html`;
}

function currentSnapshotDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Format NBA ending-year values without relying on a current-season guess. */
export function nbaSeasonLabel(value) {
  const seasonEndYear = requireSeasonEndYear(value);
  return `${seasonEndYear - 1}-${String(seasonEndYear).slice(-2)}`;
}

/**
 * Convert one saved Basketball Reference team stint into the optimizer's
 * source-neutral per-game player shape. Missing starts are intentionally
 * represented as zero because older source tables do not always publish them.
 */
export function mapSupabaseNbaPlayer(row, options = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("A saved player row is required.");
  }
  const team = requireTeamCode(options.team ?? row.team_code);
  const season = requireSeasonEndYear(options.season ?? row.season_end_year);
  const seasonPhase = requireSeasonPhase(options.seasonPhase ?? row.season_phase);
  const rowTeam = requireTeamCode(row.team_code);
  const rowSeason = requireSeasonEndYear(row.season_end_year);
  const rowPhase = requireSeasonPhase(row.season_phase);
  if (rowTeam !== team) throw new Error(`Received ${rowTeam} while loading ${team}.`);
  if (rowSeason !== season) throw new Error(`Received season ${rowSeason} while loading ${season}.`);
  if (rowPhase !== seasonPhase) throw new Error(`Received ${rowPhase} stats while loading ${seasonPhase}.`);

  const games = requireNonNegativeNumber(row.games_played, "Games played", { integer: true });
  if (games < 1) throw new Error("Games played must be at least one for an optimizer player.");
  const starts = optionalNonNegativeNumber(row.games_started, 0);
  if (!Number.isInteger(starts) || starts > games) {
    throw new Error("Games started must be a whole number no greater than games played.");
  }

  const fieldGoalsMade = optionalNonNegativeNumber(row.field_goals_made);
  const fieldGoalsAttempted = optionalNonNegativeNumber(row.field_goals_attempted);
  const threePointFieldGoalsMade = optionalNonNegativeNumber(row.three_point_field_goals_made);
  const threePointFieldGoalsAttempted = optionalNonNegativeNumber(row.three_point_field_goals_attempted);
  const freeThrowsMade = optionalNonNegativeNumber(row.free_throws_made);
  const freeThrowsAttempted = optionalNonNegativeNumber(row.free_throws_attempted);

  return {
    id: requireText(row.player_id, "Player ID"),
    name: requireText(row.player_name, "Player name"),
    team,
    positions: requireText(eligiblePositionTextForRow(row), "Player position"),
    age: requireNonNegativeNumber(row.player_age, "Player age", { integer: true }),
    games,
    starts,
    minutes: divideByGames(row.minutes_played, games),
    fgPct: percentage(fieldGoalsMade, fieldGoalsAttempted),
    threePct: percentage(threePointFieldGoalsMade, threePointFieldGoalsAttempted),
    efgPct: effectiveFieldGoalPercentage(fieldGoalsMade, threePointFieldGoalsMade, fieldGoalsAttempted),
    ftPct: percentage(freeThrowsMade, freeThrowsAttempted),
    rebounds: divideByGames(row.total_rebounds, games),
    assists: divideByGames(row.assists, games),
    steals: divideByGames(row.steals, games),
    blocks: divideByGames(row.blocks, games),
    turnovers: divideByGames(row.turnovers, games),
    points: divideByGames(row.points, games),
    headshotUrl: safeHttpsUrl(row.player_headshot_url),
  };
}

/**
 * Keep fan-analysis metadata separate from the intentionally narrow optimizer
 * schema. `normalizeDataset()` validates the canonical per-game player shape
 * and deliberately strips unknown columns, so layering this object afterward
 * prevents a reporting feature from quietly changing exact-solver inputs.
 */
function fanAnalyticsForRow(row, { team, season, seasonPhase, sourceUrl, seasonEvidence = null }) {
  const totals = {
    // Preserve provider gaps in the team fallback too. The all-team reader is
    // not enough if this adapter later turns a missing contributing stat into
    // an observed zero. The visible per-game schema remains a separate view.
    minutes: optionalNonNegativeNumber(row.minutes_played, null),
    fieldGoalsMade: optionalNonNegativeNumber(row.field_goals_made, null),
    fieldGoalsAttempted: optionalNonNegativeNumber(row.field_goals_attempted, null),
    threePointFieldGoalsMade: optionalNonNegativeNumber(row.three_point_field_goals_made, null),
    threePointFieldGoalsAttempted: optionalNonNegativeNumber(row.three_point_field_goals_attempted, null),
    freeThrowsMade: optionalNonNegativeNumber(row.free_throws_made, null),
    freeThrowsAttempted: optionalNonNegativeNumber(row.free_throws_attempted, null),
    offensiveRebounds: optionalNonNegativeNumber(row.offensive_rebounds, null),
    defensiveRebounds: optionalNonNegativeNumber(row.defensive_rebounds, null),
    totalRebounds: optionalNonNegativeNumber(row.total_rebounds, null),
    assists: optionalNonNegativeNumber(row.assists, null),
    steals: optionalNonNegativeNumber(row.steals, null),
    blocks: optionalNonNegativeNumber(row.blocks, null),
    turnovers: optionalNonNegativeNumber(row.turnovers, null),
    personalFouls: optionalNonNegativeNumber(row.personal_fouls, null),
    points: optionalNonNegativeNumber(row.points, null),
  };
  const leaguePer36 = {
    // These aggregates and the team-level denominator are non-negative by
    // definition. Treat a malformed optional browser payload as unavailable,
    // rather than letting it create an impossible rate or possession estimate.
    // (Advanced metrics below intentionally retain signed values such as BPM.)
    points: optionalNonNegativeNumber(row.league_points_per_36, null),
    rebounds: optionalNonNegativeNumber(row.league_rebounds_per_36, null),
    assists: optionalNonNegativeNumber(row.league_assists_per_36, null),
    steals: optionalNonNegativeNumber(row.league_steals_per_36, null),
    blocks: optionalNonNegativeNumber(row.league_blocks_per_36, null),
    turnovers: optionalNonNegativeNumber(row.league_turnovers_per_36, null),
    efgPct: optionalNonNegativeNumber(row.league_efg_pct, null),
    threePct: optionalNonNegativeNumber(row.league_three_pct, null),
  };

  const teamStintAdvanced = safeMetricObject(row.advanced_metrics);
  // Keep this contract separate from `seasonEvidence`: the latter is a
  // provenance envelope whose shape is consumed by older page/report code.
  // Adding a sibling field lets the optimizer opt into the stricter complete
  // count check without changing the meaning of the visible team stint or
  // breaking consumers that display the original envelope verbatim.
  const responsibilityEvidence = responsibilityEvidenceForSeason(seasonEvidence);
  return {
    totals,
    // When present, season-wide advanced values override the selected-team
    // version for model evidence. The raw team-stint values remain available
    // above in `totals` for clear on-page context and source auditing.
    advanced: {
      ...teamStintAdvanced,
      ...(seasonEvidence?.advanced || {}),
    },
    ...(seasonEvidence ? {
      seasonTotals: seasonEvidence.totals,
      seasonAdvanced: seasonEvidence.advanced,
      seasonEvidence: {
        ...seasonEvidence.source,
        teamStintCount: seasonEvidence.teamStintCount,
        playerPossessions: seasonEvidence.playerPossessions,
        playerPossessionsPerGame: seasonEvidence.playerPossessionsPerGame,
        hasReportedPossessions:
          seasonEvidence.playerPossessions !== null
          || seasonEvidence.playerPossessionsPerGame !== null,
      },
    } : {}),
    ...(responsibilityEvidence ? { responsibilityEvidence } : {}),
    teamTotalMinutes: optionalNonNegativeNumber(row.team_total_minutes, null),
    estimatedTeamPossessions: optionalNonNegativeNumber(row.estimated_team_possessions, null),
    leaguePer36,
    postseasonAvailable: row.postseason_available === true,
    source: {
      season: nbaSeasonLabel(season),
      team,
      phase: seasonPhase,
      url: sourceUrl,
      // The view's league benchmarks aggregate every non-TOT NBA team stint
      // for this exact ending season and phase. Mark that scope explicitly so
      // fan analytics never treats a single roster as an era-wide baseline.
      isLeagueWide: true,
      leagueLabel: `NBA ${nbaSeasonLabel(season)} ${phaseLabel(seasonPhase)} per-36 baseline`,
      leagueScope: "all imported NBA team stints in the same season and phase, weighted by player minutes",
    },
  };
}

/**
 * Summarize saved team-stint totals for an opponent-scouting snapshot.
 *
 * The database view contains player totals rather than a separate team-total
 * row. We reconstruct the shared schedule from aggregate player-minutes (240
 * per regulation game), retain the largest player games-played value as a
 * lower bound, and cap known regular-season formats. We then divide the
 * roster's counting totals by that estimate. Shooting percentages are
 * deliberately recomputed from aggregate makes and attempts; averaging player
 * percentages would give a low-volume shooter the same influence as a
 * high-volume shooter.
 *
 * The function is pure: it does not access Supabase, mutate a source row, or
 * depend on today's date. That makes the historical summary deterministic and
 * straightforward to unit test before it is rendered by the app.
 */
export function summarizeSupabaseNbaTeamRows(rows) {
  if (!Array.isArray(rows)) throw new Error("The saved player pool must be an array.");

  // Empty input is useful to callers performing an availability check. The
  // normal dataset loader still rejects an empty remote result before a scout
  // can be presented to a visitor.
  if (rows.length === 0) {
    return {
      teamGames: 0,
      teamAverages: {
        points: 0,
        rebounds: 0,
        assists: 0,
        steals: 0,
        blocks: 0,
        turnovers: 0,
        efgPct: 0,
        threePct: 0,
      },
      rotation: [],
    };
  }

  const preparedRows = rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Each saved player row must be an object.");
    }
    const games = requireNonNegativeNumber(row.games_played, "Games played", { integer: true });
    const starts = optionalNonNegativeNumber(row.games_started, 0);
    if (!Number.isInteger(starts) || starts > games) {
      throw new Error("Games started must be a whole number no greater than games played.");
    }
    return { row, games, starts };
  });
  const maximumPlayerGames = Math.max(...preparedRows.map(({ games }) => games));
  if (maximumPlayerGames < 1) throw new Error("At least one saved player must have played a game.");

  const totals = preparedRows.reduce((summary, { row }) => {
    summary.points += optionalNonNegativeNumber(row.points);
    summary.rebounds += optionalNonNegativeNumber(row.total_rebounds);
    summary.assists += optionalNonNegativeNumber(row.assists);
    summary.steals += optionalNonNegativeNumber(row.steals);
    summary.blocks += optionalNonNegativeNumber(row.blocks);
    summary.turnovers += optionalNonNegativeNumber(row.turnovers);
    summary.minutes += optionalNonNegativeNumber(row.minutes_played);
    summary.fieldGoalsMade += optionalNonNegativeNumber(row.field_goals_made);
    summary.fieldGoalsAttempted += optionalNonNegativeNumber(row.field_goals_attempted);
    summary.threePointFieldGoalsMade += optionalNonNegativeNumber(row.three_point_field_goals_made);
    summary.threePointFieldGoalsAttempted += optionalNonNegativeNumber(row.three_point_field_goals_attempted);
    return summary;
  }, {
    points: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
    minutes: 0,
    fieldGoalsMade: 0,
    fieldGoalsAttempted: 0,
    threePointFieldGoalsMade: 0,
    threePointFieldGoalsAttempted: 0,
  });

  // Maximum player GP alone undercounts teams whose most durable player missed
  // a few games (for example, every player topping out at 78 in an 82-game
  // season). Summed player minutes reconstruct the shared team schedule much
  // more closely: a regulation game contains 240 player-minutes. Use the floor
  // so ordinary overtime does not invent another game, retain maximum GP as a
  // lower bound, and cap known regular-season formats without inflating an
  // incomplete or unusually shortened team schedule.
  const minuteDerivedGames = Math.floor(totals.minutes / 240);
  const rowSeason = Number(preparedRows[0]?.row?.season_end_year);
  const rowPhase = String(preparedRows[0]?.row?.season_phase || "regular").toLowerCase();
  const shortenedRegularSeasonCaps = new Map([[1999, 50], [2012, 66], [2021, 72]]);
  const regularSeasonCap = shortenedRegularSeasonCaps.get(rowSeason) || 82;
  const estimatedGames = Math.max(maximumPlayerGames, minuteDerivedGames);
  const teamGames = rowPhase === "regular" ? Math.min(estimatedGames, regularSeasonCap) : estimatedGames;

  const teamAverages = {
    points: totals.points / teamGames,
    rebounds: totals.rebounds / teamGames,
    assists: totals.assists / teamGames,
    steals: totals.steals / teamGames,
    blocks: totals.blocks / teamGames,
    turnovers: totals.turnovers / teamGames,
    efgPct: effectiveFieldGoalPercentage(
      totals.fieldGoalsMade,
      totals.threePointFieldGoalsMade,
      totals.fieldGoalsAttempted,
    ),
    threePct: percentage(totals.threePointFieldGoalsMade, totals.threePointFieldGoalsAttempted),
  };

  // Dividing every player's total minutes by the same team-games denominator
  // measures the portion of the team's season that player actually occupied.
  // Sorting on that value yields a more representative historical rotation
  // than player minutes per appearance, which can overstate short stints.
  const rotation = preparedRows
    .map(({ row, games, starts }) => ({
      id: requireText(row.player_id, "Player ID"),
      name: requireText(row.player_name, "Player name"),
      // This preview describes the selected historical team stint, so it
      // deliberately displays the season table's listed role. Career-profile
      // flexibility is available to the optimizer, but presenting it here as
      // if it were a season-specific assignment would overstate what the
      // public historical data can prove.
      positions: positionEvidenceForRow(row).seasonListed,
      headshotUrl: safeHttpsUrl(row.player_headshot_url),
      games,
      starts,
      minutesPerTeamGame: optionalNonNegativeNumber(row.minutes_played) / teamGames,
    }))
    .sort((left, right) => (
      (right.minutesPerTeamGame - left.minutesPerTeamGame)
      || (right.starts - left.starts)
      || (right.games - left.games)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    ))
    .slice(0, 9);

  return { teamGames, teamAverages, rotation };
}

/**
 * Build a valid, single-team player dataset from the narrow public Supabase
 * view. The adapter keeps player stints distinct and only exposes confirmed
 * external media URLs supplied by the database.
 */
export function createSupabaseNbaTeamDataset(rows, options = {}) {
  if (!Array.isArray(rows)) throw new Error("The saved player pool must be an array.");
  const team = requireTeamCode(options.team);
  const season = requireSeasonEndYear(options.season);
  const seasonPhase = requireSeasonPhase(options.seasonPhase);
  const teamName = String(options.teamName || rows[0]?.team_name || team).trim() || team;
  const sourceUrl = safeHttpsUrl(options.sourceUrl || rows.find((row) => safeHttpsUrl(row?.source_url))?.source_url)
    || defaultBasketballReferenceTotalsUrl(season, seasonPhase);
  const teamLogoUrl = safeHttpsUrl(options.teamLogoUrl || rows.find((row) => safeHttpsUrl(row?.team_logo_url))?.team_logo_url);
  const teamSummary = summarizeSupabaseNbaTeamRows(rows);
  const playerIds = rows.map((row) => requireText(row.player_id, "Player ID"));
  const seasonEvidence = seasonEvidenceByPlayerId(options.seasonEvidenceRows || [], {
    playerIds,
    season,
    seasonPhase,
  });
  const source = {
    label: `${teamName} ${nbaSeasonLabel(season)} ${phaseLabel(seasonPhase)} player pool`,
    provider: "Basketball Reference via DJHC database",
    url: sourceUrl,
    snapshotDate: options.snapshotDate || currentSnapshotDate(),
    season: nbaSeasonLabel(season),
    team,
    teamName,
    seasonPhase,
    teamLogoUrl,
    teamGames: teamSummary.teamGames,
    teamGamesMethod: "aggregate player minutes with maximum player games as a lower bound",
    teamAverages: teamSummary.teamAverages,
    rotation: teamSummary.rotation,
    analytics: {
      per100Method: "Estimated team offensive possessions = FGA + 0.44 × FTA − offensive rebounds + turnovers. Individual exposure is estimated from that team's possession total and the player's share of team minutes.",
      leagueBaselineMethod: "Same-season, same-phase NBA team-stint totals weighted by player minutes and expressed per 36 minutes. It is a historical context index, not an all-in-one player rating.",
      seasonEvidencePlayers: seasonEvidence.size,
      seasonEvidenceStatus: options.seasonEvidenceStatus
        || (seasonEvidence.size > 0 ? "available" : "not-supplied"),
      seasonEvidenceMethod: "Matching player-season counts across imported real-team rows; complete source coverage is not independently verified. Missing observations use only a disclosed own-season baseline prior when available; missing mixed-source baselines cannot be borrowed. No synthetic sample is inserted. Games with a particular team never become a minute target or cap.",
      responsibilityEvidencePlayers: [...seasonEvidence.values()]
        .filter(evidence => responsibilityEvidenceForSeason(evidence) !== null).length,
      responsibilityEvidenceMethod: "A role prior is available only when the all-team season row has complete FGA, FTA, turnover, games, and minutes counts. Partial trade-team rows remain unavailable rather than being treated as zero.",
    },
    note: "Visible per-game stats describe this team only. When available, the rotation model uses matching counts across the player's imported teams for the same season and phase; these do not set minute limits.",
  };
  const rawPlayers = rows.map((row) => mapSupabaseNbaPlayer(row, { team, season, seasonPhase }));
  const dataset = normalizeDataset({ schemaVersion: 1, source, players: rawPlayers }, {
    strict: true,
    warnOnGeneratedId: false,
  });

  const headshots = new Map(rawPlayers.map((player) => [player.id, player.headshotUrl]));
  const analyticsById = new Map(rows.map((row) => {
    const id = requireText(row.player_id, "Player ID");
    return [id, fanAnalyticsForRow(row, {
      team,
      season,
      seasonPhase,
      sourceUrl,
      seasonEvidence: seasonEvidence.get(id) || null,
    })];
  }));
  const positionEvidenceById = new Map(rows.map((row) => {
    const id = requireText(row.player_id, "Player ID");
    return [id, positionEvidenceForRow(row)];
  }));
  dataset.players = dataset.players.map((player) => ({
    ...player,
    headshotUrl: headshots.get(player.id) || "",
    analytics: analyticsById.get(player.id) || null,
    // Keep solver-facing eligibility (`positions`) narrow and normalized, then
    // retain source provenance separately for UI copy and the automatic
    // historical position-minute estimate.
    positionEvidence: positionEvidenceById.get(player.id) || null,
  }));
  return dataset;
}

function getRemoteCatalog() {
  const catalog = globalThis.window?.DJ?.remoteCatalog || globalThis.DJ?.remoteCatalog;
  if (!catalog || typeof catalog !== "object") {
    throw new Error("The site data connection is not available. Refresh the page and try again.");
  }
  return catalog;
}

/**
 * Fetch only a bounded, administrator-authorized Scout projection. The shared
 * site adapter owns Auth and attaches its session; this module never sees a
 * service key or accesses the private archive. Do not put this response in the
 * historical localStorage cache, scenario URL, or watchlist.
 */
export async function fetchSupabaseScoutEvidence({ seasonEndYear, team, playerIds }) {
  const catalog = getRemoteCatalog();
  const session = await catalog.getSession();
  if (!session) throw new Error("Sign in with your site administrator account to use the private Scout preview.");
  const evidence = await catalog.invokeFunction("lineup-scout-preview", {
    seasonEndYear: requireSeasonEndYear(seasonEndYear),
    team: requireTeamCode(team), playerIds,
  });
  if (evidence?.contractVersion !== 1 || evidence?.model?.calibration?.status !== "validated"
    || evidence?.model?.calibration?.allComponentsImproved !== true
    || evidence?.scope?.seasonEndYear !== Number(seasonEndYear)
    || evidence?.scope?.team !== team || evidence?.scope?.seasonPhase !== "combined") {
    throw new Error("Scout evidence does not match this selection or has not passed validation. Historical mode remains available.");
  }
  return evidence;
}

/** Read the imported 1980+ season list through the shared Supabase adapter. */
export async function listSupabaseNbaSeasons(options = {}) {
  const catalog = getRemoteCatalog();
  if (typeof catalog.listNbaLineupSeasons !== "function") {
    throw new Error("The Lineup Lab data connection is not ready yet.");
  }
  return catalog.listNbaLineupSeasons({ minimumSeason: MINIMUM_SUPPORTED_SEASON, ...options });
}

/** Read the historically accurate team identities for one selected season. */
export async function listSupabaseNbaTeams(options = {}) {
  const catalog = getRemoteCatalog();
  if (typeof catalog.listNbaLineupTeams !== "function") {
    throw new Error("The Lineup Lab team data connection is not ready yet.");
  }
  const seasonEndYear = requireSeasonEndYear(options.seasonEndYear);
  return catalog.listNbaLineupTeams({ ...options, seasonEndYear });
}

/** Load one historical regular-season or playoff player pool from Supabase. */
export async function fetchSupabaseNbaTeamDataset(options = {}) {
  const catalog = getRemoteCatalog();
  if (typeof catalog.listNbaTeamSeasonPlayers !== "function") {
    throw new Error("The Lineup Lab player data connection is not ready yet.");
  }
  const team = requireTeamCode(options.team);
  const season = requireSeasonEndYear(options.season);
  const seasonPhase = requireSeasonPhase(options.seasonPhase);
  const rows = await catalog.listNbaTeamSeasonPlayers({
    teamCode: team,
    seasonEndYear: season,
    seasonPhase,
    force: options.force,
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`No ${phaseLabel(seasonPhase).toLowerCase()} player totals were found for ${team} in ${nbaSeasonLabel(season)}.`);
  }
  // The shared Supabase boundary owns the read-only season aggregation. Keep
  // feature detection for older deployed/cached shared clients, and validate
  // inside the optional path: malformed evidence must not block a valid team
  // pool. The direct dataset constructor remains strict for callers/tests.
  let seasonEvidenceRows = [];
  let seasonEvidenceStatus = "shared-reader-not-available";
  if (typeof catalog.listNbaPlayerSeasonEvidence === "function") {
    try {
      seasonEvidenceStatus = "temporarily-unavailable";
      seasonEvidenceRows = await catalog.listNbaPlayerSeasonEvidence({
        playerIds: rows.map((row) => requireText(row.player_id, "Player ID")),
        seasonEndYear: season,
        seasonPhase,
        force: options.force,
      });
      seasonEvidenceStatus = "invalid-response";
      if (!Array.isArray(seasonEvidenceRows)) throw new Error("Invalid season evidence response.");
      const usableEvidence = seasonEvidenceByPlayerId(seasonEvidenceRows, {
        playerIds: rows.map((row) => requireText(row.player_id, "Player ID")), season, seasonPhase,
      });
      seasonEvidenceStatus = usableEvidence.size > 0 ? "available" : "no-matching-rows";
    } catch {
      seasonEvidenceRows = [];
    }
  }
  return createSupabaseNbaTeamDataset(rows, {
    team,
    season,
    seasonPhase,
    snapshotDate: options.snapshotDate,
    seasonEvidenceRows,
    seasonEvidenceStatus,
  });
}
