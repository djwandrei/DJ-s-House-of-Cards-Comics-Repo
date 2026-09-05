import test from "node:test";
import assert from "node:assert/strict";

import { planRotationUnits, improveUnitResponsibility } from "../rotation-unit-planner.js";

function rotationFromRows(rows) {
  return {
    byId: Object.fromEntries(rows.map((row) => [row.id, row.G + row.F + row.C])),
    positionMinutes: {
      enforced: true,
      byPlayer: Object.fromEntries(rows.map((row) => [row.id, { G: row.G, F: row.F, C: row.C }])),
    },
  };
}

function assertExactPlan(rows, result) {
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.frames.length, 48);
  assert.equal(result.stints.reduce((sum, stint) => sum + stint.duration, 0), 48);
  for (const frame of result.frames) {
    assert.equal(frame.playerIds.length, 5);
    assert.equal(new Set(frame.playerIds).size, 5);
  }
  const frameCounts = Object.fromEntries(rows.map((row) => [row.id, 0]));
  const roleCounts = Object.fromEntries(rows.map((row) => [row.id, { G: 0, F: 0, C: 0 }]));
  for (const frame of result.frames) {
    for (const role of ["G", "F", "C"]) {
      for (const id of frame.roles[role]) {
        frameCounts[id] += 1;
        roleCounts[id][role] += 1;
      }
    }
  }
  for (const row of rows) {
    assert.equal(frameCounts[row.id], row.G + row.F + row.C);
    assert.deepEqual(roleCounts[row.id], { G: row.G, F: row.F, C: row.C });
  }
}

test("builds a deterministic exact traditional 48-minute unit plan", () => {
  const rows = [
    { id: "g1", G: 40, F: 0, C: 0 }, { id: "g2", G: 32, F: 0, C: 0 },
    { id: "g3", G: 24, F: 0, C: 0 }, { id: "f1", G: 0, F: 40, C: 0 },
    { id: "f2", G: 0, F: 32, C: 0 }, { id: "f3", G: 0, F: 24, C: 0 },
    { id: "c1", G: 0, F: 0, C: 32 }, { id: "c2", G: 0, F: 0, C: 16 },
  ];
  const rotation = rotationFromRows(rows);
  const first = planRotationUnits(rows, rotation);
  const second = planRotationUnits(rows, rotation);
  assertExactPlan(rows, first);
  assert.deepEqual(first.frames, second.frames);
});

test("supports a nontraditional custom position-minute mix", () => {
  const rows = [
    { id: "a", G: 38, F: 0, C: 0 }, { id: "b", G: 38, F: 0, C: 0 },
    { id: "c", G: 39, F: 0, C: 0 }, { id: "d", G: 0, F: 34, C: 0 },
    { id: "e", G: 0, F: 34, C: 0 }, { id: "f", G: 0, F: 24, C: 0 },
    { id: "g", G: 0, F: 0, C: 17 }, { id: "h", G: 0, F: 0, C: 16 },
  ];
  const result = planRotationUnits(rows, rotationFromRows(rows));
  assertExactPlan(rows, result);
  assert.deepEqual(
    Object.fromEntries(["G", "F", "C"].map((role) => [
      role,
      result.frames.reduce((sum, frame) => sum + frame.roles[role].length, 0),
    ])),
    { G: 115, F: 92, C: 33 },
  );
});

test("staggering creators improves sharing without changing any player or position minutes", () => {
  const rows = [
    { id: "g1", G: 40, F: 0, C: 0 }, { id: "g2", G: 32, F: 0, C: 0 },
    { id: "g3", G: 24, F: 0, C: 0 }, { id: "f1", G: 0, F: 40, C: 0 },
    { id: "f2", G: 0, F: 32, C: 0 }, { id: "f3", G: 0, F: 24, C: 0 },
    { id: "c1", G: 0, F: 0, C: 32 }, { id: "c2", G: 0, F: 0, C: 16 },
  ];
  // Several deliberately varied responsibility profiles exercise the same
  // schedule. These are mathematical fixtures, not historical NBA evidence.
  for (let seed = 1; seed <= 6; seed++) {
    const usageById = Object.fromEntries(rows.map((row, i) => [row.id, ((i * 7 + seed * 3) % 31 + 5) / 100]));
    const plan = planRotationUnits(rows, rotationFromRows(rows), { usageById });
    assertExactPlan(rows, plan);
    const sharing = plan.sharingOptimization;
    assert.equal(sharing.applied, true);
    assert.ok(sharing.after <= sharing.before + 1e-10);
    assert.ok(sharing.after >= sharing.relaxedLowerBound - 1e-10);
    assert.deepEqual(plan.frames, planRotationUnits(rows, rotationFromRows(rows), { usageById }).frames);
    // A second descent must make no exchange: the advertised certificate is
    // local pair-exchange optimality (or the attained relaxed lower bound).
    assert.equal(improveUnitResponsibility(structuredClone(plan.frames), usageById).exchanges, 0);
  }
});

test("a known two-unit imbalance reaches the objective lower bound", () => {
  const frame = (minute, g, f) => ({ minute, roles: { G: [g], F: [f, "x", "y"], C: ["c"] }, playerIds: [g, f, "x", "y", "c"] });
  const frames = [frame(1, "gHigh", "fHigh"), frame(2, "gLow", "fLow")];
  const usageById = { gHigh: .3, gLow: .1, fHigh: .3, fLow: .1, x: .2, y: .2, c: .2 };
  const sharing = improveUnitResponsibility(frames, usageById);
  assert.equal(sharing.exchanges, 1);
  assert.ok(sharing.after < sharing.before);
  assert.ok(sharing.after < 1e-12);
  assert.equal(sharing.optimality, "relaxed-bound-attained");
  assert.deepEqual(frames.map(row => [...row.playerIds].sort()),
    [["c", "fHigh", "gLow", "x", "y"], ["c", "fLow", "gHigh", "x", "y"]]);
});

test("missing, malformed, or duplicate identity evidence never produces invented sharing effects", () => {
  const frames = [{ minute: 1, roles: { G: ["g1", "g2"], F: ["f1", "f2"], C: ["c"] }, playerIds: ["g1", "g2", "f1", "f2", "c"] }];
  const complete = { g1: .2, g2: .2, f1: .2, f2: .2, c: .2 };
  for (const missing of [undefined, null, false, "0.2", -.1, 1.01, NaN, Infinity]) {
    const copy = structuredClone(frames);
    assert.equal(improveUnitResponsibility(copy, { ...complete, c: missing }).applied, false);
    assert.deepEqual(copy, frames);
  }
  assert.equal(planRotationUnits([{ id: "same" }, { id: "same" }], {}).ok, false);
});
