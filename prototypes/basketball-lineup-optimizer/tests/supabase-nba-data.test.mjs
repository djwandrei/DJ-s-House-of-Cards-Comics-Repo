import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupabaseNbaTeamDataset,
  fetchSupabaseNbaTeamDataset,
  listSupabaseNbaSeasons,
  listSupabaseNbaTeams,
  mapSupabaseNbaPlayer,
  nbaSeasonLabel,
  summarizeSupabaseNbaTeamRows,
} from "../supabase-nba-data.js";

function savedRow(overrides = {}) {
  return {
    player_id: "edwaran01",
    player_name: "Anthony Edwards",
    player_primary_position: "G",
    player_headshot_url: "https://cdn.ssref.net/edwaran01.jpg",
    team_logo_url: "https://cdn.ssref.net/MIN-2025.png",
    season_end_year: 2025,
    season_label: "2024-25",
    season_phase: "regular",
    team_code: "MIN",
    team_name: "Minnesota Timberwolves",
    listed_position: "SG",
    player_age: 23,
    games_played: 79,
    games_started: 79,
    minutes_played: 2871,
    field_goals_made: 789,
    field_goals_attempted: 1764,
    three_point_field_goals_made: 320,
    three_point_field_goals_attempted: 811,
    free_throws_made: 279,
    free_throws_attempted: 333,
    total_rebounds: 450,
    assists: 359,
    steals: 91,
    blocks: 51,
    turnovers: 249,
    points: 2177,
    source_name: "basketball_reference",
    source_url: "https://www.basketball-reference.com/leagues/NBA_2025_totals.html",
    ...overrides,
  };
}

test("maps a saved team stint to source-neutral per-game optimizer fields", () => {
  const player = mapSupabaseNbaPlayer(savedRow(), { team: "MIN", season: 2025, seasonPhase: "regular" });

  assert.deepEqual(player, {
    id: "edwaran01",
    name: "Anthony Edwards",
    team: "MIN",
    positions: "SG",
    age: 23,
    games: 79,
    starts: 79,
    minutes: 2871 / 79,
    fgPct: 789 / 1764,
    threePct: 320 / 811,
    efgPct: (789 + (0.5 * 320)) / 1764,
    ftPct: 279 / 333,
    rebounds: 450 / 79,
    assists: 359 / 79,
    steals: 91 / 79,
    blocks: 51 / 79,
    turnovers: 249 / 79,
    points: 2177 / 79,
    headshotUrl: "https://cdn.ssref.net/edwaran01.jpg",
  });
});

test("accepts missing historical starts and zero shooting attempts without fabricating percentages", () => {
  const player = mapSupabaseNbaPlayer(savedRow({
    games_started: null,
    field_goals_made: 0,
    field_goals_attempted: 0,
    three_point_field_goals_made: 0,
    three_point_field_goals_attempted: 0,
    free_throws_made: 0,
    free_throws_attempted: 0,
  }), { team: "MIN", season: 2025, seasonPhase: "regular" });

  assert.equal(player.starts, 0);
  assert.equal(player.fgPct, 0);
  assert.equal(player.threePct, 0);
  assert.equal(player.efgPct, 0);
  assert.equal(player.ftPct, 0);
});

