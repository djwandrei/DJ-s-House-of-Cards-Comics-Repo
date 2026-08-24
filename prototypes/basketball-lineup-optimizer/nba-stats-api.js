import { normalizeDataset } from "./player-data.js";

export const NBA_STATS_API_BASE_URL = "https://api.server.nbaapi.com";
export const NBA_STATS_API_SOURCE_URL = "https://github.com/nprasad2077/nbaStats";
export const NBA_STATS_PROXY_PATH = "/__lineup-api/playertotals";

export const NBA_TEAMS = Object.freeze([
  { code: "ATL", name: "Atlanta Hawks" },
  { code: "BOS", name: "Boston Celtics" },
  { code: "BRK", name: "Brooklyn Nets" },
  { code: "CHO", name: "Charlotte Hornets" },
  { code: "CHI", name: "Chicago Bulls" },
  { code: "CLE", name: "Cleveland Cavaliers" },
  { code: "DAL", name: "Dallas Mavericks" },
  { code: "DEN", name: "Denver Nuggets" },
  { code: "DET", name: "Detroit Pistons" },
  { code: "GSW", name: "Golden State Warriors" },
  { code: "HOU", name: "Houston Rockets" },
  { code: "IND", name: "Indiana Pacers" },
  { code: "LAC", name: "LA Clippers" },
  { code: "LAL", name: "Los Angeles Lakers" },
  { code: "MEM", name: "Memphis Grizzlies" },
  { code: "MIA", name: "Miami Heat" },
  { code: "MIL", name: "Milwaukee Bucks" },
  { code: "MIN", name: "Minnesota Timberwolves" },
  { code: "NOP", name: "New Orleans Pelicans" },
  { code: "NYK", name: "New York Knicks" },
  { code: "OKC", name: "Oklahoma City Thunder" },
  { code: "ORL", name: "Orlando Magic" },
  { code: "PHI", name: "Philadelphia 76ers" },
  { code: "PHO", name: "Phoenix Suns" },
  { code: "POR", name: "Portland Trail Blazers" },
  { code: "SAC", name: "Sacramento Kings" },
  { code: "SAS", name: "San Antonio Spurs" },
  { code: "TOR", name: "Toronto Raptors" },
  { code: "UTA", name: "Utah Jazz" },
  { code: "WAS", name: "Washington Wizards" },
]);

const TEAM_BY_CODE = new Map(NBA_TEAMS.map((team) => [team.code, team]));
const PROVIDER_PAGE_SIZE = 50;
const MAX_TEAM_PAGES = 5;
const CORS_CACHE_WINDOW_MS = 6 * 60 * 60 * 1000;
const REQUIRED_PROVIDER_FIELDS = Object.freeze([
  "playerName",
  "position",
  "age",
  "games",
  "gamesStarted",
  "minutesPg",
  "fieldPercent",
  "threePercent",
  "effectFgPercent",
  "ftPercent",
  "totalRb",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "points",
  "team",
  "season",
]);

