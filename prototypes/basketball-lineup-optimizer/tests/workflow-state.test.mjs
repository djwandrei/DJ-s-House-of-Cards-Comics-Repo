import assert from "node:assert/strict";
import test from "node:test";
import { WORKFLOW_STEPS, DRAFT_KEY, readWorkflowDraft, sanitizeDraftForm, saveWorkflowDraft, resolveWorkflowStep, validateWorkflow } from "../workflow-state.js";

const config = { mode: "lineup", size: 5, modelMode: "historical", weights: { points: 1 }, lockedIds: [], excludedIds: [], minGames: 0, minMinutes: 0, positionMinimums: { G: 2, F: 2, C: 1 }, statMinimums: {} };
const players = ["G", "G", "F", "F", "C", "G"].map((role, i) => ({ id: String(i), games: 50, minutes: 25, positions: [role], points: 10, turnovers: 2 }));
const validate = patch => validateWorkflow({ datasetReady: true, datasetMatches: true, config, players, ...patch });
const form = { source: { kind: "demo" }, fields: { modeInput: "lineup", sizeInput: "5" }, familyWeights: { scoring: 50 }, weights: { points: 50 }, lockedIds: ["one"], excludedIds: [], experienceMode: "detailed" };

test("workflow has one centralized, ordered decision sequence and gates deep links", () => {
  assert.deepEqual(WORKFLOW_STEPS.map(step => step.id), ["team", "plan", "players", "rules", "review"]);
  assert.equal(resolveWorkflowStep("review", 0), "team");
  assert.equal(resolveWorkflowStep("rules", 2), "players");
  assert.equal(resolveWorkflowStep("results", 4), "team");
  assert.equal(resolveWorkflowStep("results", 4, true), "results");
  assert.equal(resolveWorkflowStep("team", 4), "team");
});

test("ordinary setup passes and structural conflicts identify an editable step", () => {
  assert.deepEqual(validate(), []);
  assert.equal(validate({ datasetMatches: false })[0].step, "team");
  assert.equal(validate({ loading: true })[0].step, "team");
  assert.ok(validate({ config: { ...config, weights: {} } }).some(error => error.step === "plan"));
  assert.ok(validate({ config: { ...config, size: 3 } }).some(error => error.field === "sizeInput"));
  assert.ok(validate({ config: { ...config, positionMinimums: { G: 6 } } }).some(error => error.message.includes("cannot fit")));
  assert.ok(validate({ config: { ...config, lockedIds: ["99"] } }).some(error => error.step === "players"));
  assert.ok(validate({ config: { ...config, excludedIds: ["0", "1"] } }).some(error => error.message.includes("Only 4")));
});

test("minute bounds and available distinct role slots are checked before submission", () => {
  assert.ok(validate({ config: { ...config, mode: "rotation", size: 9, rotationOptions: { minMinutes: 8, maxMinutes: 20 } } }).some(error => error.message.includes("exactly 240")));
  assert.ok(validate({ config: { ...config, mode: "rotation", size: 9, rotationOptions: { minMinutes: 30, maxMinutes: 20 } } }).some(error => error.message.includes("at least")));
  const sharedRolePool = [{ ...players[0], positions: ["G", "F"] }, ...players.slice(1).map(p => ({ ...p, positions: ["C"] }))];
  assert.ok(validate({ players: sharedRolePool }).some(error => error.message.includes("distinct")));
});

test("production feasibility is deferred to the evidence-aware solver rather than legacy display columns", () => {
  assert.ok(!validate({ detailed: true, config: { ...config, statMinimums: { points: 60 } } }).some(error => error.field === "minPointsInput"));
  assert.ok(!validate({ detailed: true, config: { ...config, mode: "rotation", size: 9, rotationOptions: { minMinutes: 8, maxMinutes: 40 }, statMinimums: { points: 60 } } }).some(error => error.field === "minPointsInput"));
  const unknownDisplay = players.map(player => ({ ...player, points: null }));
  assert.ok(!validate({ players: unknownDisplay, detailed: true, config: { ...config, statMinimums: { points: 1 } } }).some(error => error.field === "minPointsInput"));
});

test("Scout priorities validate independently of dormant Historical priorities", () => {
  const request = { ...config, modelMode: "scout", weights: {}, scoutObjective: "custom" };
  assert.deepEqual(validate({ config: { ...request, scoutObjectiveWeights: { offense: .3, defense: .1 } } }), []);
  for (const weights of [undefined, { offense: 0, defense: 0 }, { offense: NaN, defense: 1 }]) {
    assert.ok(validate({ config: { ...request, scoutObjectiveWeights: weights } }).some(error => error.field === "scoutOffenseWeightInput"));
  }
  const saved = sanitizeDraftForm({ ...form, fields: { modelModeInput: "scout", scoutObjectiveInput: "custom", scoutOffenseWeightInput: "0.3", scoutDefenseWeightInput: "0" } });
  assert.equal(saved.fields.scoutOffenseWeightInput, "0.3");
  assert.equal(saved.fields.scoutDefenseWeightInput, "0");
});

test("draft persistence whitelists preferences and never stores Scout, auth, or player evidence", () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  assert.equal(saveWorkflowDraft(storage, { current: "rules", furthest: 3 }, { ...form, scoutEvidence: { private: true }, token: "not-saved", dataset: players, fields: { ...form.fields, access_token: "not-saved" } }), true);
  const saved = readWorkflowDraft(storage);
  assert.equal(saved.step, "rules");
  assert.deepEqual(saved.form.lockedIds, ["one"]);
  assert.doesNotMatch(memory.get(DRAFT_KEY), /not-saved|scoutEvidence|dataset|private/);
  assert.equal(saveWorkflowDraft(storage, { current: "team" }, { ...form, source: { kind: "csv" } }), false);
  assert.equal(memory.has(DRAFT_KEY), false);
});

test("damaged drafts and storage-denied browsers fail safely", () => {
  assert.equal(readWorkflowDraft({ getItem: () => "{broken" }), null);
  assert.equal(readWorkflowDraft(undefined), null);
  assert.equal(saveWorkflowDraft(undefined, {}, form), false);
  assert.equal(sanitizeDraftForm({ ...form, source: { kind: "live", team: "../../", season: 2022, phase: "regular" } }), null);
  assert.ok(sanitizeDraftForm({ ...form, source: { kind: "live", team: "MIN", season: 2022, phase: "regular" } }));
});