test("summarizes aggregate team production and the minutes-based top rotation", () => {
  const rows = [
    savedRow({
      player_id: "alpha01",
      player_name: "Alpha Forward",
      listed_position: "PF-C",
      games_played: 82,
      games_started: 80,
      minutes_played: 2460,
      field_goals_made: 500,
      field_goals_attempted: 1000,
      three_point_field_goals_made: 100,
      three_point_field_goals_attempted: 250,
      total_rebounds: 600,
      assists: 300,
      steals: 80,
      blocks: 40,
      turnovers: 160,
      points: 1300,
    }),
    savedRow({
      player_id: "beta01",
      player_name: "Beta Guard",
      listed_position: "PG-SG",
      player_headshot_url: "https://images.example.test/beta01.jpg",
      games_played: 60,
      games_started: 30,
      minutes_played: 1640,
      field_goals_made: 250,
      field_goals_attempted: 500,
      three_point_field_goals_made: 50,
      three_point_field_goals_attempted: 150,
      total_rebounds: 200,
      assists: 400,
      steals: 70,
      blocks: 10,
      turnovers: 120,
      points: 700,
    }),
    ...Array.from({ length: 9 }, (_, index) => savedRow({
      player_id: `bench${index}`,
      player_name: `Bench Player ${index}`,
      listed_position: "F",
      games_played: 20,
      games_started: 0,
      minutes_played: 900 - (index * 50),
      field_goals_made: 0,
      field_goals_attempted: 0,
      three_point_field_goals_made: 0,
      three_point_field_goals_attempted: 0,
      total_rebounds: 0,
      assists: 0,
      steals: 0,
      blocks: 0,
      turnovers: 0,
      points: 0,
    })),
  ];

  const summary = summarizeSupabaseNbaTeamRows(rows);

  assert.equal(summary.teamGames, 82);
  assert.deepEqual(summary.teamAverages, {
    points: 2000 / 82,
    rebounds: 800 / 82,
    assists: 700 / 82,
    steals: 150 / 82,
    blocks: 50 / 82,
    turnovers: 280 / 82,
    efgPct: (750 + (0.5 * 150)) / 1500,
    threePct: 150 / 400,
  });
  assert.equal(summary.rotation.length, 9);
  assert.deepEqual(summary.rotation[0], {
    id: "alpha01",
    name: "Alpha Forward",
    positions: ["F", "C"],
    headshotUrl: "https://cdn.ssref.net/edwaran01.jpg",
    games: 82,
    starts: 80,
    minutesPerTeamGame: 30,
  });
  assert.equal(summary.rotation[1].id, "beta01");
  assert.deepEqual(summary.rotation[1].positions, ["G"]);
  assert.equal(summary.rotation[1].headshotUrl, "");
  assert.equal(summary.rotation.some((player) => player.id === "bench8"), false);
});

test("estimates a full team schedule when no individual player appeared in every game", () => {
  const rows = Array.from({ length: 10 }, (_, index) => savedRow({
    player_id: `rotation${index}`,
    player_name: `Rotation Player ${index}`,
    games_played: 78,
    games_started: 0,
    // Ten equal shares total 19,680 player-minutes: 82 regulation
    // team games even though every individual GP value stops at 78.
    minutes_played: 1968,
  }));

  assert.equal(summarizeSupabaseNbaTeamRows(rows).teamGames, 82);
});

test("creates a valid single-team data set with optional confirmed media", () => {
  const dataset = createSupabaseNbaTeamDataset([
    savedRow(),
    savedRow({
      player_id: "goberru01",
      player_name: "Rudy Gobert",
      listed_position: "C",
      player_headshot_url: "",
      games_played: 70,
      games_started: 70,
      minutes_played: 2345,
      field_goals_made: 400,
      field_goals_attempted: 650,
      three_point_field_goals_made: 0,
      three_point_field_goals_attempted: 0,
      free_throws_made: 240,
      free_throws_attempted: 360,
      total_rebounds: 900,
      assists: 120,
      steals: 50,
      blocks: 110,
      turnovers: 130,
      points: 1040,
    }),
  ], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
    snapshotDate: "2026-08-23",
  });

  assert.equal(dataset.diagnostics.errors.length, 0);
  assert.equal(dataset.players.length, 2);
  assert.deepEqual(dataset.players[0].positions, ["G"]);
  assert.deepEqual(dataset.players[1].positions, ["C"]);
  assert.equal(dataset.players[0].headshotUrl, "https://cdn.ssref.net/edwaran01.jpg");
  assert.equal(dataset.players[1].headshotUrl, "");
  assert.equal(dataset.source.provider, "Basketball Reference via DJHC database");
  assert.equal(dataset.source.teamLogoUrl, "https://cdn.ssref.net/MIN-2025.png");
  assert.equal(dataset.source.season, "2024-25");
  assert.equal(dataset.source.teamName, "Minnesota Timberwolves");
  assert.equal(dataset.source.teamGames, 79);
  assert.equal(dataset.source.teamAverages.points, (2177 + 1040) / 79);
  assert.deepEqual(dataset.source.rotation.map((player) => player.id), ["edwaran01", "goberru01"]);
  assert.equal(dataset.source.label, "Minnesota Timberwolves 2024-25 Regular season player pool");
  assert.match(dataset.source.note, /team-stint totals/i);
});

