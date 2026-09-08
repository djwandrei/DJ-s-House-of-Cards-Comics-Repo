import assert from "node:assert/strict";
import test from "node:test";

import {
  createSupabaseNbaTeamDataset,
  fetchSupabaseNbaTeamDataset,
  listSupabaseNbaSeasons,
  listSupabaseNbaTeams,
  mapSupabaseNbaPlayer,
  nbaSeasonLabel,
  responsibilityEvidenceForSeason,
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

test("combines a season-listed role with verified Basketball Reference career eligibility", () => {
  const row = savedRow({
    listed_position: "PF",
    career_profile_positions: ["PF", "C"],
    career_profile_position_text: "Power Forward and Center",
    career_profile_source_url: "https://www.basketball-reference.com/players/r/reidna01.html",
  });
  const mapped = mapSupabaseNbaPlayer(row, { team: "MIN", season: 2025, seasonPhase: "regular" });
  assert.equal(mapped.positions, "PF/C");

  const dataset = createSupabaseNbaTeamDataset([row], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
  });
  const [player] = dataset.players;
  assert.deepEqual(player.positions, ["F", "C"]);
  assert.deepEqual(player.positionEvidence, {
    seasonListed: ["F"],
    careerProfile: ["F", "C"],
    eligible: ["F", "C"],
    sourceText: "Power Forward and Center",
    sourceUrl: "https://www.basketball-reference.com/players/r/reidna01.html",
    usesCareerProfile: true,
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
  assert.match(dataset.source.note, /Visible per-game stats describe this team only/);
  assert.match(dataset.source.note, /do not set minute limits/);
});

test("attaches a source-backed fan analytics envelope from optional player-pool fields", () => {
  const dataset = createSupabaseNbaTeamDataset([savedRow({
    offensive_rebounds: "59",
    defensive_rebounds: 391,
    personal_fouls: "164",
    team_total_minutes: "19684",
    estimated_team_possessions: "8279.44",
    league_points_per_36: "16.7",
    league_rebounds_per_36: 6.5,
    league_assists_per_36: "3.8",
    league_steals_per_36: 1.1,
    league_blocks_per_36: 0.7,
    league_turnovers_per_36: "2.1",
    league_efg_pct: "0.541",
    league_three_pct: 0.358,
    advanced_metrics: {
      player_efficiency_rating: "24.6",
      box_plus_minus: -1.25,
      usage_percentage: 0.317,
      malformed_value: "not-a-number",
      missing_value: null,
    },
    postseason_available: true,
  })], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
  });

  const [player] = dataset.players;
  // The solver-facing per-game fields are still produced by the established
  // mapper; analytics lives in a separate object so it cannot silently alter
  // a constraint or exact objective input.
  assert.equal(player.points, 2177 / 79);
  assert.equal(player.minutes, 2871 / 79);
  assert.deepEqual(player.analytics.totals, {
    minutes: 2871,
    fieldGoalsMade: 789,
    fieldGoalsAttempted: 1764,
    threePointFieldGoalsMade: 320,
    threePointFieldGoalsAttempted: 811,
    freeThrowsMade: 279,
    freeThrowsAttempted: 333,
    offensiveRebounds: 59,
    defensiveRebounds: 391,
    totalRebounds: 450,
    assists: 359,
    steals: 91,
    blocks: 51,
    turnovers: 249,
    personalFouls: 164,
    points: 2177,
  });
  assert.deepEqual(player.analytics.advanced, {
    player_efficiency_rating: 24.6,
    box_plus_minus: -1.25,
    usage_percentage: 0.317,
  });
  assert.deepEqual(player.analytics.leaguePer36, {
    points: 16.7,
    rebounds: 6.5,
    assists: 3.8,
    steals: 1.1,
    blocks: 0.7,
    turnovers: 2.1,
    efgPct: 0.541,
    threePct: 0.358,
  });
  assert.equal(player.analytics.teamTotalMinutes, 19684);
  assert.equal(player.analytics.estimatedTeamPossessions, 8279.44);
  assert.equal(player.analytics.postseasonAvailable, true);
  assert.deepEqual(player.analytics.source, {
    season: "2024-25",
    team: "MIN",
    phase: "regular",
    url: "https://www.basketball-reference.com/leagues/NBA_2025_totals.html",
    isLeagueWide: true,
    leagueLabel: "NBA 2024-25 Regular season per-36 baseline",
    leagueScope: "all imported NBA team stints in the same season and phase, weighted by player minutes",
  });
});

test("attaches audited season-wide evidence without replacing team membership context", () => {
  const dataset = createSupabaseNbaTeamDataset([savedRow({
    games_played: 4,
    games_started: 4,
    minutes_played: 120,
    points: 100,
    advanced_metrics: {
      usage_percentage: 0.41,
      offensive_box_plus_minus: 7.5,
    },
  })], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
    seasonEvidenceRows: [{
      player_id: "edwaran01",
      season_end_year: 2025,
      season_phase: "regular",
      team_stint_count: 2,
      games_played: 82,
      minutes_played: 2460,
      field_goals_made: 600,
      field_goals_attempted: 1320,
      three_point_field_goals_made: 210,
      three_point_field_goals_attempted: 600,
      free_throws_made: 280,
      free_throws_attempted: 350,
      total_rebounds: 410,
      assists: 390,
      steals: 80,
      blocks: 45,
      turnovers: 210,
      points: 1690,
      player_possessions: 5080,
      season_advanced_metrics: {
        usage_percentage: 0.29,
        offensive_box_plus_minus: 4.2,
      },
    }],
  });

  const [player] = dataset.players;
  // The visible team line stays scoped to Minnesota, while the separate
  // evidence envelope supplies the all-team season sample used by rotation
  // reliability and role projection.
  assert.equal(player.team, "MIN");
  assert.equal(player.games, 4);
  assert.equal(player.points, 25);
  assert.deepEqual(player.analytics.seasonTotals, {
    games: 82,
    minutes: 2460,
    fieldGoalsMade: 600,
    fieldGoalsAttempted: 1320,
    threePointFieldGoalsMade: 210,
    threePointFieldGoalsAttempted: 600,
    freeThrowsMade: 280,
    freeThrowsAttempted: 350,
    totalRebounds: 410,
    assists: 390,
    steals: 80,
    blocks: 45,
    turnovers: 210,
    points: 1690,
  });
  assert.deepEqual(player.analytics.seasonEvidence, {
    scope: "season-wide",
    method: "aggregate of imported real-team rows for this player, season, and phase",
    completeness: "imported-rows-only",
    teamStintCount: 2,
    playerPossessions: 5080,
    playerPossessionsPerGame: null,
    hasReportedPossessions: true,
  });
  assert.deepEqual(player.analytics.seasonAdvanced, {
    usage_percentage: 0.29,
    offensive_box_plus_minus: 4.2,
  });
  assert.equal(player.analytics.advanced.usage_percentage, 0.29);
  assert.equal(player.analytics.advanced.offensive_box_plus_minus, 4.2);
  assert.equal(player.analytics.responsibilityEvidence.version, "scout-responsibility-evidence-v1");
  assert.equal(player.analytics.responsibilityEvidence.scope, "season-wide");
  assert.equal(player.analytics.responsibilityEvidence.games, 82);
  assert.equal(player.analytics.responsibilityEvidence.minutes, 2460);
  assert.equal(player.analytics.responsibilityEvidence.offensiveInvolvement, 1684);
  assert.equal(
    player.analytics.responsibilityEvidence.offensiveInvolvementPer36,
    (1684 * 36) / 2460,
  );
  assert.equal(player.analytics.responsibilityEvidence.fieldGoalAttempts, 1320);
  assert.equal(dataset.source.analytics.seasonEvidencePlayers, 1);
  assert.equal(dataset.source.analytics.responsibilityEvidencePlayers, 1);
  assert.equal(dataset.source.analytics.seasonEvidenceStatus, "available");
});