function providerNumber(row, field) {
  const value = row?.[field];
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    throw new TypeError(`NBA Stats API row is missing ${field}.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`NBA Stats API row has an invalid ${field}.`);
  }
  return number;
}

function perGame(total, games) {
  return total / games;
}

function normalizedTeamCode(value) {
  return String(value ?? "").trim().toUpperCase();
}

function validateTeamAndSeason(team, season) {
  const teamCode = normalizedTeamCode(team);
  if (!TEAM_BY_CODE.has(teamCode)) {
    throw new RangeError(`Unsupported NBA team code "${teamCode || team}".`);
  }
  const seasonYear = Number(season);
  if (!Number.isInteger(seasonYear) || seasonYear < 1947 || seasonYear > 2100) {
    throw new RangeError("NBA season must be a valid ending year.");
  }
  return { teamCode, seasonYear };
}

export function nbaSeasonLabel(season) {
  const seasonYear = Number(season);
  if (!Number.isInteger(seasonYear)) return String(season ?? "");
  return `${seasonYear - 1}-${String(seasonYear).slice(-2)}`;
}

export function currentNbaSeasonEndYear(date = new Date()) {
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= 9 ? year + 1 : year;
}

/**
 * Convert one live provider row into the source-neutral optimizer schema.
 * The public API currently labels season totals as `minutesPg` and exposes
 * counting-stat totals, so every counting value is divided by games here.
 */
export function mapNbaStatsPlayer(row, options = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw new TypeError("NBA Stats API player data must be an object.");
  }
  for (const field of REQUIRED_PROVIDER_FIELDS) providerNumberOrText(row, field);

  const games = providerNumber(row, "games");
  if (!Number.isInteger(games) || games <= 0) {
    throw new RangeError("NBA Stats API games must be a positive whole number.");
  }

  const team = normalizedTeamCode(row.team);
  const expectedTeam = options.team ? normalizedTeamCode(options.team) : team;
  if (team !== expectedTeam) {
    throw new RangeError(`NBA Stats API returned ${team || "an unknown team"} while loading ${expectedTeam}.`);
  }
  const season = providerNumber(row, "season");
  if (options.season !== undefined && season !== Number(options.season)) {
    throw new RangeError(`NBA Stats API returned season ${season} while loading ${options.season}.`);
  }
  if (row.isPlayoff === true || String(row.isPlayoff).toLowerCase() === "true") {
    throw new RangeError("Playoff rows cannot be mixed into a regular-season player pool.");
  }

  const name = String(row.playerName).trim();
  const position = String(row.position).trim();
  if (!name || !position) throw new TypeError("NBA Stats API player name and position are required.");

  return {
    id: String(row.playerId || `${team}-${name}`).trim(),
    name,
    team,
    positions: position,
    age: providerNumber(row, "age"),
    games,
    starts: providerNumber(row, "gamesStarted"),
    minutes: perGame(providerNumber(row, "minutesPg"), games),
    fgPct: providerNumber(row, "fieldPercent"),
    threePct: providerNumber(row, "threePercent"),
    efgPct: providerNumber(row, "effectFgPercent"),
    ftPct: providerNumber(row, "ftPercent"),
    rebounds: perGame(providerNumber(row, "totalRb"), games),
    assists: perGame(providerNumber(row, "assists"), games),
    steals: perGame(providerNumber(row, "steals"), games),
    blocks: perGame(providerNumber(row, "blocks"), games),
    turnovers: perGame(providerNumber(row, "turnovers"), games),
    points: perGame(providerNumber(row, "points"), games),
  };
}

function providerNumberOrText(row, field) {
  const value = row?.[field];
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    throw new TypeError(`NBA Stats API row is missing ${field}.`);
  }
  return value;
}

export function createNbaTeamDataset(rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError("NBA Stats API response data must be an array.");
  const { teamCode, seasonYear } = validateTeamAndSeason(options.team, options.season);
  const deduplicated = new Map();
  let duplicateCount = 0;
  const omitted = [];

  for (const row of rows) {
    try {
      const player = mapNbaStatsPlayer(row, { team: teamCode, season: seasonYear });
      const identity = player.id.toLowerCase();
      if (deduplicated.has(identity)) {
        const prior = deduplicated.get(identity);
        if (JSON.stringify(prior) !== JSON.stringify(player)) {
          throw new Error(`NBA Stats API returned conflicting rows for ${player.name}.`);
        }
        duplicateCount += 1;
      } else {
        deduplicated.set(identity, player);
      }
    } catch (error) {
      omitted.push(error instanceof Error ? error.message : "An invalid provider row was omitted.");
    }
  }
  if (omitted.length > 0) {
    throw new Error(
      `NBA Stats API returned ${omitted.length} invalid player row${omitted.length === 1 ? "" : "s"}. ${omitted[0]}`,
    );
  }
  const mappedPlayers = [...deduplicated.values()];
  if (mappedPlayers.length < 5) {
    throw new Error(`NBA Stats API returned only ${mappedPlayers.length} usable ${teamCode} players.`);
  }

  const teamName = TEAM_BY_CODE.get(teamCode).name;
  const snapshotDate = options.snapshotDate || new Date().toISOString().slice(0, 10);
  const dataset = normalizeDataset(
    {
      schemaVersion: 1,
      source: {
        label: `${teamName} regular-season stats`,
        provider: "NBA Stats API 2.0",
        season: nbaSeasonLabel(seasonYear),
        snapshotDate,
        team: teamCode,
        url: NBA_STATS_API_SOURCE_URL,
        note: "Public-beta team-season totals normalized to per-game values. Includes players who appeared for the team, not a current roster or injury report.",
      },
      players: mappedPlayers,
    },
    { strict: true, warnOnGeneratedId: false },
  );

  if (duplicateCount > 0) {
    dataset.diagnostics.warnings.push({
      code: "PROVIDER_DUPLICATES_MERGED",
      path: "players",
      message: `${duplicateCount} duplicate provider row${duplicateCount === 1 ? " was" : "s were"} merged.`,
    });
  }
  return dataset;
}

function defaultPlayerTotalsEndpoint() {
  if (typeof window !== "undefined" && window.location?.origin) {
    return new URL(NBA_STATS_PROXY_PATH, window.location.origin);
  }
  return new URL("/api/playertotals", NBA_STATS_API_BASE_URL);
}

function buildPlayerTotalsUrl({ team, season, page, endpointUrl, requestVariant = 0 }) {
  const url = new URL(endpointUrl || defaultPlayerTotalsEndpoint());
  url.searchParams.set("season", String(season));
  url.searchParams.set("team", team);
  url.searchParams.set("isPlayoff", "false");
  url.searchParams.set("page", String(page));
  url.searchParams.set("pageSize", String(PROVIDER_PAGE_SIZE));
  url.searchParams.set("sortBy", "points");
  url.searchParams.set("ascending", "false");
  if (url.origin === NBA_STATS_API_BASE_URL) {
    // Direct-provider requests are reserved for non-browser tests. The
    // provider's nginx cache does not consistently vary responses by Origin,
    // so browser use goes through the same-origin prototype proxy.
    const cacheWindow = Math.floor(Date.now() / CORS_CACHE_WINDOW_MS);
    url.searchParams.set("djhcClient", `lineup-lab-v1-${cacheWindow}-${requestVariant}`);
  }
  return url;
}

async function fetchPage(fetchImpl, request, signal) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(buildPlayerTotalsUrl({ ...request, requestVariant: attempt }), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error instanceof Error ? error : new Error("NBA Stats API network request failed.");
      continue;
    }
    if (!response?.ok) {
      lastError = new Error(`NBA Stats API request failed (${response?.status || "network error"}).`);
      if (Number(response?.status) < 500) throw lastError;
      continue;
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.data) || !payload.pagination) {
      throw new TypeError("NBA Stats API returned an unexpected response shape.");
    }
    if (payload.data.length > PROVIDER_PAGE_SIZE) {
      throw new RangeError("NBA Stats API returned more rows than the requested page size.");
    }
    return payload;
  }
  throw lastError || new Error("NBA Stats API request failed.");
}

export async function fetchNbaTeamDataset(options = {}) {
  const { teamCode, seasonYear } = validateTeamAndSeason(options.team, options.season);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 12000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const endpointUrl = options.endpointUrl || defaultPlayerTotalsEndpoint();
    const first = await fetchPage(
      fetchImpl,
      { team: teamCode, season: seasonYear, page: 1, endpointUrl },
      controller.signal,
    );
    const pages = Number(first.pagination.pages ?? 1);
    if (pages === 0 && first.data.length === 0) {
      return createNbaTeamDataset([], { team: teamCode, season: seasonYear });
    }
    if (!Number.isInteger(pages) || pages < 1 || pages > MAX_TEAM_PAGES) {
      throw new RangeError("NBA Stats API returned an unsafe pagination count.");
    }
    const rows = [...first.data];
    for (let page = 2; page <= pages; page += 1) {
      const payload = await fetchPage(
        fetchImpl,
        { team: teamCode, season: seasonYear, page, endpointUrl },
        controller.signal,
      );
      rows.push(...payload.data);
    }
    return createNbaTeamDataset(rows, {
      team: teamCode,
      season: seasonYear,
      snapshotDate: options.snapshotDate,
    });
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("NBA Stats API request timed out.", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