test("uses clear playoff copy in historical dataset labels", () => {
  const dataset = createSupabaseNbaTeamDataset([savedRow({ season_phase: "playoffs" })], {
    team: "MIN",
    season: 2025,
    seasonPhase: "playoffs",
  });

  assert.equal(dataset.source.label, "Minnesota Timberwolves 2024-25 Playoffs player pool");
});

test("rejects cross-team or cross-phase rows instead of mixing roster stints", () => {
  assert.throws(
    () => mapSupabaseNbaPlayer(savedRow({ team_code: "BOS" }), { team: "MIN", season: 2025, seasonPhase: "regular" }),
    /Received BOS while loading MIN/,
  );
  assert.throws(
    () => mapSupabaseNbaPlayer(savedRow({ season_phase: "playoffs" }), { team: "MIN", season: 2025, seasonPhase: "regular" }),
    /playoffs stats while loading regular/,
  );
});

test("keeps untrusted media hosts out of browser image data", () => {
  const player = mapSupabaseNbaPlayer(savedRow({
    player_headshot_url: "https://images.example.test/edwaran01.jpg",
  }), { team: "MIN", season: 2025, seasonPhase: "regular" });
  const dataset = createSupabaseNbaTeamDataset([savedRow({
    team_logo_url: "https://images.example.test/MIN-2025.png",
  })], { team: "MIN", season: 2025, seasonPhase: "regular" });

  assert.equal(player.headshotUrl, "");
  assert.equal(dataset.source.teamLogoUrl, "");
});

test("loads through the shared remote catalog boundary with constrained parameters", async () => {
  const originalDJ = globalThis.DJ;
  const calls = [];
  globalThis.DJ = {
    remoteCatalog: {
      async listNbaTeamSeasonPlayers(options) {
        calls.push(options);
        return [savedRow()];
      },
    },
  };

  try {
    const dataset = await fetchSupabaseNbaTeamDataset({
      team: "min",
      season: 2025,
      seasonPhase: "regular",
      force: true,
      snapshotDate: "2026-08-23",
    });
    assert.equal(dataset.players.length, 1);
    assert.deepEqual(calls, [{
      teamCode: "MIN",
      seasonEndYear: 2025,
      seasonPhase: "regular",
      force: true,
    }]);
  } finally {
    if (originalDJ === undefined) delete globalThis.DJ;
    else globalThis.DJ = originalDJ;
  }
});

test("loads available historic seasons and teams through the shared remote catalog boundary", async () => {
  const originalDJ = globalThis.DJ;
  const calls = [];
  globalThis.DJ = {
    remoteCatalog: {
      async listNbaLineupSeasons(options) {
        calls.push(["seasons", options]);
        return [{ season_end_year: 1980, season_label: "1979-80" }];
      },
      async listNbaLineupTeams(options) {
        calls.push(["teams", options]);
        return [{ team_code: "SDC", team_name: "San Diego Clippers", season_end_year: 1980 }];
      },
    },
  };

  try {
    const seasons = await listSupabaseNbaSeasons({ force: true });
    const teams = await listSupabaseNbaTeams({ seasonEndYear: 1980, force: true });
    assert.deepEqual(seasons, [{ season_end_year: 1980, season_label: "1979-80" }]);
    assert.deepEqual(teams, [{ team_code: "SDC", team_name: "San Diego Clippers", season_end_year: 1980 }]);
    assert.deepEqual(calls, [
      ["seasons", { minimumSeason: 1980, force: true }],
      ["teams", { seasonEndYear: 1980, force: true }],
    ]);
  } finally {
    if (originalDJ === undefined) delete globalThis.DJ;
    else globalThis.DJ = originalDJ;
  }
});

test("formats supported ending years deterministically", () => {
  assert.equal(nbaSeasonLabel(1980), "1979-80");
  assert.equal(nbaSeasonLabel(2026), "2025-26");
});
