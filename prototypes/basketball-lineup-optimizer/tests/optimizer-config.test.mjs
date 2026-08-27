import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FAMILY_PRESETS,
  DEFAULT_PRESETS,
  OBJECTIVE_FAMILY_DEFINITIONS,
  weightsFromSkillFamilies,
} from "../optimizer-config.js";

test("skill families translate into the documented exact-solver metrics", () => {
  assert.deepEqual(weightsFromSkillFamilies({
    scoring: 100,
    spacing: 0,
    creation: 0,
    rebounding: 0,
    perimeterDefense: 0,
    interiorDefense: 0,
  }), {
    points: 55,
    efgPct: 30,
    threePct: 0,
    rebounds: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    ballSecurity: 0,
    offensiveImpact: 15,
    defensiveImpact: 0,
  });

  assert.deepEqual(weightsFromSkillFamilies({
    scoring: 0,
    spacing: 0,
    creation: 0,
    rebounding: 0,
    perimeterDefense: 100,
    interiorDefense: 100,
  }), {
    points: 0,
    efgPct: 0,
    threePct: 0,
    rebounds: 30,
    assists: 0,
    steals: 75,
    blocks: 55,
    ballSecurity: 0,
    offensiveImpact: 0,
    defensiveImpact: 40,
  });
});

test("offense and defense presets remain explicit combinations of the visible families", () => {
  assert.equal(DEFAULT_FAMILY_PRESETS.scoring.scoring > DEFAULT_FAMILY_PRESETS.defense.scoring, true);
  assert.equal(
    DEFAULT_FAMILY_PRESETS.defense.perimeterDefense > DEFAULT_FAMILY_PRESETS.scoring.perimeterDefense,
    true,
  );
  assert.deepEqual(
    DEFAULT_PRESETS.scoring,
    weightsFromSkillFamilies(DEFAULT_FAMILY_PRESETS.scoring),
  );
  assert.deepEqual(
    DEFAULT_PRESETS.defense,
    weightsFromSkillFamilies(DEFAULT_FAMILY_PRESETS.defense),
  );
  for (const definition of Object.values(OBJECTIVE_FAMILY_DEFINITIONS)) {
    const coefficientTotal = Object.values(definition.metrics)
      .reduce((total, coefficient) => total + coefficient, 0);
    assert.ok(Math.abs(coefficientTotal - 1) < 1e-12);
  }
});
