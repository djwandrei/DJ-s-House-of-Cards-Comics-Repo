import test from "node:test";
import assert from "node:assert/strict";

import {
  createNbaTeamDataset,
  currentNbaSeasonEndYear,
  fetchNbaTeamDataset,
  mapNbaStatsPlayer,
  nbaSeasonLabel,
} from "../nba-stats-api.js";

function providerRow(overrides = {}) {
  return {
    id: 1,
    playerId: "edwaran01",
    playerName: "Anthony Edwards",
    position: "SG",
    age: 23,
    games: 79,
    gamesStarted: 79,
    minutesPg: 2871,
    fieldGoals: 789,
    fieldAttempts: 1764,
    fieldPercent: 0.447,
    threeFg: 320,
    threeAttempts: 811,
    threePercent: 0.395,
    effectFgPercent: 0.547,
    ft: 279,
    ftAttempts: 333,
    ftPercent: 0.837,
    totalRb: 450,
    assists: 359,
    steals: 91,
    blocks: 51,
    turnovers: 249,
    points: 2177,
    team: "MIN",
    season: 2025,
    isPlayoff: false,
    ...overrides,
  };
}

test("maps live season totals into canonical per-game optimizer values", () => {
  const player = mapNbaStatsPlayer(providerRow(), { team: "MIN", season: 2025 });

  assert.deepEqual(player, {
    id: "edwaran01",
    name: "Anthony Edwards",
    team: "MIN",
    positions: "SG",
    age: 23,
    games: 79,
    starts: 79,
    minutes: 2871 / 79,
    fgPct: 0.447,
    threePct: 0.395,
    efgPct: 0.547,
    ftPct: 0.837,
    rebounds: 450 / 79,
    assists: 359 / 79,
    steals: 91 / 79,
    blocks: 51 / 79,
    turnovers: 249 / 79,
    points: 2177 / 79,
  });
});

test("builds a valid team dataset and normalizes NBA position families", () => {
  const rows = [
    providerRow(),
    providerRow({ playerId: "guard02", playerName: "Combo Guard", position: "PG-SG", games: 40, gamesStarted: 35 }),
    providerRow({ playerId: "forward03", playerName: "Combo Forward", position: "SF-PF", games: 38, gamesStarted: 30 }),
    providerRow({ playerId: "center04", playerName: "Center", position: "C", games: 35, gamesStarted: 20 }),
    providerRow({ playerId: "flex05", playerName: "Frontcourt Flex", position: "PF-C", games: 30, gamesStarted: 10 }),
  ];
  const dataset = createNbaTeamDataset(rows, {
    team: "MIN",
    season: 2025,
    snapshotDate: "2026-08-23",
  });

  assert.equal(dataset.players.length, 5);
  assert.deepEqual(dataset.players[0].positions, ["G"]);
  assert.deepEqual(dataset.players[1].positions, ["G"]);
  assert.deepEqual(dataset.players[2].positions, ["F"]);
  assert.deepEqual(dataset.players[4].positions, ["F", "C"]);
  assert.equal(dataset.source.provider, "NBA Stats API 2.0");
  assert.equal(dataset.source.season, "2024-25");
  assert.equal(dataset.diagnostics.errors.length, 0);
});

test("merges exact repeated provider rows and rejects conflicting duplicates", () => {
  const rows = [
    providerRow(),
    providerRow(),
    providerRow({ playerId: "guard02", playerName: "Guard Two", position: "PG" }),
    providerRow({ playerId: "forward03", playerName: "Forward Three", position: "SF" }),
    providerRow({ playerId: "center04", playerName: "Center Four", position: "C" }),
    providerRow({ playerId: "flex05", playerName: "Flex Five", position: "PF-C" }),
  ];
  const dataset = createNbaTeamDataset(rows, { team: "MIN", season: 2025 });

  assert.equal(dataset.players.length, 5);
  assert.equal(dataset.players.find(({ id }) => id === "edwaran01").games, 79);
  assert.ok(dataset.diagnostics.warnings.some(({ code }) => code === "PROVIDER_DUPLICATES_MERGED"));

  assert.throws(
    () => createNbaTeamDataset(
      [
        ...rows,
        providerRow({ points: 999 }),
      ],
      { team: "MIN", season: 2025 },
    ),
    /conflicting rows/,
  );
});