test("does not build a responsibility contract from a partial imported season row", () => {
  const dataset = createSupabaseNbaTeamDataset([savedRow({ games_played: 4, games_started: 4, minutes_played: 120 })], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
    seasonEvidenceRows: [{
      player_id: "edwaran01",
      season_end_year: 2025,
      season_phase: "regular",
      games_played: 82,
      minutes_played: 2460,
      field_goals_attempted: 1320,
      free_throws_attempted: null,
      turnovers: 210,
      points: 1690,
    }],
  });
  assert.equal(dataset.players[0].analytics.responsibilityEvidence, undefined);
  assert.equal(dataset.source.analytics.responsibilityEvidencePlayers, 0);
});

test("accepts an independently certified Scout involvement rate when raw components are unavailable", () => {
  const row = {
    player_id: "edwaran01",
    season_end_year: 2025,
    season_phase: "regular",
    games_played: 82,
    minutes_played: 2460,
    field_goals_attempted: 1320,
    free_throws_attempted: null,
    turnovers: 210,
    season_advanced_metrics: { offensiveInvolvementPer36: 18 },
    evidence_completeness: "scout-player-games-complete",
    evidence_source_revision: "scout-v2",
    evidence_contract: "scout-responsibility-v1",
  };
  const certified = responsibilityEvidenceForSeason({
    totals: { games: 82, minutes: 2460, fieldGoalsAttempted: 1320, freeThrowsAttempted: null, turnovers: 210 },
    advanced: { offensiveInvolvementPer36: 18 },
    source: { completeness: "scout-player-games-complete", sourceRevision: "scout-v2", evidenceContract: "scout-responsibility-v1" },
  });
  assert.equal(certified.scope, "season-wide");
  assert.equal(certified.offensiveInvolvementPer36, 18);
  assert.equal(certified.method, "independently certified Scout offensive-involvement rate");

  const dataset = createSupabaseNbaTeamDataset([savedRow({ games_played: 4, games_started: 4, minutes_played: 120 })], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
    seasonEvidenceRows: [row],
  });
  assert.equal(dataset.players[0].analytics.responsibilityEvidence.offensiveInvolvementPer36, 18);
  assert.equal(dataset.players[0].analytics.responsibilityEvidence.sourceRevision, "scout-v2");
  assert.equal(dataset.source.analytics.responsibilityEvidencePlayers, 1);
});

