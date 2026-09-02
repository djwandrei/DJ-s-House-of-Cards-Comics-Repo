import test from "node:test";
import assert from "node:assert/strict";

import { planRotationUnits } from "../rotation-unit-planner.js";

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