test("fetches every reported team page with bounded provider filters", async () => {
  const requests = [];
  const rows = [
    providerRow(),
    providerRow({ playerId: "guard02", playerName: "Guard Two", position: "PG" }),
    providerRow({ playerId: "forward03", playerName: "Forward Three", position: "SF" }),
    providerRow({ playerId: "center04", playerName: "Center Four", position: "C" }),
    providerRow({ playerId: "flex05", playerName: "Flex Five", position: "PF-C" }),
  ];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    const page = Number(new URL(url).searchParams.get("page"));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: page === 1 ? rows.slice(0, 3) : rows.slice(3),
          pagination: { page, pageSize: 50, total: 5, pages: 2 },
        };
      },
    };
  };

  const dataset = await fetchNbaTeamDataset({
    team: "min",
    season: 2025,
    snapshotDate: "2026-08-23",
    fetchImpl,
  });

  assert.equal(dataset.players.length, 5);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url.origin, "https://api.server.nbaapi.com");
    assert.equal(request.url.pathname, "/api/playertotals");
    assert.equal(request.url.searchParams.get("team"), "MIN");
    assert.equal(request.url.searchParams.get("season"), "2025");
    assert.equal(request.url.searchParams.get("isPlayoff"), "false");
    assert.equal(request.url.searchParams.get("pageSize"), "50");
    assert.equal(request.url.searchParams.get("sortBy"), "points");
    assert.equal(request.url.searchParams.get("ascending"), "false");
    assert.match(request.url.searchParams.get("djhcClient"), /^lineup-lab-v1-\d+-0$/);
    assert.equal(request.options.cache, "no-store");
  }
});

test("rejects provider errors and unsafe cross-team rows", async () => {
  await assert.rejects(
    fetchNbaTeamDataset({
      team: "MIN",
      season: 2025,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /failed \(503\)/,
  );
  assert.throws(
    () => mapNbaStatsPlayer(providerRow({ team: "BOS" }), { team: "MIN", season: 2025 }),
    /while loading MIN/,
  );
  assert.throws(
    () => mapNbaStatsPlayer(providerRow({ games: 0 }), { team: "MIN", season: 2025 }),
    /positive whole number/,
  );
  assert.throws(
    () => mapNbaStatsPlayer(providerRow({ age: "  " }), { team: "MIN", season: 2025 }),
    /missing age/,
  );
  assert.throws(
    () => mapNbaStatsPlayer(providerRow({ isPlayoff: true }), { team: "MIN", season: 2025 }),
    /Playoff rows/,
  );
  assert.throws(
    () => mapNbaStatsPlayer(providerRow({ season: 2024 }), { team: "MIN", season: 2025 }),
    /while loading 2025/,
  );
});

test("fails the whole provider dataset when one row is malformed or cross-team", () => {
  const validRows = [
    providerRow(),
    providerRow({ playerId: "guard02", playerName: "Guard Two", position: "PG" }),
    providerRow({ playerId: "forward03", playerName: "Forward Three", position: "SF" }),
    providerRow({ playerId: "center04", playerName: "Center Four", position: "C" }),
    providerRow({ playerId: "flex05", playerName: "Flex Five", position: "PF-C" }),
  ];
  assert.throws(
    () => createNbaTeamDataset(
      [...validRows, providerRow({ playerId: "edwaran01", team: "BOS", games: 82, minutesPg: 3000 })],
      { team: "MIN", season: 2025 },
    ),
    /while loading MIN/,
  );
});

test("retries one transient provider failure and rejects empty or unsafe pagination", async () => {
  const rows = [
    providerRow(),
    providerRow({ playerId: "guard02", playerName: "Guard Two", position: "PG" }),
    providerRow({ playerId: "forward03", playerName: "Forward Three", position: "SF" }),
    providerRow({ playerId: "center04", playerName: "Center Four", position: "C" }),
    providerRow({ playerId: "flex05", playerName: "Flex Five", position: "PF-C" }),
  ];
  const requestUrls = [];
  const dataset = await fetchNbaTeamDataset({
    team: "MIN",
    season: 2025,
    fetchImpl: async (url) => {
      requestUrls.push(new URL(url));
      if (requestUrls.length === 1) return { ok: false, status: 503 };
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: rows, pagination: { page: 1, pageSize: 50, total: 5, pages: 1 } };
        },
      };
    },
  });
  assert.equal(dataset.players.length, 5);
  assert.equal(requestUrls.length, 2);
  assert.match(requestUrls[0].searchParams.get("djhcClient"), /-0$/);
  assert.match(requestUrls[1].searchParams.get("djhcClient"), /-1$/);

  await assert.rejects(
    fetchNbaTeamDataset({
      team: "MIN",
      season: 2025,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: [], pagination: { page: 1, pageSize: 50, total: 0, pages: 0 } };
        },
      }),
    }),
    /only 0 usable MIN players/,
  );
  await assert.rejects(
    fetchNbaTeamDataset({
      team: "MIN",
      season: 2025,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          return { data: rows, pagination: { page: 1, pageSize: 50, total: 300, pages: 6 } };
        },
      }),
    }),
    /unsafe pagination count/,
  );
});

test("formats ending-year seasons without hardcoding the current year", () => {
  assert.equal(nbaSeasonLabel(2026), "2025-26");
  assert.equal(currentNbaSeasonEndYear(new Date("2026-08-23T12:00:00Z")), 2026);
  assert.equal(currentNbaSeasonEndYear(new Date("2026-10-23T12:00:00Z")), 2027);
});
