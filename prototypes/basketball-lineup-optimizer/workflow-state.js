// Presentation and draft state only. The existing Worker remains the authority
// for exact feasibility, scoring, and result construction.
export const WORKFLOW_STEPS = Object.freeze([
  { id: "team", label: "Team & season", title: "Choose your team.", description: "Start with a historical roster. Load a team-season, or try the course demo." },
  { id: "plan", label: "Game plan", title: "Call the game plan.", description: "Build a starting five or a full rotation. Decide what your group should do best." },
  { id: "players", label: "Your players", title: "Make your roster calls.", description: "Have a must-pick player? Lock them in. Exclude anyone you want to leave out—or let the Lab choose." },
  { id: "rules", label: "Set the rules", title: "Set the boundaries.", description: "Keep the recommended settings or open Detailed to tailor eligibility, court roles, and hard limits." },
  { id: "review", label: "Review & build", title: "Ready to draw it up?", description: "Check your game-plan ticket. You can edit any section before the exact search starts." },
]);

import { resolveScoutObjectiveWeights } from "./scout-impact.js?v=__LINEUP_LAB_ASSET_VERSION__";

export const WORKFLOW_FIELDS = Object.freeze({
  plan: ["modeInput", "sizeInput", "modelModeInput", "scoutObjectiveInput", "scoutOffenseWeightInput", "scoutDefenseWeightInput"],
  rules: ["minGuardsInput", "minForwardsInput", "minCentersInput", "positionFlexibilityInput", "minGamesInput", "minMinutesInput", "minPointsInput", "minReboundsInput", "minAssistsInput", "minStealsInput", "minBlocksInput", "maxTurnoversInput", "rotationMinInput", "rotationMaxInput", "rotationMinutePlanInput", "rotationFlexibilityInput", "rotationAllocationStyleInput", "rotationScoringBasisInput", "rotationRateStabilityInput", "rotationPositionProfileInput", "projectionRiskInput", "roleBalanceInput", "alternativesInput", "analyticsViewInput"],
});
export const DRAFT_KEY = "djhc-lineup-lab-workflow-v1";
const FIELD_IDS = new Set(Object.values(WORKFLOW_FIELDS).flat());
const FAMILIES = ["scoring", "spacing", "creation", "rebounding", "perimeterDefense", "interiorDefense"];
const WEIGHTS = ["points", "efgPct", "threePct", "rebounds", "assists", "steals", "blocks", "ballSecurity", "offensiveImpact", "defensiveImpact"];
const safeNumbers = (value, keys, max = 100) => Object.fromEntries(keys.filter(key => Number.isFinite(value?.[key]) && value[key] >= 0 && value[key] <= max).map(key => [key, value[key]]));
const safeIds = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === "string" && id.length <= 120))].slice(0, 200) : [];
const safeFields = value => Object.fromEntries(Object.entries(value || {}).filter(([key, entry]) => FIELD_IDS.has(key) && typeof entry === "string" && entry.length < 100));

export function sanitizeDraftForm(form) {
  if (!form || !["live", "demo"].includes(form.source?.kind)) return null;
  const source = { kind: form.source.kind };
  if (source.kind === "live") {
    if (!/^[A-Z0-9]{2,4}$/.test(form.source.team) || !Number.isInteger(form.source.season)
      || form.source.season < 1980 || form.source.season > 2100 || !["regular", "playoffs"].includes(form.source.phase)) return null;
    Object.assign(source, { team: form.source.team, season: form.source.season, phase: form.source.phase });
  }
  const sanitizeSettings = settings => ({
    fields: safeFields(settings?.fields),
    activePreset: ["balanced", "offense", "defense", "shooting", "playmaking", "rebounding", "custom"].includes(settings?.activePreset) ? settings.activePreset : "balanced",
    familyWeights: safeNumbers(settings?.familyWeights, FAMILIES),
    // Family contributions can combine above 100; keep the fractional/raw
    // preference map exactly as the URL/solver sees it rather than dropping
    // large components during local draft restoration.
    weights: safeNumbers(settings?.weights, WEIGHTS, 10000),
    analyticsView: ["perGame", "per36", "per100Estimated", "eraRelative"].includes(settings?.analyticsView) ? settings.analyticsView : "perGame",
  });
  const settings = sanitizeSettings(form);
  return {
    ...settings, source,
    experienceMode: form.experienceMode === "detailed" ? "detailed" : "simple",
    lockedIds: safeIds(form.lockedIds), excludedIds: safeIds(form.excludedIds),
    offensiveResponsibilities: safeNumbers(form.offensiveResponsibilities, safeIds(Object.keys(form.offensiveResponsibilities || {})), 1),
    // Store only whitelisted UI preferences, never private Scout evidence,
    // player datasets, auth/session information, or calculated results.
    detailedSettings: form.detailedSettings ? {
      ...sanitizeSettings(form.detailedSettings),
      simplePresetAtEntry: String(form.detailedSettings.simplePresetAtEntry || "").slice(0, 30),
    } : null,
  };
}

