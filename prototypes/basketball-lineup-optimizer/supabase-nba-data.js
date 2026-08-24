// The app is deployed as static ES modules; retain the release revision here
// as well so the data adapter and normalization rules update together.
import { normalizeDataset } from "./player-data.js?v=20260823d";

const MINIMUM_SUPPORTED_SEASON = 1980;
const TRUSTED_MEDIA_HOSTS = new Set([
  "www.basketball-reference.com",
  "cdn.ssref.net",
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
  return seasonPhase === "playoffs" ? "Playoff" : "Regular-season";
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
    positions: requireText(row.listed_position || row.player_primary_position, "Player position"),
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
  const source = {
    label: `${teamName} ${nbaSeasonLabel(season)} ${phaseLabel(seasonPhase)} player pool`,
    provider: "Basketball Reference via DJHC database",
    url: sourceUrl,
    snapshotDate: options.snapshotDate || currentSnapshotDate(),
    season: nbaSeasonLabel(season),
    team,
    seasonPhase,
    teamLogoUrl,
    note: "Basketball Reference team-stint totals, converted to per-game values. Players who changed teams are scoped only to this team stint.",
  };
  const rawPlayers = rows.map((row) => mapSupabaseNbaPlayer(row, { team, season, seasonPhase }));
  const dataset = normalizeDataset({ schemaVersion: 1, source, players: rawPlayers }, {
    strict: true,
    warnOnGeneratedId: false,
  });

  const headshots = new Map(rawPlayers.map((player) => [player.id, player.headshotUrl]));
  dataset.players = dataset.players.map((player) => ({
    ...player,
    headshotUrl: headshots.get(player.id) || "",
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
  return createSupabaseNbaTeamDataset(rows, {
    team,
    season,
    seasonPhase,
    snapshotDate: options.snapshotDate,
  });
}
