import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
// Exercise the real delegated event handler without loading a fake browser,
// Supabase credentials, or the entire application. The branch exits before
// checkbox/watchlist helpers; browser QA separately covers actual event wiring.
const handler = app.match(/function handlePlayerControl\(event\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(handler, "the production player-control handler must remain testable");

test("usage input reaches scenario state before blur and invalidates the prior result", () => {
  const state = { offensiveResponsibilities: {} };
  let invalidations = 0, reports = 0;
  const context = vm.createContext({ state, markScenarioChanged() { invalidations++; } });
  vm.runInContext(handler, context);
  const control = { dataset: { action: "usage", playerId: "center" }, value: "30", disabled: false,
    checkValidity: () => true, reportValidity: () => reports++ };
  const fire = type => context.handlePlayerControl({ type, target: { closest: () => control } });
  fire("input");
  assert.equal(state.offensiveResponsibilities.center, .3);
  assert.equal(invalidations, 1);
  control.value = "0"; fire("input");
  assert.equal(state.offensiveResponsibilities.center, 0, "real zero is not absence");
  control.value = ""; fire("input");
  assert.equal(Object.hasOwn(state.offensiveResponsibilities, "center"), false);
  control.value = "101"; control.checkValidity = () => false; fire("input");
  assert.equal(Object.hasOwn(state.offensiveResponsibilities, "center"), false);
  assert.equal(reports, 0, "do not interrupt typing with validation popups");
  fire("change");
  assert.equal(reports, 1);
  control.value = "20"; control.checkValidity = () => true; control.disabled = true; fire("input");
  assert.equal(Object.hasOwn(state.offensiveResponsibilities, "center"), false, "Simple/lineup mode cannot apply a hidden override");
  assert.match(app, /playerTableBody\.addEventListener\("input", handlePlayerControl\)/);
});