export function readWorkflowDraft(storage) {
  try {
    const raw = storage.getItem(DRAFT_KEY);
    if (!raw || raw.length > 64000) return null;
    const saved = JSON.parse(raw);
    const form = sanitizeDraftForm(saved.form);
    if (saved.version !== 1 || !form) return null;
    return { form, step: WORKFLOW_STEPS.some(step => step.id === saved.step) ? saved.step : "review",
      furthest: Math.max(0, Math.min(4, Number.isInteger(saved.furthest) ? saved.furthest : 0)) };
  } catch { return null; }
}

export function saveWorkflowDraft(storage, state, form) {
  try {
    const safeForm = sanitizeDraftForm(form);
    if (!safeForm) { storage.removeItem(DRAFT_KEY); return false; }
    storage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, step: state.current, furthest: state.furthest, form: safeForm }));
    return true;
  } catch { return false; }
}

export function resolveWorkflowStep(requested, furthest, hasResult = false) {
  if (requested === "results" && hasResult) return "results";
  const index = WORKFLOW_STEPS.findIndex(step => step.id === requested);
  return WORKFLOW_STEPS[Math.max(0, Math.min(index < 0 ? 0 : index, furthest, 4))].id;
}

export function validateWorkflow({ datasetReady, datasetMatches, loading, config, players = [], invalidFields = [], detailed = false }) {
  const errors = [];
  const add = (step, field, message) => errors.push({ step, field, message });
  if (!datasetReady || loading) add("team", "loadLiveDataButton", loading ? "Wait for the roster to finish loading." : "Load a team-season or use the course demo to begin.");
  else if (!datasetMatches) add("team", "loadLiveDataButton", "Your selectors describe a different roster. Load that team and season before continuing.");
  for (const field of invalidFields) add(field.step, field.id, field.message);
  if (!config) return errors;
  const { mode, size, weights = {}, lockedIds = [], excludedIds = [], positionMinimums = {}, rotationOptions = {} } = config;
  if ((mode === "lineup" && size !== 5) || (mode === "rotation" && (!Number.isInteger(size) || size < 8 || size > 12))) {
    add("plan", "sizeInput", "Choose 5 players for a starting five, or 8–12 for a full rotation.");
  }
  if (config.modelMode !== "scout" && !Object.values(weights).some(value => value > 0)) add("plan", "weightGrid", "Give at least one game-plan priority a value above zero.");
  if (config.modelMode === "scout") {
    try { resolveScoutObjectiveWeights(config.scoutObjectiveWeights, config.scoutObjective ?? "balanced"); }
    catch (error) { add("plan", config.scoutObjective === "custom" ? "scoutOffenseWeightInput" : "scoutObjectiveInput", error.message); }
  }
  const roleCount = Object.values(positionMinimums).reduce((sum, n) => sum + n, 0);
  if (roleCount > size) add("rules", "minGuardsInput", `${roleCount} required court-role slots cannot fit into ${size} players. Lower the role minimums or increase the rotation size in Game plan.`);
  if (mode === "rotation") {
    const { minMinutes: min, maxMinutes: max } = rotationOptions;
    if (min > max) add("rules", "rotationMaxInput", "Maximum minutes must be at least the minimum minutes.");
    else if (min * size > 240 || max * size < 240) add("rules", "rotationMaxInput", `${size} players at ${min}–${max} minutes cannot cover exactly 240. Adjust these limits or the roster size.`);
  }
  if (lockedIds.length > size) add("players", "activeSelectionTray", `${lockedIds.length} locks cannot fit into ${size} spots. Unlock a player or change the group size.`);
  if (!datasetReady) return errors;
  const eligible = players.filter(p => p.games >= config.minGames && p.minutes >= config.minMinutes);
  const available = eligible.filter(p => !excludedIds.includes(p.id));
  const unavailableLocks = lockedIds.filter(id => !available.some(p => p.id === id));
  if (unavailableLocks.length) add("players", "activeSelectionTray", "A locked player is excluded or below the sample filters. Unlock that player, remove the exclusion, or lower the eligibility filters in Rules.");
  if (available.length < size) add("rules", "minGamesInput", `Only ${available.length} eligible players remain for ${size} spots. Lower the sample filters, restore excluded players, or choose a smaller group.`);
  // Necessary distinct-role coverage checks (Hall subsets); the exact Worker
  // still proves the full selected group and every regulation minute.
  const roles = ["G", "F", "C"];
  for (let mask = 1; mask < 8; mask += 1) {
    const subset = roles.filter((_, i) => mask & (1 << i));
    const needed = subset.reduce((sum, role) => sum + (positionMinimums[role] || 0), 0);
    const count = available.filter(p => p.positions?.some(role => subset.includes(role))).length;
    if (needed > count) {
      add("rules", "positionFlexibilityInput", `The eligible pool has ${count} distinct ${subset.join("/")} players for ${needed} required slots. Relax the role requirements, position policy, or sample filters.`);
      break;
    }
  }
  // Production feasibility belongs to the Worker's evidence-aware bounds and
  // exact constraint layer, even for a starting five. The visible per-game
  // column can be team-only legacy context while the solver uses independently
  // reconciled, metric-specific all-team games. A raw UI sum is not an upper
  // bound on that quantity. Do not reject a feasible request before it is solved
  // or turn an unknown stat into a zero just to construct a cheap pre-check.
  return errors;
}