test("does not treat an unlabelled advanced involvement rate as certified evidence", () => {
  const evidence = responsibilityEvidenceForSeason({
    totals: { games: 82, minutes: 2460, fieldGoalsAttempted: 1320, freeThrowsAttempted: null, turnovers: 210 },
    advanced: { offensiveInvolvementPer36: 18 },
    source: { completeness: "imported-rows-only", sourceRevision: "ordinary-import-v1" },
  });
  assert.equal(evidence, null);
});

test("rejects duplicate or cross-season evidence instead of attaching an ambiguous sample", () => {
  const validEvidence = {
    player_id: "edwaran01",
    season_end_year: 2025,
    season_phase: "regular",
    games_played: 82,
    minutes_played: 2460,
  };
  assert.throws(
    () => createSupabaseNbaTeamDataset([savedRow()], {
      team: "MIN",
      season: 2025,
      seasonPhase: "regular",
      seasonEvidenceRows: [validEvidence, { ...validEvidence }],
    }),
    /Duplicate season-wide evidence/,
  );
  assert.throws(
    () => createSupabaseNbaTeamDataset([savedRow()], {
      team: "MIN",
      season: 2025,
      seasonPhase: "regular",
      seasonEvidenceRows: [{ ...validEvidence, season_end_year: 2024 }],
    }),
    /does not match the selected season and phase/,
  );
});

test("keeps legacy player-pool rows compatible when fan analytics fields are absent", () => {
  const dataset = createSupabaseNbaTeamDataset([savedRow()], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
  });

  const [player] = dataset.players;
  assert.equal(player.id, "edwaran01");
  assert.equal(player.points, 2177 / 79);
  assert.deepEqual(player.analytics.advanced, {});
  assert.deepEqual(player.analytics.leaguePer36, {
    points: null,
    rebounds: null,
    assists: null,
    steals: null,
    blocks: null,
    turnovers: null,
    efgPct: null,
    threePct: null,
  });
  assert.equal(player.analytics.teamTotalMinutes, null);
  assert.equal(player.analytics.estimatedTeamPossessions, null);
  assert.equal(player.analytics.postseasonAvailable, false);
  assert.equal(player.analytics.totals.offensiveRebounds, null);
  assert.equal(player.analytics.totals.defensiveRebounds, null);
  assert.equal(player.analytics.totals.personalFouls, null);
});

test("season counts reject coercion and cannot silently change phase or hide duplicates", () => {
  const evidence = { player_id: "edwaran01", season_end_year: 2025,
    season_phase: "regular", games_played: 82, minutes_played: 2460 };
  const build = seasonEvidenceRows => createSupabaseNbaTeamDataset([savedRow()], {
    team: "MIN", season: 2025, seasonPhase: "regular", seasonEvidenceRows,
  });
  for (const bad of [true, false, "", " ", null, [], {}, -1, 1.5]) {
    const [player] = build([{ ...evidence, points: bad }]).players;
    assert.equal(player.analytics.seasonTotals.points, undefined);
  }
  const [zeroPlayer] = build([{ ...evidence, points: "0", total_rebounds: null, rebounds: 50 }]).players;
  assert.equal(zeroPlayer.analytics.seasonTotals.points, 0);
  assert.equal(zeroPlayer.analytics.seasonTotals.totalRebounds, undefined, "null canonical count cannot borrow an alias");
  assert.equal(build([{ ...evidence, minutes_played: 0 }]).source.analytics.seasonEvidencePlayers, 0);
  assert.throws(() => build([{ ...evidence, season_phase: undefined }]), /phase explicitly/);
  assert.throws(() => build([{ ...evidence, minutes_played: null }, evidence]), /Duplicate season-wide/);
});

