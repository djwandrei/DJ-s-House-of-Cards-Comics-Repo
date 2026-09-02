import test from "node:test";
import assert from "node:assert/strict";

import { scoreLineupRoleFit } from "../lineup-role-model.js";

const roles = [
  "primaryCreator",
  "floorSpacer",
  "connector",
  "efficientFinisher",
  "pointOfAttack",
  "rimProtector",
  "rebounder",
];

function signals(primaryRole) {
  return Object.fromEntries(roles.map((role) => [role, role === primaryRole ? 1 : 0.3]));
}

test("complementary roles beat redundant roles at equal individual value", () => {
  const model = {
    signalsById: new Map([
      ["a", signals("primaryCreator")],
      ["b", signals("floorSpacer")],
      ["c", signals("connector")],
      ["d", signals("pointOfAttack")],
      ["e", signals("rimProtector")],
      ["r1", signals("primaryCreator")],
      ["r2", signals("primaryCreator")],
      ["r3", signals("primaryCreator")],
      ["r4", signals("primaryCreator")],
    ]),
  };
  const balanced = scoreLineupRoleFit(
    ["a", "b", "c", "d", "e"].map((id) => ({ id })),
    model,
    { balance: "recommended" },
  );
  const redundant = scoreLineupRoleFit(
    ["a", "r1", "r2", "r3", "r4"].map((id) => ({ id })),
    model,
    { balance: "recommended" },
  );
  assert.ok(balanced.fitIndex > redundant.fitIndex);
  assert.ok(balanced.adjustmentPoints > redundant.adjustmentPoints);
});

test("off leaves role coverage explanatory and applies zero ranking points", () => {
  const model = { signalsById: new Map([["a", signals("primaryCreator")]]) };
  const result = scoreLineupRoleFit([{ id: "a" }], model, { balance: "off" });
  assert.equal(result.applied, false);
  assert.equal(result.adjustmentPoints, 0);
});

