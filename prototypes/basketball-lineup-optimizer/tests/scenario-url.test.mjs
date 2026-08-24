import assert from "node:assert/strict";
import test from "node:test";
import { decodeScenarioQuery, encodeScenarioQuery, SCENARIO_URL_VERSION } from "../scenario-url.js";

test("scenario URL codec round-trips valid optimizer and analytics assumptions", () => {
  const query = encodeScenarioQuery({
    team: "min",
    season: 2026,
    phase: "regular",
    mode: "rotation",
    size: 9,
    alternatives: 5,
    preset: "defense",
    weights: { points: 4, blocks: 18, ballSecurity: 7 },
    minGames: 20,
    minMinutes: 8.5,
    positionMinimums: { G: 3, F: 3, C: 2 },
    statMinimums: { rebounds: 48, blocks: 5 },
    maxTurnovers: 14.5,
    rotationMin: 8,
    rotationMax: 40,
    analyticsView: "eraRelative",
    rotationScoreBasis: "per36",
    lockedIds: ["edwaran01"],
    excludedIds: ["sample-player"],
  });
  const { scenario, warnings } = decodeScenarioQuery(query);
  assert.equal(scenario.version, SCENARIO_URL_VERSION);
  assert.equal(scenario.team, "MIN");
  assert.equal(scenario.season, 2026);
  assert.equal(scenario.weights.blocks, 18);
  assert.equal(scenario.statMinimums.rebounds, 48);
  assert.equal(scenario.positionMinimums.C, 2);
  assert.equal(scenario.analyticsView, "eraRelative");
  assert.equal(scenario.rotationScoreBasis, "per36");
  assert.deepEqual(scenario.lockedIds, ["edwaran01"]);
  assert.equal(warnings.length, 0);
});

test("scenario URL decoder ignores malformed, unsafe, and unsupported entries", () => {
  const { scenario, warnings } = decodeScenarioQuery(
    "?v=1&team=%3Cscript%3E&season=nope&mode=other&pos=g%3A99&lock=ok,not%20ok&view=magic&w=p%3A200,z%3A2",
  );
  assert.equal(scenario.team, undefined);
  assert.equal(scenario.season, undefined);
  assert.equal(scenario.mode, undefined);
  assert.deepEqual(scenario.positionMinimums, {});
  assert.deepEqual(scenario.lockedIds, ["ok"]);
  assert.deepEqual(scenario.weights, {});
  assert.ok(warnings.length >= 5);
});

test("unsupported shared-link versions are not partially applied", () => {
  const { scenario, warnings } = decodeScenarioQuery("?v=999&team=MIN&season=2026");
  assert.equal(scenario, null);
  assert.match(warnings[0], /unsupported/i);
});
