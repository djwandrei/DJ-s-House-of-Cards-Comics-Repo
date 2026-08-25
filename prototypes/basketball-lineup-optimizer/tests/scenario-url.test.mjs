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
    rotationMinutePlan: "historicalAware",
    rotationHistoricalAllocationStyle: "preserveWorkload",
    rotationMinuteFlexibility: 8,
    rotationRateStability: "sampleAdjusted",
    rotationPositionMinuteRequirements: { G: 120, F: 96, C: 24 },
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
  assert.equal(scenario.rotationMinutePlan, "historicalAware");
  assert.equal(scenario.rotationHistoricalAllocationStyle, "preserveWorkload");
  assert.equal(scenario.rotationMinuteFlexibility, 8);
  assert.equal(scenario.rotationRateStability, "sampleAdjusted");
  assert.deepEqual(scenario.rotationPositionMinuteRequirements, { G: 120, F: 96, C: 24 });
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

test("scenario URL encoder omits incomplete role-minute profiles", () => {
  const query = encodeScenarioQuery({
    mode: "rotation",
    rotationPositionMinuteRequirements: { G: 240 },
  });
  const params = new URLSearchParams(query);
  const { scenario, warnings } = decodeScenarioQuery(query);

  assert.equal(params.has("roleMinutes"), false);
  assert.equal(scenario.rotationPositionMinuteRequirements, undefined);
  assert.deepEqual(warnings, []);
});

test("scenario URL codec rejects assumptions the visible controls cannot represent", () => {
  const encoded = encodeScenarioQuery({
    mode: "rotation",
    rotationMinuteFlexibility: 7,
    rotationHistoricalAllocationStyle: "unsupported-style",
    rotationPositionMinuteRequirements: { G: 80, F: 80, C: 80 },
  });
  const encodedParams = new URLSearchParams(encoded);
  assert.equal(encodedParams.has("minuteFlex"), false);
  assert.equal(encodedParams.has("minuteStyle"), false);
  assert.equal(encodedParams.has("roleMinutes"), false);

  const { scenario, warnings } = decodeScenarioQuery("?v=1&mode=rotation&minuteFlex=7&minuteStyle=unsupported-style&roleMinutes=g%3A80%2Cf%3A80%2Cc%3A80");
  assert.equal(scenario.rotationMinuteFlexibility, undefined);
  assert.equal(scenario.rotationHistoricalAllocationStyle, undefined);
  assert.equal(scenario.rotationPositionMinuteRequirements, undefined);
  assert.equal(warnings.length, 3);
});

test("unsupported shared-link versions are not partially applied", () => {
  const { scenario, warnings } = decodeScenarioQuery("?v=999&team=MIN&season=2026");
  assert.equal(scenario, null);
  assert.match(warnings[0], /unsupported/i);
});