test("optional season-reader errors and invalid payloads fall back without losing a valid team pool", async () => {
  const originalDJ = globalThis.DJ;
  const evidence = { player_id: "edwaran01", season_end_year: 2025,
    season_phase: "regular", games_played: 82, minutes_played: 2460, points: 1600 };
  try {
    for (const [payload, status] of [
      [null, "invalid-response"],
      [[{ ...evidence, season_end_year: 2024 }], "invalid-response"],
      [[{ ...evidence, season_phase: undefined }], "invalid-response"],
      [[evidence, evidence], "invalid-response"],
      [[], "no-matching-rows"],
      [new Error("Temporary read error"), "temporarily-unavailable"],
    ]) {
      globalThis.DJ = { remoteCatalog: {
        async listNbaTeamSeasonPlayers() { return [savedRow()]; },
        async listNbaPlayerSeasonEvidence() {
          if (payload instanceof Error) throw payload;
          return payload;
        },
      } };
      const dataset = await fetchSupabaseNbaTeamDataset({ team: "MIN", season: 2025, seasonPhase: "regular" });
      assert.equal(dataset.players.length, 1);
      assert.equal(dataset.source.analytics.seasonEvidencePlayers, 0);
      assert.equal(dataset.source.analytics.seasonEvidenceStatus, status);
      assert.equal(dataset.players[0].analytics.seasonTotals, undefined);
    }
  } finally {
    if (originalDJ === undefined) delete globalThis.DJ;
    else globalThis.DJ = originalDJ;
  }
});

test("drops malformed optional fan analytics values without rejecting a valid legacy row", () => {
  const dataset = createSupabaseNbaTeamDataset([savedRow({
    team_total_minutes: -1,
    estimated_team_possessions: "not-a-number",
    league_points_per_36: -9,
    league_efg_pct: "invalid",
    advanced_metrics: ["not", "a", "metric-map"],
    postseason_available: "true",
  })], {
    team: "MIN",
    season: 2025,
    seasonPhase: "regular",
  });

  const [player] = dataset.players;
  assert.equal(player.points, 2177 / 79);
  assert.equal(player.analytics.teamTotalMinutes, null);
  assert.equal(player.analytics.estimatedTeamPossessions, null);
  assert.equal(player.analytics.leaguePer36.points, null);
  assert.equal(player.analytics.leaguePer36.efgPct, null);
  assert.deepEqual(player.analytics.advanced, {});
  assert.equal(player.analytics.postseasonAvailable, false);
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

test("loads optional season evidence through the shared reader when it becomes available", async () => {
  const originalDJ = globalThis.DJ;
  const calls = [];
  globalThis.DJ = {
    remoteCatalog: {
      async listNbaTeamSeasonPlayers(options) {
        calls.push(["team", options]);
        return [savedRow({ games_played: 4, games_started: 4, minutes_played: 120 })];
      },
      async listNbaPlayerSeasonEvidence(options) {
        calls.push(["season", options]);
        return [{
          player_id: "edwaran01",
          season_end_year: 2025,
          season_phase: "regular",
          games_played: 82,
          minutes_played: 2460,
          points: 1690,
        }];
      },
    },
  };

  try {
    const dataset = await fetchSupabaseNbaTeamDataset({
      team: "MIN",
      season: 2025,
      seasonPhase: "regular",
      force: true,
    });
    assert.equal(dataset.players[0].analytics.seasonTotals.games, 82);
    assert.equal(dataset.source.analytics.seasonEvidenceStatus, "available");
    assert.deepEqual(calls, [
      ["team", {
        teamCode: "MIN",
        seasonEndYear: 2025,
        seasonPhase: "regular",
        force: true,
      }],
      ["season", {
        playerIds: ["edwaran01"],
        seasonEndYear: 2025,
        seasonPhase: "regular",
        force: true,
      }],
    ]);
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
