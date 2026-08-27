import {
  DEFAULT_MAX_EXACT_COMBINATIONS,
  DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS,
  DEFAULT_FAMILY_PRESETS,
  OBJECTIVE_FAMILY_DEFINITIONS,
  assessHistoricalPositionMinuteEvidence,
  deriveHistoricalPositionMinuteRequirements,
  skillFamiliesFromMetricWeights,
  weightsFromSkillFamilies,
} from "./optimizer-config.js?v=__LINEUP_LAB_ASSET_VERSION__";
import {
  datasetToCsv,
  normalizeDataset,
  parsePlayerCsv,
  validateDataset,
} from "./player-data.js?v=__LINEUP_LAB_ASSET_VERSION__";
import {
  fetchSupabaseNbaTeamDataset,
  listSupabaseNbaSeasons,
  listSupabaseNbaTeams,
  nbaSeasonLabel,
} from "./supabase-nba-data.js?v=__LINEUP_LAB_ASSET_VERSION__";
import {
  derivePlayerRateViews,
  explainOptimizationSelection,
  FAN_ROLE_DEFINITIONS,
} from "./fan-analytics.js?v=__LINEUP_LAB_ASSET_VERSION__";
import {
  decodeScenarioQuery,
  encodeScenarioQuery,
} from "./scenario-url.js?v=__LINEUP_LAB_ASSET_VERSION__";
import { pruneLineupLabDatasetCache } from "./lineup-cache.js?v=__LINEUP_LAB_ASSET_VERSION__";

// Keep every Lineup Lab dependency on the same reviewed release revision. The
// storefront service worker caches by full request URL, so versioned module
// requests prevent a newly deployed app shell from pairing with an old solver,
// dataset adapter, worker, or course-fixture response.
const FIXTURE_URL = "./fixtures/timberwolves-2021-22.json?v=__LINEUP_LAB_ASSET_VERSION__";
const OPTIMIZER_WORKER_URL = new URL("./optimizer-worker.js?v=__LINEUP_LAB_ASSET_VERSION__", import.meta.url);
const WATCHLIST_KEY = "djhc-lineup-lab-watchlist-v1";
const WATCHLIST_SNAPSHOTS_KEY = "djhc-lineup-lab-watchlist-snapshots-v2";
const WATCHLIST_SNAPSHOT_FIELDS = Object.freeze([
  "id",
  "name",
  "team",
  "positions",
  "age",
  "games",
  "starts",
  "minutes",
  "fgPct",
  "threePct",
  "efgPct",
  "ftPct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "points",
]);
// Bump this when the normalized live payload changes materially. In this
// release, cached team stints can be missing newly imported media and the
// reconstructed team-average/rotation summary. A new prefix makes the browser
// rebuild that source context immediately instead of waiting for the old
// 24-hour entry to expire.
const NBA_CACHE_PREFIX = "djhc-lineup-lab-bref-supabase-v5";
const NBA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NBA_CACHE_MAX_ENTRIES = 24;
const DEFAULT_TEAM_CODE = "MIN";
const DEFAULT_SEASON_PHASE = "regular";
// Lineup Lab deliberately does not use team-stint workload as a rotation
// constraint. Keep the literal in one place so an old shared link or a stale
// browser control cannot silently reactivate the legacy guardrail.
const LINEUP_LAB_ROTATION_MINUTE_PLAN = "openWhatIf";
const UI_TO_ENGINE_PRESET = Object.freeze({
  balanced: "balanced",
  defense: "defense",
  offense: "scoring",
  shooting: "shooting",
  playmaking: "playmaking",
  rebounding: "rebounding",
});
const PRESET_LABELS = Object.freeze({
  balanced: "Balanced",
  defense: "Defense",
  offense: "Offense",
  shooting: "Space the Floor",
  playmaking: "Move the Ball",
  rebounding: "Own the Glass",
  custom: "Custom Mix",
});
const METRIC_LABELS = Object.freeze({
  points: "Scoring",
  efgPct: "Effective FG%",
  threePct: "Three-point %",
  rebounds: "Rebounding",
  assists: "Playmaking",
  steals: "Steals",
  blocks: "Blocks",
  ballSecurity: "Turnovers (lower is better)",
  offensiveImpact: "Offensive impact (OBPM)",
  defensiveImpact: "Defensive impact (DBPM)",
});
const FAMILY_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(OBJECTIVE_FAMILY_DEFINITIONS).map(([family, definition]) => [
    family,
    definition.label,
  ]),
));
const COMPARE_METRICS = Object.freeze([
  ["points", "Points", false],
  ["rebounds", "Rebounds", false],
  ["assists", "Assists", false],
  ["steals", "Steals", false],
  ["blocks", "Blocks", false],
  ["efgPct", "eFG%", false],
  ["threePct", "3P%", false],
  ["turnovers", "Turnovers — lower is better", true],
]);
// Display preferences are deliberately separate from the optimizer's exact
// inputs. A fan can inspect the same selected group in several rate views
// without silently changing which group the solver selected.
const ANALYTICS_VIEW_DETAILS = Object.freeze({
  perGame: Object.freeze({
    label: "Per game",
    shortLabel: "per game",
    rateKey: "perGame",
    note: "Per-game production from the player's games with the selected team.",
  }),
  per36: Object.freeze({
    label: "Per 36 minutes",
    shortLabel: "per 36",
    rateKey: "per36",
    note: "Counting stats normalized to 36 historical minutes; shooting percentages stay unchanged.",
  }),
  per100Estimated: Object.freeze({
    label: "Per 100 estimated possessions",
    shortLabel: "per 100 estimated possessions",
    rateKey: "per100",
    note: "Uses an estimated minute-share possession denominator from team totals, not reported on-court possessions.",
  }),
  eraRelative: Object.freeze({
    label: "Era-relative per-36 index",
    shortLabel: "era-relative index",
    rateKey: "eraRelative",
    note: "100 equals the minute-weighted NBA per-36 baseline for the same season and phase.",
  }),
});
const CHART_COLORS = ["#1f2fa3", "#e51e2b", "#08775b", "#b06c00"];
const CARD_SEARCH_PATH = "/basketball-cards.html";
const ROTATION_POSITION_PROFILES = Object.freeze({
  traditional: Object.freeze({ G: 96, F: 96, C: 48 }),
  small: Object.freeze({ G: 120, F: 96, C: 24 }),
  big: Object.freeze({ G: 72, F: 120, C: 48 }),
});
const ROTATION_MINUTE_PLAN_LABELS = Object.freeze({
  historicalAware: "Recorded-minutes guardrail",
  openWhatIf: "Game-plan optimization",
});
const TRUSTED_MEDIA_HOSTS = new Set([
  "www.basketball-reference.com",
  "cdn.ssref.net",
]);
const TRUSTED_SOURCE_HOSTS = new Set(["www.basketball-reference.com"]);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  form: $("#optimizerForm"),
  simpleMode: $("#simpleModeButton"),
  detailedMode: $("#detailedModeButton"),
  playersStepNumber: $("#playersStepNumber"),
  simpleModelSummaryCopy: $("#simpleModelSummaryCopy"),
  simpleModelSummaryNote: $("#simpleModelSummaryNote"),
  playerTableBody: $("#playerTableBody"),
  playerSearch: $("#playerSearchInput"),
  poolSummary: $("#poolSummary"),
  activeSelectionTray: $("#activeSelectionTray"),
  mode: $("#modeInput"),
  size: $("#sizeInput"),
  alternatives: $("#alternativesInput"),
  rotationSettings: $("#rotationSettings"),
  minGuards: $("#minGuardsInput"),
  minForwards: $("#minForwardsInput"),
  minCenters: $("#minCentersInput"),
  minGames: $("#minGamesInput"),
  minMinutes: $("#minMinutesInput"),
  minPoints: $("#minPointsInput"),
  minRebounds: $("#minReboundsInput"),
  minAssists: $("#minAssistsInput"),
  minSteals: $("#minStealsInput"),
  minBlocks: $("#minBlocksInput"),
  maxTurnovers: $("#maxTurnoversInput"),
  rotationMin: $("#rotationMinInput"),
  rotationMax: $("#rotationMaxInput"),
  rotationMinutePlan: $("#rotationMinutePlanInput"),
  rotationFlexibility: $("#rotationFlexibilityInput"),
  rotationFlexibilityField: $("#rotationFlexibilityField"),
  rotationAllocationStyle: $("#rotationAllocationStyleInput"),
  rotationAllocationStyleField: $("#rotationAllocationStyleField"),
  rotationAllocationStyleHelp: $("#rotationAllocationStyleHelp"),
  rotationRateStability: $("#rotationRateStabilityInput"),
  rotationRateStabilityField: $("#rotationRateStabilityField"),
  rotationRateStabilityHelp: $("#rotationRateStabilityHelp"),
  rotationPositionProfile: $("#rotationPositionProfileInput"),
  positionFlexibility: $("#positionFlexibilityInput"),
  rotationMinutePlanHelp: $("#rotationMinutePlanHelp"),
  rotationEvidencePreview: $("#rotationEvidencePreview"),
  results: $("#results"),
  resultContent: $("#resultContent"),
  resultsHeading: $("#resultsHeading"),
  resultSummary: $("#resultSummary"),
  resultActions: $("#results .results__actions"),
  emptyResult: $("#emptyResult"),
  emptyResultHeading: $("#emptyResult h2"),
  emptyResultCopy: $("#emptyResult p"),
  compareContent: $("#compareContent"),
  watchlistContent: $("#watchlistContent"),
  compareCount: $("#compareCount"),
  watchlistCount: $("#watchlistCount"),
  datasetStrip: $("#datasetStrip"),
  datasetName: $("#datasetName"),
  datasetSeason: $("#datasetSeason"),
  datasetTeam: $("#datasetTeam"),
  datasetCount: $("#datasetCount"),
  teamLogo: $("#datasetTeamLogo"),
  teamLogoFallback: $("#datasetTeamLogoFallback"),
  datasetMedia: $("#datasetMedia"),
  sourceAttribution: $("#sourceAttribution"),
  liveDataPanel: $("#liveDataPanel"),
  liveTeam: $("#nbaTeamInput"),
  liveSeason: $("#nbaSeasonInput"),
  liveSeasonPhase: $("#nbaSeasonPhaseInput"),
  loadLiveData: $("#loadLiveDataButton"),
  liveDataStatus: $("#liveDataStatus"),
  importCsv: $("#importCsvButton"),
  resetDataset: $("#resetDatasetButton"),
  csvFile: $("#csvFileInput"),
  optimize: $("#optimizeButton"),
  mobileOptimize: $("#mobileOptimizeButton"),
  mobileSolveBar: $(".mobile-solve-bar"),
  mobileSolveLabel: $("#mobileSolveLabel"),
  resetScenario: $("#resetScenarioButton"),
  copyResult: $("#copyResultButton"),
  downloadResult: $("#downloadResultButton"),
  exportDataset: $("#exportDatasetButton"),
  downloadTemplate: $("#downloadTemplateButton"),
  downloadWatchlist: $("#downloadWatchlistButton"),
  solverStatus: $("#solverStatus"),
  searchScope: $("#searchScope"),
  searchScopeValue: $("#searchScopeValue"),
  resultFreshness: $("#resultFreshness"),
  runModeSummary: $("#runModeSummary"),
  runPresetSummary: $("#runPresetSummary"),
  runMinuteModelRow: $("#runMinuteModelRow"),
  runMinuteModelSummary: $("#runMinuteModelSummary"),
  runLockedSummary: $("#runLockedSummary"),
  runExcludedSummary: $("#runExcludedSummary"),
  toast: $("#toast"),
  watchlistTab: $("#watchlistTab"),
  opponentTeam: $("#opponentTeamInput"),
  loadOpponent: $("#loadOpponentButton"),
  opponentScout: $("#opponentScout"),
  opponentScoutStatus: $("#opponentScoutStatus"),
  opponentScoutSummary: $("#opponentScoutSummary"),
  weightsPanel: $("#weightsPanel"),
  weightValidation: $("#weightValidation"),
  weightShareSummary: $("#weightShareSummary"),
  analyticsPanel: $("#analyticsPanel"),
  analyticsView: $("#analyticsViewInput"),
  rotationScoringBasis: $("#rotationScoringBasisInput"),
  rotationScoringBasisField: $("#rotationScoringBasisField"),
  productionRulesLegend: $("#productionRulesLegend"),
  productionRulesHelp: $("#productionRulesHelp"),
  positionCoverageHelp: $("#positionCoverageHelp"),
  rotationMinutesHelp: $("#rotationMinutesHelp"),
  shareScenario: $("#shareScenarioButton"),
  printReport: $("#printReportButton"),
};

const decodedInitialScenario = decodeScenarioQuery(window.location.search);

const state = {
  dataset: null,
  experienceMode: decodedInitialScenario.scenario?.experience === "detailed" ? "detailed" : "simple",
  // Simple mode deliberately replaces hidden advanced settings with a known,
  // safe baseline. Keep one in-memory snapshot so returning to Detailed does
  // not silently discard a visitor's custom work; it is never persisted or
  // shared because it is only a temporary view-switch convenience.
  detailedSettingsSnapshot: null,
  activePreset: "balanced",
  // Six visible skill families are the authoring layer. `weights` remains the
  // exact eight-metric solver contract and is regenerated whenever a family
  // control changes. Keeping both makes legacy shared links backward-compatible
  // without forcing fans to understand every box-score coefficient.
  familyWeights: { ...DEFAULT_FAMILY_PRESETS.balanced },
  weights: {},
  lockedIds: new Set(),
  excludedIds: new Set(),
  compareIds: new Set(),
  watchlistIds: loadWatchlist(),
  watchlistSnapshots: loadWatchlistSnapshots(),
  lastResult: null,
  toastTimer: null,
  liveDataLoading: false,
  liveTeamOptions: [],
  loadedLiveSelection: null,
  opponentDataset: null,
  opponentStrategy: null,
  opponentWeightUndo: null,
  opponentLoading: false,
  playerMediaStatus: new Map(),
  teamLogoStatus: "unavailable",
  scenarioVersion: 0,
  optimizationWorker: null,
  optimizationReject: null,
  optimizationRunId: 0,
  activeOptimizationToken: null,
  searchScopeCanRun: false,
  recommendedMinGames: 20,
  preserveSharedMinGamesOnNextLoad: false,
  analyticsView: decodedInitialScenario.scenario?.analyticsView || "perGame",
  pendingScenario: decodedInitialScenario.scenario,
  pendingScenarioWarnings: decodedInitialScenario.warnings,
  replacementAnalyses: new Map(),
  replacementRunToken: null,
  replacementPlayerId: null,
  datasetLoadGeneration: 0,
};

function compactWatchlistPlayer(player, fallbackId = "") {
  if (!player || typeof player !== "object") return null;
  const id = String(player.id || fallbackId).trim();
  const name = String(player.name || "").trim();
  if (!id || !name) return null;

  const snapshot = {};
  for (const field of WATCHLIST_SNAPSHOT_FIELDS) {
    if (Object.hasOwn(player, field)) snapshot[field] = player[field];
  }
  snapshot.id = id;
  snapshot.name = name;
  snapshot.positions = Array.isArray(player.positions)
    ? [...new Set(player.positions.map(String).filter(Boolean))]
    : [];
  snapshot.headshotUrl = safeExternalImageUrl(player.headshotUrl);
  const context = player.watchlistContext;
  if (context && typeof context === "object" && !Array.isArray(context)) {
    snapshot.watchlistContext = {
      team: String(context.team || ""),
      season: String(context.season || ""),
      sourceLabel: String(context.sourceLabel || ""),
      savedAt: String(context.savedAt || ""),
    };
  }
  return snapshot;
}

function loadWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
    return new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch {
    return new Set();
  }
}

function loadWatchlistSnapshots() {
  try {
    const saved = JSON.parse(localStorage.getItem(WATCHLIST_SNAPSHOTS_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return new Map();
    return new Map(
      Object.entries(saved)
        .map(([id, player]) => [String(id), compactWatchlistPlayer(player, id)])
        .filter(([, player]) => Boolean(player)),
    );
  } catch {
    return new Map();
  }
}

function saveWatchlist() {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify([...state.watchlistIds].sort()));
    localStorage.setItem(
      WATCHLIST_SNAPSHOTS_KEY,
      JSON.stringify(Object.fromEntries([...state.watchlistSnapshots].sort(([left], [right]) => left.localeCompare(right)))),
    );
  } catch {
    showToast("The watchlist works for this visit, but this browser blocked local saving.");
  }
}

function rememberWatchlistPlayer(playerId) {
  const player = currentPlayer(playerId);
  if (!player || state.watchlistSnapshots.has(playerId)) return;
  const source = state.dataset?.source || {};
  const snapshot = compactWatchlistPlayer({
    ...player,
    watchlistContext: {
      team: player.team,
      season: source.season || "Custom season",
      sourceLabel: source.label || "Imported player pool",
      savedAt: new Date().toISOString(),
    },
  });
  if (snapshot) state.watchlistSnapshots.set(playerId, snapshot);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 3600);
}

function numberFromInput(input, fallback = 0) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function optionalNumber(input) {
  if (input.value.trim() === "") return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : undefined;
}

function formatNumber(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toFixed(digits).replace(/\.0$/, "");
}

/**
 * Format a whole-number rank with the correct English ordinal suffix. Percentile
 * copy appears in several different result views, so keeping this small helper
 * close to the other display formatters prevents labels such as "93th".
 */
function formatOrdinal(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return "-";
  const lastTwoDigits = Math.abs(number) % 100;
  const lastDigit = Math.abs(number) % 10;
  const suffix = lastTwoDigits >= 11 && lastTwoDigits <= 13
    ? "th"
    : lastDigit === 1 ? "st" : lastDigit === 2 ? "nd" : lastDigit === 3 ? "rd" : "th";
  return `${number}${suffix}`;
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "-";
}

function analyticsViewDetail(view = state.analyticsView) {
  return ANALYTICS_VIEW_DETAILS[view] || ANALYTICS_VIEW_DETAILS.perGame;
}

function analyticsRateViews(player) {
  // The pure fan-analysis module intentionally reads the optional analytics
  // envelope itself. That means CSV/course-demo players continue to work: the
  // per-game and per-36 views remain available while the richer views simply
  // say that their source context is unavailable.
  return derivePlayerRateViews(player);
}

function analyticsValue(player, metric, view = state.analyticsView) {
  const views = analyticsRateViews(player);
  if (view === "eraRelative") {
    return views.eraRelative?.values?.[metric]?.percentOfBaseline ?? null;
  }
  const rateKey = analyticsViewDetail(view).rateKey;
  return views[rateKey]?.values?.[metric] ?? null;
}

function analyticsMetricText(metric, value, view = state.analyticsView) {
  if (!Number.isFinite(Number(value))) return "–";
  if (view === "eraRelative") return `${formatNumber(value, 0)} index`;
  return metric.endsWith("Pct") ? formatPercent(value) : formatNumber(value);
}

function analyticsMetricShortLabel(metric, view = state.analyticsView) {
  const suffix = view === "perGame"
    ? ""
    : view === "per36"
      ? "/36"
      : view === "per100Estimated"
        ? "/100"
        : " IDX";
  const base = ({ points: "PTS", rebounds: "REB", assists: "AST", steals: "STL", blocks: "BLK", turnovers: "TOV" })[metric]
    || (METRIC_LABELS[metric] || titleCase(metric));
  return `${base}${suffix}`;
}

function formatSignedDifference(value, { percentagePoints = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  const display = percentagePoints ? number * 100 : number;
  const prefix = display > 0 ? "+" : display < 0 ? "−" : "±";
  return `${prefix}${Math.abs(display).toFixed(1)}${percentagePoints ? " pp" : ""}`;
}

function titleCase(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function createCardSearchLink(player) {
  // An internal search link is safer than attempting to fuzzy-match a player
  // directly to catalog records. It preserves the collector's intent while the
  // catalog remains the authority for whether cards are actually in stock.
  const link = document.createElement("a");
  link.className = "text-button card-search-link";
  link.href = `${CARD_SEARCH_PATH}?search=${encodeURIComponent(player?.name || "")}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Find Cards";
  link.setAttribute("aria-label", `Find cards matching ${player?.name || "this player"} in the storefront (opens in a new tab)`);
  return link;
}

function safeExternalImageUrl(value) {
  // Media URLs are supplied by the verified database view. Restricting them to
  // the known Basketball Reference hosts prevents an imported value from
  // introducing mixed content, a scriptable URL, or an unrelated tracking
  // image into a shopper-facing image element.
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" && TRUSTED_MEDIA_HOSTS.has(url.hostname)
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function safeExternalSourceUrl(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" && TRUSTED_SOURCE_HOSTS.has(url.hostname)
      ? url.href
      : "";
  } catch {
    return "";
  }
}

function liveCacheKey(team, season, seasonPhase) {
  return `${NBA_CACHE_PREFIX}:${season}:${seasonPhase}:${team}`;
}

function pruneLiveDatasetCache(preserveKey = "") {
  return pruneLineupLabDatasetCache(localStorage, {
    activePrefix: `${NBA_CACHE_PREFIX}:`,
    maxEntries: NBA_CACHE_MAX_ENTRIES,
    preserveKey,
  });
}

function beginDatasetLoadIntent() {
  state.datasetLoadGeneration += 1;
  return state.datasetLoadGeneration;
}

function datasetLoadIsCurrent(generation) {
  return generation === state.datasetLoadGeneration;
}

function beginNonLiveDatasetLoad() {
  const generation = beginDatasetLoadIntent();
  if (state.liveDataLoading) setLiveDataLoading(false);
  return generation;
}

function setLiveDataStatus(message, tone = "") {
  elements.liveDataStatus.textContent = message;
  if (tone) elements.liveDataStatus.dataset.tone = tone;
  else delete elements.liveDataStatus.dataset.tone;
}

function setSolverStatus(message, tone = "") {
  elements.solverStatus.textContent = message;
  if (tone) elements.solverStatus.dataset.tone = tone;
  else delete elements.solverStatus.dataset.tone;
}

function motionBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

function chooseCount(total, selected) {
  if (selected < 0 || selected > total) return 0;
  const smaller = Math.min(selected, total - selected);
  let result = 1;
  for (let index = 1; index <= smaller; index += 1) {
    result = (result * (total - smaller + index)) / index;
  }
  return Math.round(result);
}

function setSearchScope(text, tone, canRun) {
  state.searchScopeCanRun = canRun;
  elements.searchScopeValue.textContent = text;
  elements.searchScope.dataset.tone = tone;
  // The fixed mobile bar replaces the desktop run card at narrow widths. Its
  // title preserves the full structural explanation even when the short plan
  // label is hidden to make room for the solve button.
  elements.mobileSolveLabel.title = text;
  elements.mobileOptimize.title = canRun ? "Run the exact optimizer" : text;
  if (state.activeOptimizationToken === null) setOptimizeButtons();
}

function hasPositiveObjectiveWeight() {
  return Object.values(state.weights).some((weight) => Number(weight) > 0);
}

function syncWeightValidation() {
  const valid = hasPositiveObjectiveWeight();
  const wasInvalid = elements.weightsPanel.dataset.validation === "error";
  elements.weightsPanel.dataset.validation = valid ? "valid" : "error";
  elements.weightValidation.hidden = valid;
  // Opening the panel only on the transition to an invalid state makes the
  // corrective control visible without repeatedly fighting a user's choice to
  // collapse the disclosure.
  if (!valid && !wasInvalid) elements.weightsPanel.open = true;
  return valid;
}

function updateSearchScope() {
  // This intentionally mirrors the optimizer's cheap structural checks in the
  // form. It gives a collector an immediate explanation and avoids starting a
  // worker just to rediscover an impossible roster size or minute total.
  const validationInputs = [elements.size, elements.rotationMin, elements.rotationMax];
  validationInputs.forEach((input) => input.setCustomValidity(""));

  if (!state.dataset) {
    setSearchScope("Loading team-season data…", "neutral", false);
    return;
  }

  if (!syncWeightValidation()) {
    setSearchScope("Set at least one strategy weight above zero before optimizing.", "error", false);
    return;
  }

  const structuralInputs = [
    elements.size,
    elements.minGuards,
    elements.minForwards,
    elements.minCenters,
    elements.minGames,
    elements.minMinutes,
    elements.rotationMin,
    elements.rotationMax,
  ];
  const invalidInput = structuralInputs.find((input) => !input.closest("[hidden]") && !input.validity.valid);
  if (invalidInput) {
    setSearchScope("Check the highlighted scenario value before optimizing.", "error", false);
    return;
  }

  const size = numberFromInput(elements.size, 0);
  const positionSlots = [elements.minGuards, elements.minForwards, elements.minCenters]
    .reduce((total, input) => total + numberFromInput(input, 0), 0);
  if (positionSlots > size) {
    const message = `Position slots require ${positionSlots} players, more than this ${size}-player group allows.`;
    elements.size.setCustomValidity(message);
    setSearchScope(message, "error", false);
    return;
  }

  if (elements.mode.value === "rotation") {
    const minimum = numberFromInput(elements.rotationMin, 0);
    const maximum = numberFromInput(elements.rotationMax, 0);
    if (minimum > maximum) {
      const message = "Rotation maximum minutes must be at least the minimum.";
      elements.rotationMax.setCustomValidity(message);
      setSearchScope(message, "error", false);
      return;
    }
    if (minimum * size > 240 || maximum * size < 240) {
      const message = `A ${size}-player rotation with ${minimum}–${maximum} minutes per player cannot total exactly 240.`;
      elements.rotationMax.setCustomValidity(message);
      setSearchScope(message, "error", false);
      return;
    }
  }

  const eligiblePlayers = state.dataset.players.filter(isPlayerEligible);
  const eligibleById = new Map(eligiblePlayers.map((player) => [player.id, player]));
  const lockedIds = [...state.lockedIds];
  const invalidLocked = lockedIds.find((id) => state.excludedIds.has(id) || !eligibleById.has(id));
  if (invalidLocked) {
    setSearchScope("A locked player is excluded or below the current sample filters.", "error", false);
    return;
  }
  if (lockedIds.length > size) {
    setSearchScope(`${lockedIds.length} locked players cannot fit in a ${size}-player group.`, "error", false);
    return;
  }

  const availablePlayers = eligiblePlayers.filter(
    (player) => !state.excludedIds.has(player.id) && !state.lockedIds.has(player.id),
  );
  const slotsToChoose = size - lockedIds.length;
  if (availablePlayers.length < slotsToChoose) {
    setSearchScope(`Only ${availablePlayers.length} eligible unlocked players remain for ${slotsToChoose} open spots.`, "error", false);
    return;
  }

  const estimatedCombinations = chooseCount(availablePlayers.length, slotsToChoose);
  const groupLabel = estimatedCombinations === 1 ? "possible group" : "possible groups";
  const safeLimit = elements.mode.value === "rotation"
    ? DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS
    : DEFAULT_MAX_EXACT_COMBINATIONS;
  if (estimatedCombinations > safeLimit) {
    setSearchScope(
      `${estimatedCombinations.toLocaleString()} ${groupLabel} exceed the ${safeLimit.toLocaleString()} browser-safe limit. Narrow the eligible roster.`,
      "warning",
      false,
    );
    return;
  }
  setSearchScope(`${estimatedCombinations.toLocaleString()} ${groupLabel} · every group will be checked.`, "success", true);
}

function setOptimizeButtons({ disabled = false, label } = {}) {
  // Once a visitor changes the live selector, the data table still represents
  // the previously loaded team-season. Never let an exact search silently run
  // against that old pool while the controls describe a new one.
  const datasetMatchesSelection = canOptimizeCurrentDataset();
  for (const button of [elements.optimize, elements.mobileOptimize]) {
    button.disabled = disabled || !state.searchScopeCanRun || !datasetMatchesSelection;
    if (label) button.textContent = label;
  }
}

function selectionFromControls() {
  return {
    team: elements.liveTeam.value,
    season: Number(elements.liveSeason.value),
    seasonPhase: elements.liveSeasonPhase.value,
  };
}

function liveDatasetMatchesControls() {
  return Boolean(
    state.loadedLiveSelection
    && liveSelectionMatches(state.loadedLiveSelection, selectionFromControls()),
  );
}

function canOptimizeCurrentDataset() {
  // CSV and course-project data do not have a live selector source, so they
  // remain perfectly valid local optimizer inputs. A loaded historical roster
  // must always match the visible team, season, and phase controls.
  return !state.loadedLiveSelection || liveDatasetMatchesControls();
}

function canShareCurrentScenario() {
  // A URL can reproduce only a fresh exact result based on a concrete,
  // database-backed team-season. This prevents a CSV/demo result—or a result
  // from a previously selected team—from being mislabeled as a shareable live
  // scenario.
  return Boolean(
    state.lastResult?.ok
    && elements.resultFreshness.hidden
    && state.loadedLiveSelection
    && liveDatasetMatchesControls(),
  );
}

function syncShareScenarioAvailability() {
  const available = canShareCurrentScenario();
  elements.shareScenario.disabled = !available;
  elements.shareScenario.title = available
    ? "Copy a link that reloads this team-season and reruns the exact search"
    : state.loadedLiveSelection && !liveDatasetMatchesControls()
      ? "Load the selected team-season and run a fresh result before sharing"
      : "Share links are available for fresh, database-backed team-season results";
}

function setInputValueIfPresent(input, value) {
  if (value === undefined || value === null || value === "") return;
  input.value = String(value);
}

function applySharedScenarioControls(scenario) {
  if (!scenario) return;

  // A shared link is an input snapshot, not a result. Apply only values the
  // codec already validated, then let the normal form and exact-scope checks
  // perform the final structural validation against the loaded player pool.
  if (["simple", "detailed"].includes(scenario.experience)) {
    setExperienceMode(scenario.experience, { applyDefaults: false });
  }
  const mode = scenario.mode === "rotation" ? "rotation" : "lineup";
  elements.mode.value = mode;
  setMode(mode);

  const requestedSize = Number(scenario.size);
  if (Number.isInteger(requestedSize)) {
    if (mode === "lineup" && requestedSize !== 5) {
      state.pendingScenarioWarnings.push("A five-player lineup always uses five players, so the shared lineup size was reset to 5.");
      elements.size.value = "5";
    } else if (mode === "rotation" && requestedSize >= 8 && requestedSize <= 12) {
      elements.size.value = String(requestedSize);
    } else if (mode === "rotation") {
      state.pendingScenarioWarnings.push("The shared rotation size was outside Lineup Lab's 8–12 player range and was reset to 9.");
      elements.size.value = "9";
    }
  }

  setInputValueIfPresent(elements.alternatives, scenario.alternatives);
  const sharedMinGamesIsExplicit = Object.prototype.hasOwnProperty.call(scenario, "minGames");
  setInputValueIfPresent(elements.minGames, scenario.minGames);
  // The playoff loader normally replaces the untouched 20-game regular-season
  // default with 3. A share link that explicitly says 20 is not untouched, so
  // preserve it through the first matching dataset load.
  state.preserveSharedMinGamesOnNextLoad = sharedMinGamesIsExplicit;
  setInputValueIfPresent(elements.minMinutes, scenario.minMinutes);
  setInputValueIfPresent(elements.rotationMin, scenario.rotationMin);
  setInputValueIfPresent(elements.rotationMax, scenario.rotationMax);
  setInputValueIfPresent(elements.maxTurnovers, scenario.maxTurnovers);

  const positions = scenario.positionMinimums || {};
  setInputValueIfPresent(elements.minGuards, positions.G);
  setInputValueIfPresent(elements.minForwards, positions.F);
  setInputValueIfPresent(elements.minCenters, positions.C);

  const statMinimums = scenario.statMinimums || {};
  setInputValueIfPresent(elements.minPoints, statMinimums.points);
  setInputValueIfPresent(elements.minRebounds, statMinimums.rebounds);
  setInputValueIfPresent(elements.minAssists, statMinimums.assists);
  setInputValueIfPresent(elements.minSteals, statMinimums.steals);
  setInputValueIfPresent(elements.minBlocks, statMinimums.blocks);

  const requestedPreset = scenario.preset;
  const sharedWeights = scenario.weights && typeof scenario.weights === "object"
    ? scenario.weights
    : {};
  if (requestedPreset && requestedPreset !== "custom") {
    applyPreset(requestedPreset, { invalidate: false });
  }
  if (requestedPreset === "custom" || Object.keys(sharedWeights).length > 0) {
    // The query stores non-zero weights only. Start from zeros so a custom
    // share link cannot inherit a stray slider value from a browser session.
    state.weights = Object.fromEntries(Object.keys(METRIC_LABELS).map((metric) => [metric, 0]));
    for (const [metric, value] of Object.entries(sharedWeights)) {
      if (Object.prototype.hasOwnProperty.call(state.weights, metric)) state.weights[metric] = Number(value);
    }
    state.familyWeights = skillFamiliesFromMetricWeights(state.weights);
    state.activePreset = requestedPreset && requestedPreset !== "custom" ? requestedPreset : "custom";
  }
  renderPresetState();
  renderWeightControls();

  if (ANALYTICS_VIEW_DETAILS[scenario.analyticsView]) {
    state.analyticsView = scenario.analyticsView;
  }
  elements.analyticsView.value = state.analyticsView;
  if (["per36", "perGame"].includes(scenario.rotationScoreBasis)) {
    elements.rotationScoringBasis.value = scenario.rotationScoreBasis;
  }
  if (scenario.rotationMinutePlan === "historicalAware") {
    state.pendingScenarioWarnings.push(
      "This older link requested a recorded-workload rule. Lineup Lab now treats past team usage as context only, so the rotation was restored in game-plan mode.",
    );
  }
  elements.rotationMinutePlan.value = LINEUP_LAB_ROTATION_MINUTE_PLAN;
  if (["preserveWorkload", "strategyFirst"].includes(scenario.rotationHistoricalAllocationStyle)) {
    elements.rotationAllocationStyle.value = scenario.rotationHistoricalAllocationStyle;
  }
  setInputValueIfPresent(elements.rotationFlexibility, scenario.rotationMinuteFlexibility);
  if (["sampleAdjusted", "raw"].includes(scenario.rotationRateStability)) {
    elements.rotationRateStability.value = scenario.rotationRateStability;
  }
  if (scenario.rotationScoreBasis === "perGame" && scenario.rotationRateStability === "sampleAdjusted") {
    state.pendingScenarioWarnings.push("Per-game rotation scoring uses raw source values, so the shared sample-adjustment setting was disabled.");
  }
  if (["automatic", "traditional", "small", "big"].includes(scenario.rotationPositionProfile)) {
    elements.rotationPositionProfile.value = scenario.rotationPositionProfile;
  } else if (scenario.rotationPositionMinuteRequirements) {
    elements.rotationPositionProfile.value = rotationPositionProfileForRequirements(
      scenario.rotationPositionMinuteRequirements,
    );
  }
  if (["recommended", "open", "seasonOnly"].includes(scenario.positionFlexibility)) {
    elements.positionFlexibility.value = scenario.positionFlexibility;
  }
  syncRotationModelControls();
  syncRotationRoleCopy(mode === "rotation");
  updateRunSummary();
}

function applyPendingScenarioPlayerSelections(dataset) {
  const scenario = state.pendingScenario;
  if (!scenario) return;

  const availableIds = new Set(dataset.players.map((player) => player.id));
  const requestedLocks = Array.isArray(scenario.lockedIds) ? scenario.lockedIds : [];
  const requestedExclusions = Array.isArray(scenario.excludedIds) ? scenario.excludedIds : [];
  const ignoredLocks = requestedLocks.filter((id) => !availableIds.has(id));
  const ignoredExclusions = requestedExclusions.filter((id) => !availableIds.has(id));

  state.lockedIds = new Set(requestedLocks.filter((id) => availableIds.has(id)));
  // A lock wins over an exclusion because a player cannot be required and
  // forbidden in the same exact request. The UI exposes that same mutual
  // exclusion behavior when a visitor clicks its checkboxes.
  state.excludedIds = new Set(
    requestedExclusions.filter((id) => availableIds.has(id) && !state.lockedIds.has(id)),
  );
  if (ignoredLocks.length) {
    state.pendingScenarioWarnings.push(`${ignoredLocks.length} locked player${ignoredLocks.length === 1 ? " was" : "s were"} not in this team-season and could not be applied.`);
  }
  if (ignoredExclusions.length) {
    state.pendingScenarioWarnings.push(`${ignoredExclusions.length} excluded player${ignoredExclusions.length === 1 ? " was" : "s were"} not in this team-season and could not be applied.`);
  }
  state.pendingScenario = null;
}

function sharedScenarioFromControls() {
  // Serialize the same live selection that produced the visible result—not a
  // newly chosen but still-unloaded roster. The caller guards this too, so a
  // programmatic invocation cannot create a misleading link.
  if (!liveDatasetMatchesControls()) return null;
  const loadedSelection = state.loadedLiveSelection;
  const statMinimums = {};
  for (const [metric, input] of Object.entries({
    points: elements.minPoints,
    rebounds: elements.minRebounds,
    assists: elements.minAssists,
    steals: elements.minSteals,
    blocks: elements.minBlocks,
  })) {
    const value = optionalNumber(input);
    if (value !== undefined) statMinimums[metric] = value;
  }
  return {
    experience: state.experienceMode,
    team: loadedSelection.team,
    season: Number(loadedSelection.season),
    phase: loadedSelection.seasonPhase,
    mode: elements.mode.value,
    size: numberFromInput(elements.size, 5),
    alternatives: numberFromInput(elements.alternatives, 5),
    preset: state.activePreset,
    weights: state.weights,
    minGames: numberFromInput(elements.minGames, 0),
    minMinutes: numberFromInput(elements.minMinutes, 0),
    positionMinimums: {
      G: numberFromInput(elements.minGuards, 0),
      F: numberFromInput(elements.minForwards, 0),
      C: numberFromInput(elements.minCenters, 0),
    },
    statMinimums,
    maxTurnovers: optionalNumber(elements.maxTurnovers),
    rotationMin: numberFromInput(elements.rotationMin, 8),
    rotationMax: numberFromInput(elements.rotationMax, 40),
    analyticsView: state.analyticsView,
    rotationScoreBasis: elements.rotationScoringBasis.value,
    rotationMinutePlan: elements.rotationMinutePlan.value,
    rotationHistoricalAllocationStyle: elements.rotationAllocationStyle.value,
    rotationMinuteFlexibility: numberFromInput(elements.rotationFlexibility, 8),
    rotationRateStability: elements.rotationRateStability.value,
    rotationPositionProfile: elements.rotationPositionProfile.value,
    rotationPositionMinuteRequirements: selectedRotationPositionRequirements(),
    positionFlexibility: elements.positionFlexibility.value,
    lockedIds: [...state.lockedIds].sort(),
    excludedIds: [...state.excludedIds].sort(),
  };
}

async function copyScenarioLink() {
  if (!canShareCurrentScenario()) {
    showToast("Load the selected team-season and run a fresh exact result before sharing it.");
    return;
  }
  try {
    const scenario = sharedScenarioFromControls();
    if (!scenario) throw new Error("The displayed result no longer matches the selected team-season.");
    const query = encodeScenarioQuery(scenario);
    const link = new URL(window.location.href);
    link.search = query;
    link.hash = "workspace";
    const text = link.href;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    // Keeping the current URL in sync makes a copied link auditable in the
    // address bar without storing or sharing any result/cache payload.
    window.history.replaceState({}, "", `${link.pathname}${link.search}${link.hash}`);
    showToast("Share link copied. It reloads the team-season and reruns the exact search locally.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "This scenario could not be shared.");
  }
}

function printScoutingReport() {
  if (!state.lastResult?.ok || !elements.resultFreshness.hidden) return;
  window.print();
}

function flushPendingScenarioWarnings() {
  const warnings = [...new Set(state.pendingScenarioWarnings.filter(Boolean))];
  state.pendingScenarioWarnings = [];
  if (warnings.length === 0) return;
  const message = warnings.length === 1
    ? warnings[0]
    : `${warnings[0]} (+${warnings.length - 1} more shared-link note${warnings.length === 2 ? "" : "s"}.)`;
  showToast(message);
}

function sharedScenarioSelection(scenario) {
  if (!scenario || !scenario.team || !Number.isInteger(Number(scenario.season))) return null;
  if (!['regular', 'playoffs'].includes(scenario.phase)) return null;
  return {
    team: scenario.team,
    season: Number(scenario.season),
    seasonPhase: scenario.phase,
  };
}

async function replaySharedScenarioAfterLoad(scenario) {
  if (!scenario) return;
  const requestedSelection = sharedScenarioSelection(scenario);
  if (!requestedSelection) {
    state.pendingScenarioWarnings.push("The shared link did not identify a complete team-season source, so its exact search was not rerun.");
    return;
  }
  if (!liveSelectionMatches(state.loadedLiveSelection, requestedSelection) || !liveDatasetMatchesControls()) {
    state.pendingScenarioWarnings.push("The shared team-season was unavailable or could not be loaded exactly, so its exact search was not rerun.");
    return;
  }

  // All input controls, locks, and exclusions have already passed through the
  // normal validation path in setDataset. Reuse the same exact submit handler
  // rather than creating a second share-only solver path.
  await runOptimizer();
}

function liveSelectionMatches(left, right) {
  return Boolean(left && right)
    && left.team === right.team
    && Number(left.season) === Number(right.season)
    && left.seasonPhase === right.seasonPhase;
}

function finishPendingReplacement(message) {
  const playerId = state.replacementPlayerId;
  state.replacementRunToken = null;
  state.replacementPlayerId = null;
  if (playerId) {
    replaceReplacementOutput(playerId, {
      ok: false,
      message,
    });
  }
}

function markResultStaleForDatasetSelection() {
  if (!state.lastResult || !elements.resultFreshness.hidden) return;

  // Changing the selector is a data-input change, even before the visitor
  // presses Load selected roster. Mark the old result stale immediately so it
  // cannot be copied, printed, shared, or accidentally treated as a result
  // for the newly visible team-season choice.
  state.scenarioVersion += 1;
  state.replacementAnalyses.clear();
  const hasPendingReplacement = state.replacementRunToken !== null;
  if (hasPendingReplacement || state.optimizationWorker || state.activeOptimizationToken !== null) {
    cancelOptimization("Optimization cancelled because the selected team-season changed.");
  }
  if (hasPendingReplacement) {
    finishPendingReplacement("The selected team-season changed. Load it and run a new result before testing replacements.");
  }
  elements.results.classList.add("is-stale");
  elements.resultFreshness.hidden = false;
  elements.resultFreshness.textContent = "The selected team-season changed. Load its data and run the optimizer again before using this result.";
  elements.copyResult.disabled = true;
  elements.downloadResult.disabled = true;
  elements.shareScenario.disabled = true;
  elements.printReport.disabled = true;
  setMobileResultCurrent(false);
  setSolverStatus("Load team-season data to update result", "warning");
}

function updateLiveSelectionState({ preserveStatus = false } = {}) {
  if (state.liveDataLoading || !elements.liveTeam.value || !elements.liveSeason.value) return;
  const selection = selectionFromControls();
  const matches = liveSelectionMatches(state.loadedLiveSelection, selection);
  elements.liveDataPanel.dataset.selectionState = matches ? "loaded" : "pending";
  elements.datasetStrip.classList.toggle("has-pending-selection", Boolean(state.dataset && !matches));
  elements.loadLiveData.textContent = matches ? "Reload team-season data" : "Load team-season";
  if (!preserveStatus && !matches) {
    markResultStaleForDatasetSelection();
    setLiveDataStatus(
      `Selection changed. Load ${selectedLiveTeamName()} ${nbaSeasonLabel(selection.season)} ${selectedLivePhaseLabel()} data to replace the current team-season.`,
      "warning",
    );
    setOptimizeButtons({ label: "Load team-season" });
  } else if (!preserveStatus && matches) {
    setLiveDataStatus(
      `The selected team-season matches ${selectedLiveTeamName()} ${nbaSeasonLabel(selection.season)} ${selectedLivePhaseLabel()} stats.`,
      "success",
    );
    const needsUpdate = !elements.resultFreshness.hidden;
    setOptimizeButtons({ label: solveActionLabel({ update: needsUpdate }) });
  }
  syncShareScenarioAvailability();
}

function setLiveDataLoading(loading, loadingLabel = "Loading stats...") {
  state.liveDataLoading = loading;
  elements.liveDataPanel.setAttribute("aria-busy", String(loading));
  elements.liveTeam.disabled = loading;
  elements.liveSeason.disabled = loading;
  elements.liveSeasonPhase.disabled = loading;
  elements.loadLiveData.disabled = loading;
  if (loading) {
    elements.loadLiveData.textContent = loadingLabel;
    elements.opponentTeam.disabled = true;
    elements.loadOpponent.disabled = true;
  } else {
    updateLiveSelectionState({ preserveStatus: true });
    populateOpponentTeamOptions({ preferredTeam: state.opponentDataset?.source?.team });
  }
}

function selectedLiveTeam() {
  return state.liveTeamOptions.find((team) => team.team_code === elements.liveTeam.value) || null;
}

function selectedLiveTeamName() {
  return selectedLiveTeam()?.team_name || elements.liveTeam.value || "selected team";
}

function selectedLivePhaseLabel() {
  return elements.liveSeasonPhase.value === "playoffs" ? "playoff" : "regular season";
}

function normalizeCachedLiveDataset(rawDataset) {
  const dataset = normalizeDataset(rawDataset, { strict: true, warnOnGeneratedId: false });
  const headshots = new Map(
    (rawDataset?.players || []).map((player) => [String(player?.id || ""), safeExternalImageUrl(player?.headshotUrl)]),
  );
  // Canonical normalization intentionally strips unknown metadata. Reattach
  // only the serializable analytics envelope that this page wrote to its own
  // 24-hour cache so cached historical rosters keep their rate/context report.
  const analytics = new Map(
    (rawDataset?.players || [])
      .filter((player) => player?.analytics && typeof player.analytics === "object" && !Array.isArray(player.analytics))
      .map((player) => [String(player.id || ""), player.analytics]),
  );
  dataset.players = dataset.players.map((player) => ({
    ...player,
    headshotUrl: headshots.get(player.id) || "",
    analytics: analytics.get(player.id) || null,
  }));
  return dataset;
}

function populateSeasonOptions(seasons) {
  const previousSeason = Number(elements.liveSeason.value);
  const sortedSeasons = [...seasons].sort(
    (left, right) => Number(right.season_end_year) - Number(left.season_end_year),
  );
  const seasonFragment = document.createDocumentFragment();
  for (const season of sortedSeasons) {
    const option = document.createElement("option");
    option.value = String(season.season_end_year);
    option.textContent = season.season_label || nbaSeasonLabel(season.season_end_year);
    seasonFragment.append(option);
  }
  elements.liveSeason.replaceChildren(seasonFragment);

  const preferredSeason = sortedSeasons.some(
    (season) => Number(season.season_end_year) === previousSeason,
  )
    ? previousSeason
    : Number(sortedSeasons[0]?.season_end_year);
  if (preferredSeason) elements.liveSeason.value = String(preferredSeason);
}

async function populateLiveTeamOptions({ preferredTeam = DEFAULT_TEAM_CODE, force = false } = {}) {
  const season = Number(elements.liveSeason.value);
  const seasonPhase = elements.liveSeasonPhase.value;
  const teams = await listSupabaseNbaTeams({ seasonEndYear: season, seasonPhase, force });
  if (!Array.isArray(teams) || teams.length === 0) {
    throw new Error(`No teams with imported ${selectedLivePhaseLabel()} stats were found for ${nbaSeasonLabel(season)}.`);
  }
  const selectedCode = elements.liveTeam.value;
  state.liveTeamOptions = teams;
  const seasonFragment = document.createDocumentFragment();
  for (const team of teams) {
    const option = document.createElement("option");
    option.value = team.team_code;
    option.textContent = `${team.team_name} (${team.team_code})`;
    seasonFragment.append(option);
  }
  elements.liveTeam.replaceChildren(seasonFragment);
  const preferredCode = [selectedCode, preferredTeam]
    .find((code) => teams.some((team) => team.team_code === code));
  elements.liveTeam.value = preferredCode || teams[0].team_code;
  populateOpponentTeamOptions();
}

function teamNameForCode(teamCode) {
  return state.liveTeamOptions.find((team) => team.team_code === teamCode)?.team_name || teamCode;
}

function setOpponentScoutStatus(message, tone = "") {
  elements.opponentScoutStatus.textContent = message;
  if (tone) elements.opponentScoutStatus.dataset.tone = tone;
  else delete elements.opponentScoutStatus.dataset.tone;
}

function loadedPoolMatchesCurrentSeasonPhase() {
  const selected = selectionFromControls();
  return Boolean(state.loadedLiveSelection)
    && Number(state.loadedLiveSelection.season) === Number(selected.season)
    && state.loadedLiveSelection.seasonPhase === selected.seasonPhase;
}

function populateOpponentTeamOptions({ preferredTeam = "" } = {}) {
  const priorValue = elements.opponentTeam.value;
  const ownTeam = loadedPoolMatchesCurrentSeasonPhase()
    ? state.loadedLiveSelection.team
    : elements.liveTeam.value;
  const opponents = state.liveTeamOptions.filter((team) => team.team_code !== ownTeam);
  const fragment = document.createDocumentFragment();
  for (const team of opponents) {
    const option = document.createElement("option");
    option.value = team.team_code;
    option.textContent = `${team.team_name} (${team.team_code})`;
    fragment.append(option);
  }
  elements.opponentTeam.replaceChildren(fragment);
  const selectedCode = [priorValue, preferredTeam, opponents[0]?.team_code]
    .find((code) => code && opponents.some((team) => team.team_code === code));
  if (selectedCode) elements.opponentTeam.value = selectedCode;

  const canScout = opponents.length > 0 && liveSelectionMatches(state.loadedLiveSelection, selectionFromControls());
  elements.opponentTeam.disabled = state.liveDataLoading || state.opponentLoading || !canScout;
  elements.loadOpponent.disabled = state.liveDataLoading || state.opponentLoading || !canScout;
  if (!canScout && !state.opponentLoading) {
    setOpponentScoutStatus("Apply the team, season, and phase above before building an opponent scouting cue.");
  }
}

async function refreshLiveTeamOptions() {
  if (state.liveDataLoading) return;
  // Season and phase are coupled: a playoff dropdown must contain only teams
  // that actually recorded a playoff player pool, not every regular-season
  // franchise from that year.
  setLiveDataLoading(true, "Loading teams...");
  setLiveDataStatus(
    `Loading ${selectedLivePhaseLabel()} teams from ${nbaSeasonLabel(elements.liveSeason.value)}...`,
  );
  try {
    await populateLiveTeamOptions();
    updateLiveSelectionState();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Team data could not be loaded.";
    setLiveDataStatus(detail, "error");
    showToast(detail);
  } finally {
    setLiveDataLoading(false);
  }
}

async function populateLiveDataControls({ sharedScenario = null } = {}) {
  setLiveDataLoading(true, "Loading seasons...");
  setLiveDataStatus("Loading the imported 1980+ NBA seasons...");
  try {
    const seasons = await listSupabaseNbaSeasons();
    if (!Array.isArray(seasons) || seasons.length === 0) {
      throw new Error("No imported NBA seasons are available yet.");
    }
    populateSeasonOptions(seasons);
    if (
      Number.isInteger(Number(sharedScenario?.season))
      && [...elements.liveSeason.options].some((option) => Number(option.value) === Number(sharedScenario.season))
    ) {
      elements.liveSeason.value = String(sharedScenario.season);
    } else if (sharedScenario?.season) {
      state.pendingScenarioWarnings.push(
        `${nbaSeasonLabel(sharedScenario.season)} is not available in this Lineup Lab source, so the newest available season was selected.`,
      );
    }
    if (["regular", "playoffs"].includes(sharedScenario?.phase)) {
      elements.liveSeasonPhase.value = sharedScenario.phase;
    }
    await populateLiveTeamOptions({ preferredTeam: sharedScenario?.team || DEFAULT_TEAM_CODE });
    if (sharedScenario?.team && elements.liveTeam.value !== sharedScenario.team) {
      state.pendingScenarioWarnings.push(
        `${sharedScenario.team} was not available for that season and phase, so ${elements.liveTeam.value} was selected instead.`,
      );
    }
    setLiveDataStatus(
      `Ready to load ${selectedLiveTeamName()} ${nbaSeasonLabel(elements.liveSeason.value)} ${selectedLivePhaseLabel()} stats.`,
    );
  } finally {
    setLiveDataLoading(false);
  }
}

function readCachedLiveDataset(team, season, seasonPhase) {
  const key = liveCacheKey(team, season, seasonPhase);
  try {
    const entry = JSON.parse(localStorage.getItem(key) || "null");
    if (!entry || !Number.isFinite(entry.cachedAt)) {
      localStorage.removeItem(key);
      return null;
    }
    const dataset = normalizeCachedLiveDataset(entry.dataset);
    if (
      dataset.source?.team !== team
      || dataset.source?.season !== nbaSeasonLabel(season)
      || dataset.source?.seasonPhase !== seasonPhase
    ) {
      localStorage.removeItem(key);
      return null;
    }
    pruneLiveDatasetCache(key);
    return {
      dataset,
      fresh: Date.now() - entry.cachedAt <= NBA_CACHE_MAX_AGE_MS,
    };
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable; a network request can still load the data.
    }
    return null;
  }
}

function cacheLiveDataset(team, season, seasonPhase, dataset) {
  const key = liveCacheKey(team, season, seasonPhase);
  try {
    localStorage.setItem(
      key,
      JSON.stringify({ cachedAt: Date.now(), dataset }),
    );
    pruneLiveDatasetCache(key);
  } catch {
    // Caching is an optional request-saving optimization.
  }
}

async function loadLiveDataset({ force = false, intentGeneration = null } = {}) {
  if (state.liveDataLoading) return;
  const loadGeneration = intentGeneration ?? beginDatasetLoadIntent();
  if (!datasetLoadIsCurrent(loadGeneration)) return;
  const team = elements.liveTeam.value;
  const season = Number(elements.liveSeason.value);
  const seasonPhase = elements.liveSeasonPhase.value;
  const teamName = selectedLiveTeamName();
  const cached = force ? null : readCachedLiveDataset(team, season, seasonPhase);
  if (cached?.fresh) {
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    setDataset(cached.dataset, {
      liveSelection: { team, season, seasonPhase },
      notice: "",
    });
    setLiveDataStatus(
      `Showing a cached Basketball Reference snapshot. Use Reload team-season data to check for newer ${teamName} totals.`,
      "success",
    );
    return;
  }

  setLiveDataLoading(true);
  setLiveDataStatus(`Loading ${teamName} ${nbaSeasonLabel(season)} ${selectedLivePhaseLabel()} totals...`);
  try {
    const dataset = await fetchSupabaseNbaTeamDataset({ team, season, seasonPhase, force });
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    cacheLiveDataset(team, season, seasonPhase, dataset);
    setDataset(dataset, {
      liveSelection: { team, season, seasonPhase },
      notice: force ? `${dataset.players.length} ${teamName} players loaded from the Basketball Reference database.` : "",
    });
    setLiveDataStatus(
      `Loaded ${dataset.players.length} players who appeared for ${teamName}; their team-only totals were converted to per-game stats.`,
      "success",
    );
  } catch (error) {
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    const detail = error instanceof Error ? error.message : "The saved Basketball Reference data could not be reached.";
    const stale = cached || readCachedLiveDataset(team, season, seasonPhase);
    if (stale) {
      setDataset(stale.dataset, {
        liveSelection: { team, season, seasonPhase },
        notice: force ? `Live refresh unavailable; using the last saved ${teamName} snapshot.` : "",
      });
      setLiveDataStatus(
        `${detail} Showing the last saved ${teamName} ${nbaSeasonLabel(season)} snapshot instead.`,
        "warning",
      );
      return;
    }
    setLiveDataStatus(`${detail} The demo and CSV tools remain available.`, "error");
    throw error;
  } finally {
    if (datasetLoadIsCurrent(loadGeneration)) setLiveDataLoading(false);
  }
}

function setOpponentLoading(loading) {
  state.opponentLoading = loading;
  elements.opponentScout.setAttribute("aria-busy", String(loading));
  elements.opponentTeam.disabled = loading;
  elements.loadOpponent.disabled = loading;
  elements.loadOpponent.textContent = loading ? "Building scouting cue..." : "Build scouting cue";
  if (!loading) populateOpponentTeamOptions({ preferredTeam: state.opponentDataset?.source?.team });
}

function clearOpponentScout(message = "Choose an opponent to compare historical rotations and team averages.") {
  state.opponentDataset = null;
  state.opponentStrategy = null;
  state.opponentWeightUndo = null;
  elements.opponentScoutSummary.hidden = true;
  elements.opponentScoutSummary.replaceChildren();
  setOpponentScoutStatus(message);
}

function normalizedDisplayWeights(rawWeights) {
  const total = Object.values(rawWeights).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  if (!(total > 0)) return { ...state.familyWeights };
  return Object.fromEntries(
    Object.entries(rawWeights).map(([metric, value]) => [metric, Math.round((Math.max(0, Number(value) || 0) / total) * 100)]),
  );
}

function deriveHistoricalCounterStrategy(ownAverages, opponentAverages) {
  // This suggestion deliberately uses only same-season team totals already
  // shown to the user. It is a transparent heuristic—not a hidden prediction
  // model—and it never changes settings until the user presses Apply.
  const familyWeights = { ...DEFAULT_FAMILY_PRESETS.balanced };
  const reasons = [];
  const own = ownAverages || {};
  const opponent = opponentAverages || {};
  const finite = (value) => Number.isFinite(Number(value));
  const leadsByRatio = (metric, ratio) => finite(own[metric])
    && finite(opponent[metric])
    && Number(opponent[metric]) > Number(own[metric]) * ratio;
  const leadsByAmount = (metric, amount) => finite(own[metric])
    && finite(opponent[metric])
    && Number(opponent[metric]) > Number(own[metric]) + amount;

  if (leadsByRatio("rebounds", 1.02)) {
    familyWeights.rebounding += 12;
    familyWeights.interiorDefense += 4;
    reasons.push("The opponent held a rebounding edge, so the suggestion raises rebounding and interior size.");
  }
  if (leadsByAmount("efgPct", 0.008)) {
    familyWeights.perimeterDefense += 8;
    familyWeights.interiorDefense += 8;
    reasons.push("The opponent posted the higher effective field-goal rate, so disruption and rim protection receive more weight.");
  }
  if (leadsByAmount("threePct", 0.01)) {
    familyWeights.perimeterDefense += 7;
    familyWeights.spacing += 4;
    reasons.push("The opponent shot better from three, so perimeter disruption and efficient answering offense rise.");
  }
  if (leadsByRatio("assists", 1.03)) {
    familyWeights.perimeterDefense += 7;
    reasons.push("The opponent created more assists, so the suggestion favors active passing-lane defenders.");
  }
  if (finite(own.turnovers) && finite(opponent.turnovers) && Number(own.turnovers) > Number(opponent.turnovers) + 0.5) {
    familyWeights.creation += 10;
    reasons.push("The current team committed more turnovers, so ball security becomes a larger priority.");
  }
  if (leadsByRatio("points", 1.02)) {
    familyWeights.scoring += 8;
    familyWeights.spacing += 6;
    reasons.push("The opponent scored more per team game, so the scouting cue adds scoring and shot efficiency.");
  }
  if (reasons.length === 0) {
    reasons.push("No large same-season statistical gap crossed the comparison thresholds, so a balanced mix remains the suggestion.");
  }
  const normalizedFamilies = normalizedDisplayWeights(familyWeights);
  return {
    familyWeights: normalizedFamilies,
    weights: weightsFromSkillFamilies(normalizedFamilies),
    reasons,
  };
}

function objectiveWeightsMatch(left, right) {
  return Object.keys(METRIC_LABELS).every((metric) => Number(left?.[metric] || 0) === Number(right?.[metric] || 0));
}

function renderCounterWeightPreview(strategy) {
  const wrap = document.createElement("div");
  wrap.className = "counter-weight-preview table-wrap";
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "Current and suggested skill-priority comparison");
  const table = document.createElement("table");
  table.className = "counter-weight-table";
  const caption = document.createElement("caption");
  caption.textContent = "Weight preview";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const heading of ["Metric", "Current", "Suggested", "Change"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const [family, label] of Object.entries(FAMILY_LABELS)) {
    const current = Number(state.familyWeights[family] || 0);
    const suggested = Number(strategy.familyWeights[family] || 0);
    const row = document.createElement("tr");
    createCell(row, label);
    createCell(row, String(current));
    createCell(row, String(suggested));
    createCell(row, formatSignedDifference(suggested - current));
    body.append(row);
  }
  table.append(caption, head, body);
  wrap.append(table);
  return wrap;
}

function createOpponentTeamMark(source) {
  const mark = document.createElement("span");
  mark.className = "opponent-scout__logo";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = source.team || "NBA";
  const logoUrl = safeExternalImageUrl(source.teamLogoUrl);
  if (!logoUrl) return mark;

  const image = document.createElement("img");
  image.className = "opponent-scout__logo-image";
  image.alt = "";
  image.width = 58;
  image.height = 58;
  image.decoding = "async";
  image.addEventListener("load", () => image.classList.add("is-loaded"), { once: true });
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = logoUrl;
  mark.append(image);
  return mark;
}

function renderOpponentScout() {
  const source = state.opponentDataset?.source || {};
  const averages = source.teamAverages;
  const rotation = Array.isArray(source.rotation) ? source.rotation : [];
  if (!averages || rotation.length === 0) {
    throw new Error("This saved team-season does not include the totals needed for a historical style comparison yet.");
  }

  const fragment = document.createDocumentFragment();
  const teamHeader = document.createElement("div");
  teamHeader.className = "opponent-scout__team";
  teamHeader.append(createOpponentTeamMark(source));
  const teamCopy = document.createElement("div");
  const teamTitle = document.createElement("h4");
  teamTitle.textContent = `${source.teamName || teamNameForCode(source.team)} ${source.season}`;
  const teamNote = document.createElement("p");
  const phase = source.seasonPhase === "playoffs" ? "playoffs" : "regular season";
  const gameCount = source.teamGames !== null
    && source.teamGames !== undefined
    && Number.isFinite(Number(source.teamGames))
    && Number(source.teamGames) > 0
    ? `${source.teamGames}-game`
    : "Stored";
  teamNote.textContent = `${gameCount} denominator for the ${phase}, estimated from aggregate player minutes with the largest GP total as a lower bound. Team averages use only stats recorded with this team.`;
  teamCopy.append(teamTitle, teamNote);
  teamHeader.append(teamCopy);
  fragment.append(teamHeader);

  const stats = document.createElement("dl");
  stats.className = "opponent-scout__stats";
  const ownAverages = state.dataset?.source?.teamAverages || {};
  const deltaNote = document.createElement("p");
  deltaNote.className = "opponent-scout__delta-note";
  deltaNote.textContent = `Current is ${state.dataset?.source?.teamName || state.dataset?.source?.team || "the loaded player pool"}. Delta equals current minus opponent; positive turnovers are worse.`;
  const statRows = [
    ["points", "PTS", false],
    ["rebounds", "REB", false],
    ["assists", "AST", false],
    ["steals", "STL", false],
    ["blocks", "BLK", false],
    ["turnovers", "TOV", false],
    ["efgPct", "eFG%", true],
    ["threePct", "3P%", true],
  ];
  for (const [metric, label, percentage] of statRows) {
    const ownValue = Number(ownAverages[metric]);
    const opponentValue = Number(averages[metric]);
    const item = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    // "Current minus opponent" is used consistently for every stat. Turnover
    // deltas remain literal (and are explicitly labeled lower-is-better) so the
    // display never quietly flips a sourced number to make it look favorable.
    for (const [valueLabel, value] of [
      ["Current", percentage ? formatPercent(ownValue) : formatNumber(ownValue)],
      ["Opponent", percentage ? formatPercent(opponentValue) : formatNumber(opponentValue)],
      ["Δ current−opp.", formatSignedDifference(ownValue - opponentValue, { percentagePoints: percentage })],
    ]) {
      const valueWrap = document.createElement("span");
      const small = document.createElement("small");
      small.textContent = valueLabel;
      const strong = document.createElement("strong");
      strong.textContent = value;
      valueWrap.append(small, strong);
      detail.append(valueWrap);
    }
    if (metric === "turnovers") term.append(document.createTextNode(" · lower is better"));
    item.append(term, detail);
    stats.append(item);
  }
  fragment.append(deltaNote, stats);

  const rotationSection = document.createElement("section");
  rotationSection.className = "opponent-scout__section";
  const rotationHeading = document.createElement("h4");
  rotationHeading.textContent = "Minutes-based historical rotation";
  const rotationNote = document.createElement("p");
  rotationNote.textContent = "The nine largest minute shares from this team-season—not a live depth chart or injury report.";
  const rotationGrid = document.createElement("div");
  rotationGrid.className = "opponent-scout__rotation";
  for (const player of rotation) {
    const item = document.createElement("article");
    item.className = "opponent-player";
    item.append(createPlayerAvatar(player, "opponent-player__avatar"));
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = player.name;
    const context = document.createElement("small");
    const positions = Array.isArray(player.positions) ? player.positions.join("/") : String(player.positions || "-");
    context.textContent = `${positions} · ${formatNumber(player.minutesPerTeamGame)} minutes per team game`;
    copy.append(name, context);
    item.append(copy);
    rotationGrid.append(item);
  }
  rotationSection.append(rotationHeading, rotationNote, rotationGrid);
  fragment.append(rotationSection);

  const counter = document.createElement("section");
  counter.className = "opponent-scout__counter opponent-scout__section";
  const counterHeading = document.createElement("h4");
  counterHeading.textContent = "Suggested historical emphasis";
  const counterNote = document.createElement("p");
  counterNote.textContent = "A transparent heuristic based only on the displayed team-season gaps. Previewing it changes nothing; Apply updates only the strategy weights and can be undone here.";
  const strategy = deriveHistoricalCounterStrategy(state.dataset?.source?.teamAverages, averages);
  state.opponentStrategy = strategy;
  const reasonList = document.createElement("ul");
  for (const reason of strategy.reasons) {
    const item = document.createElement("li");
    item.textContent = reason;
    reasonList.append(item);
  }
  const applyButton = document.createElement("button");
  applyButton.className = "button button--quiet";
  applyButton.type = "button";
  const suggestionAlreadyApplied = objectiveWeightsMatch(state.weights, strategy.weights);
  applyButton.textContent = suggestionAlreadyApplied ? "Suggested weights applied" : "Apply suggested weights";
  applyButton.disabled = suggestionAlreadyApplied;
  applyButton.addEventListener("click", () => {
    // Keep one deliberate undo boundary. A later manual slider or preset edit
    // clears this snapshot because reverting through unrelated user changes
    // would be surprising.
    state.opponentWeightUndo = {
      weights: { ...state.weights },
      familyWeights: { ...state.familyWeights },
      activePreset: state.activePreset,
    };
    state.familyWeights = { ...strategy.familyWeights };
    state.weights = { ...strategy.weights };
    state.activePreset = "custom";
    renderPresetState();
    renderWeightControls();
    updateRunSummary();
    markScenarioChanged();
    renderOpponentScout();
    showToast(`Historical-emphasis weights applied for ${source.teamName || source.team}.`);
  });
  const actions = document.createElement("div");
  actions.className = "opponent-scout__actions";
  actions.append(applyButton);
  if (state.opponentWeightUndo) {
    const undoButton = document.createElement("button");
    undoButton.className = "text-button";
    undoButton.type = "button";
    undoButton.textContent = "Undo weight change";
    undoButton.addEventListener("click", () => {
      const prior = state.opponentWeightUndo;
      if (!prior) return;
      state.weights = { ...prior.weights };
      state.familyWeights = { ...prior.familyWeights };
      state.activePreset = prior.activePreset;
      state.opponentWeightUndo = null;
      renderPresetState();
      renderWeightControls();
      updateRunSummary();
      markScenarioChanged();
      renderOpponentScout();
      showToast("Previous strategy weights restored.");
    });
    actions.append(undoButton);
  }
  counter.append(
    counterHeading,
    counterNote,
    reasonList,
    renderCounterWeightPreview(strategy),
    actions,
  );
  fragment.append(counter);

  elements.opponentScoutSummary.replaceChildren(fragment);
  elements.opponentScoutSummary.hidden = false;
  // The optional section starts collapsed so it does not slow the main build,
  // but reveal the completed evidence when a visitor explicitly asked for it.
  elements.opponentScout.open = true;
  setOpponentScoutStatus(
    `${source.teamName || source.team} ${source.season} comparison ready. Review the sourced averages, signed gaps, and optional weight preview below.`,
    "success",
  );
}

async function loadOpponentScout() {
  if (state.opponentLoading || state.liveDataLoading) return;
  const selection = selectionFromControls();
  if (!liveSelectionMatches(state.loadedLiveSelection, selection)) {
    clearOpponentScout("Apply the selected team-season above before building an opponent scouting cue.");
    return;
  }
  const team = elements.opponentTeam.value;
  if (!team || team === selection.team) {
    setOpponentScoutStatus("Choose a different team from the same season and phase.", "error");
    return;
  }

  const teamName = teamNameForCode(team);
  let staleResponseMessage = "";
  setOpponentLoading(true);
  setOpponentScoutStatus(`Comparing ${teamName} ${nbaSeasonLabel(selection.season)} historical averages and rotation...`);
  try {
    const cached = readCachedLiveDataset(team, selection.season, selection.seasonPhase);
    const dataset = cached?.fresh
      ? cached.dataset
      : await fetchSupabaseNbaTeamDataset({
        team,
        season: selection.season,
        seasonPhase: selection.seasonPhase,
      });
    if (!cached?.fresh) cacheLiveDataset(team, selection.season, selection.seasonPhase, dataset);

    // The primary team, season, phase, or opponent can change while Supabase is
    // responding. Accept the result only when it still belongs to both the
    // loaded player pool and the controls that launched this request; otherwise
    // an older scout could be displayed (and its weights applied) to a newer
    // scenario.
    const currentSelection = selectionFromControls();
    const requestStillMatches = liveSelectionMatches(currentSelection, selection)
      && liveSelectionMatches(state.loadedLiveSelection, selection)
      && elements.opponentTeam.value === team;
    if (!requestStillMatches) {
      state.opponentDataset = null;
      state.opponentStrategy = null;
      state.opponentWeightUndo = null;
      elements.opponentScoutSummary.hidden = true;
      elements.opponentScoutSummary.replaceChildren();
      staleResponseMessage = "The team, season, phase, or opponent changed while the comparison was loading. Load the selected team-season, then build the scouting cue again.";
      return;
    }

    state.opponentDataset = dataset;
    renderOpponentScout();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The historical style comparison could not be loaded.";
    state.opponentDataset = null;
    state.opponentStrategy = null;
    state.opponentWeightUndo = null;
    elements.opponentScoutSummary.hidden = true;
    setOpponentScoutStatus(detail, "error");
  } finally {
    setOpponentLoading(false);
    // setOpponentLoading repopulates the opponent control and may publish its
    // generic pending-selection hint. Restore the more useful race explanation
    // after that housekeeping finishes.
    if (staleResponseMessage) setOpponentScoutStatus(staleResponseMessage, "warning");
  }
}

function teamValues() {
  return [...new Set((state.dataset?.players || []).map((player) => player.team).filter(Boolean))];
}

function currentPlayer(id) {
  return state.dataset?.players.find((player) => player.id === id) || null;
}

/**
 * Apply the visitor's position-flexibility assumption without mutating the
 * imported Basketball Reference row.
 *
 * The source records listed positions, not possession-level position minutes.
 * The default therefore separates two kinds of evidence:
 *   1. positions listed for this team-season can cover a full role;
 *   2. extra positions verified on the player's career profile can help, but
 *      are capped at 24 rotation role-minutes as a conservative assumption.
 *
 * "Open" removes that assumption, while "Strict" ignores career-only roles.
 * CSV/demo players without structured evidence retain their supplied positions
 * in every policy because the app cannot safely infer a narrower list.
 */
function playersForPositionPolicy(players, policy, mode) {
  const normalizedPolicy = ["recommended", "open", "seasonOnly"].includes(policy)
    ? policy
    : "recommended";
  return players.map((player) => {
    const listed = Array.isArray(player?.positionEvidence?.seasonListed)
      ? player.positionEvidence.seasonListed.filter((position) => ["G", "F", "C"].includes(position))
      : [];
    const verified = Array.isArray(player.positions)
      ? player.positions.filter((position) => ["G", "F", "C"].includes(position))
      : [];
    if (listed.length === 0) {
      return { ...player, positions: [...verified], positionMinuteCaps: {} };
    }
    if (normalizedPolicy === "seasonOnly") {
      return { ...player, positions: [...new Set(listed)], positionMinuteCaps: {} };
    }
    if (normalizedPolicy === "open" || mode !== "rotation") {
      return { ...player, positions: [...new Set(verified)], positionMinuteCaps: {} };
    }

    const listedSet = new Set(listed);
    const positionMinuteCaps = {};
    for (const position of verified) {
      if (!listedSet.has(position)) positionMinuteCaps[position] = 24;
    }
    return {
      ...player,
      positions: [...new Set(verified)],
      positionMinuteCaps,
    };
  });
}

function optimizerPlayersForCurrentScenario() {
  return playersForPositionPolicy(
    state.dataset?.players || [],
    elements.positionFlexibility.value,
    elements.mode.value,
  );
}

function applyPreset(uiPreset, { announce = false, invalidate = true } = {}) {
  const enginePreset = UI_TO_ENGINE_PRESET[uiPreset] || "balanced";
  const familyPreset = DEFAULT_FAMILY_PRESETS[enginePreset] || DEFAULT_FAMILY_PRESETS.balanced;
  state.activePreset = uiPreset;
  state.familyWeights = { ...familyPreset };
  state.weights = weightsFromSkillFamilies(state.familyWeights);
  renderPresetState();
  renderWeightControls();
  updateRunSummary();
  if (invalidate) markScenarioChanged();
  if (invalidate && state.opponentDataset) {
    state.opponentWeightUndo = null;
    renderOpponentScout();
  }
  if (announce) showToast(`${PRESET_LABELS[uiPreset]} strategy loaded.`);
}

function renderPresetState() {
  $$("[data-preset]").forEach((button) => {
    const selected = button.dataset.preset === state.activePreset;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function renderWeightControls() {
  $$('[data-family]').forEach((input) => {
    input.value = String(state.familyWeights[input.dataset.family] ?? 0);
    const output = input.parentElement.querySelector("output");
    output.textContent = input.value;
  });
  renderWeightShareSummary();
}

/**
 * Translate raw slider values into the proportions the solver actually uses.
 * This prevents the controls from looking like a hidden 100-point budget:
 * 20 / 10 / 0 and 2 / 1 / 0 are intentionally the same strategy.
 */
function renderWeightShareSummary() {
  const entries = Object.entries(state.familyWeights)
    .map(([family, value]) => [family, Math.max(0, Number(value) || 0)])
    .filter(([, value]) => value > 0);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (!(total > 0)) {
    elements.weightShareSummary.textContent = "Choose at least one priority above zero.";
    return;
  }
  const unroundedShares = entries
    .map(([family, value]) => ({
      label: FAMILY_LABELS[family] || titleCase(family),
      exactShare: (value / total) * 100,
    }));
  // Largest-remainder rounding keeps the friendly whole-number display while
  // guaranteeing that the visible proportions add to exactly 100%. Rounding
  // every metric independently made the default Balanced preset appear to use
  // 101%, which undermined the explanation that only proportions matter.
  let percentagePointsRemaining = 100 - unroundedShares.reduce(
    (sum, item) => sum + Math.floor(item.exactShare),
    0,
  );
  const remainderOrder = [...unroundedShares].sort((left, right) => (
    (right.exactShare - Math.floor(right.exactShare))
    - (left.exactShare - Math.floor(left.exactShare))
    || left.label.localeCompare(right.label)
  ));
  const awarded = new Set(remainderOrder.slice(0, percentagePointsRemaining).map((item) => item.label));
  const shares = unroundedShares
    .map((item) => ({
      label: item.label,
      share: Math.floor(item.exactShare) + (awarded.has(item.label) ? 1 : 0),
    }))
    .sort((left, right) => right.share - left.share || left.label.localeCompare(right.label));
  elements.weightShareSummary.textContent = `Your relative focus: ${shares.map(({ label, share }) => `${label} ${share}%`).join(" · ")}.`;
}

function selectedRotationPositionRequirements() {
  if (elements.rotationPositionProfile.value === "automatic") {
    return deriveHistoricalPositionMinuteRequirements(
      state.dataset?.players || [],
      appearanceMinuteAnchorsForPositionMix(),
    );
  }
  const selected = ROTATION_POSITION_PROFILES[elements.rotationPositionProfile.value]
    || ROTATION_POSITION_PROFILES.traditional;
  return { ...selected };
}

/**
 * Estimate the roster's sensible position mix from minutes per appearance,
 * never from games played or total minutes accumulated with this team. A
 * traded player averaging 34 minutes therefore contributes the same role
 * evidence whether this team row contains five games or fifty. The optimizer
 * still proves every G/F/C minute exactly after this neutral target is set.
 */
function appearanceMinuteAnchorsForPositionMix() {
  return Object.fromEntries((state.dataset?.players || [])
    .map((player) => [player.id, Number(player.minutes)])
    .filter(([, minutes]) => Number.isFinite(minutes) && minutes > 0));
}

/**
 * Build regulation-game workload anchors for the optional *display-only*
 * comparison beneath a Detailed result. Live rows carry aggregate player/team
 * minutes; older snapshots reconstruct the same historical share. These values
 * are no longer passed into Lineup Lab's optimizer, position target, or minute
 * allocator. Keeping the calculation here prevents reporting code from being
 * mistaken for a model input later.
 */
function historicalMinuteAnchorsForCurrentDataset() {
  const players = state.dataset?.players || [];
  const sourceTeamGames = Number(state.dataset?.source?.teamGames);
  const fallbackTeamGames = Math.max(...players.map((player) => Number(player.games) || 0), 0);
  const teamGames = sourceTeamGames > 0 ? sourceTeamGames : fallbackTeamGames;
  const anchors = {};
  for (const player of players) {
    const direct = Number(player.analytics?.historicalMinutesPerTeamGame);
    const totalMinutes = Number(player.analytics?.totals?.minutes);
    const teamTotalMinutes = Number(player.analytics?.teamTotalMinutes);
    const derivedFromTeamTotals = totalMinutes > 0 && teamTotalMinutes > 0
      ? (240 * totalMinutes) / teamTotalMinutes
      : null;
    const reconstructed = teamGames > 0
      ? ((Number(player.games) || 0) * (Number(player.minutes) || 0)) / teamGames
      : null;
    const anchor = direct > 0
      ? direct
      : derivedFromTeamTotals > 0
        ? derivedFromTeamTotals
        : reconstructed;
    if (Number.isFinite(anchor) && anchor > 0) anchors[player.id] = anchor;
  }
  return anchors;
}

/**
 * Give fans a useful confidence check before they run an exact search. This is
 * intentionally a source-coverage preview, not a claim that every eventual
 * selected player will be available or that a historical rotation is optimal.
 */
function renderRotationEvidencePreview() {
  const players = state.dataset?.players || [];
  if (players.length === 0) {
    elements.rotationEvidencePreview.textContent = "Load a team-season to check rate and impact evidence.";
    elements.simpleModelSummaryCopy.textContent = "Load a team and season to apply Lineup Lab's recommended sample and rotation safeguards.";
    elements.simpleModelSummaryNote.textContent = "Simple mode will explain any source limitation instead of guessing around it.";
    return;
  }
  const rateEvidenceCount = players.filter((player) => (
    player.analytics?.totals && player.analytics?.leaguePer36
  )).length;
  const impactEvidenceCount = players.filter((player) => (
    Number.isFinite(Number(player.analytics?.advanced?.offensive_box_plus_minus))
    && Number.isFinite(Number(player.analytics?.advanced?.defensive_box_plus_minus))
  )).length;
  const rateCopy = `${rateEvidenceCount} of ${players.length} have same-season rate evidence`;
  const impactCopy = `${impactEvidenceCount} of ${players.length} have OBPM and DBPM`;
  elements.rotationEvidencePreview.textContent = `Source check: ${rateCopy}; ${impactCopy}. Past team games and total minutes do not change the proposed allocation.`;
  if (elements.mode.value !== "rotation") {
    elements.simpleModelSummaryCopy.textContent = "The optimizer uses stats recorded with this team, applies the visible sample filter, and compares five-player profiles under your game plan.";
    elements.simpleModelSummaryNote.textContent = "Recommended sample and position rules are already active. Open Detailed only to change them.";
  } else {
    elements.simpleModelSummaryCopy.textContent = "The optimizer uses your game plan and hard player-minute limits. It adjusts low-opportunity rates instead of assuming they scale unchanged to a larger role.";
    elements.simpleModelSummaryNote.textContent = "Past team games and total minutes never restrict selection or assigned minutes; source MPG only helps describe the role being expanded.";
  }
}

function rotationPositionProfileForRequirements(requirements) {
  if (!requirements || typeof requirements !== "object") return "automatic";
  const namedProfile = Object.entries(ROTATION_POSITION_PROFILES).find(([, profile]) => (
    profile.G === Number(requirements.G)
    && profile.F === Number(requirements.F)
    && profile.C === Number(requirements.C)
  ))?.[0];
  if (namedProfile) return namedProfile;
  const automatic = deriveHistoricalPositionMinuteRequirements(
    state.dataset?.players || [],
    appearanceMinuteAnchorsForPositionMix(),
  );
  if (["G", "F", "C"].every((position) => automatic[position] === Number(requirements[position]))) {
    return "automatic";
  }
  return "automatic";
}

function syncRotationModelControls() {
  // The legacy core can still reproduce old experiments, but this product no
  // longer exposes or sends the team-stint workload guardrail. Force the
  // reviewed product rule even if a stale DOM value or shared URL says otherwise.
  elements.rotationMinutePlan.value = LINEUP_LAB_ROTATION_MINUTE_PLAN;
  // Retain these elements only for backward-compatible snapshots and URL
  // decoding. They are permanently hidden and disabled in the product UI.
  elements.rotationFlexibilityField.hidden = true;
  elements.rotationAllocationStyleField.hidden = true;
  elements.rotationFlexibility.disabled = true;
  elements.rotationFlexibilityField.classList.add("is-disabled");
  elements.rotationFlexibilityField.title = "Past team usage is display context only";
  elements.rotationAllocationStyle.disabled = true;
  elements.rotationAllocationStyleField.classList.add("is-disabled");
  elements.rotationAllocationStyleField.title = "Game-plan optimization always uses the user objective inside the hard player limits";
  elements.rotationMinutePlanHelp.replaceChildren(
    Object.assign(document.createElement("strong"), {
      textContent: "Game-plan optimization: ",
    }),
    document.createTextNode(
      "past team games and total minutes do not restrict the plan. The optimizer assigns players inside your hard limits according to the game plan, while it adjusts low-opportunity rates conservatively.",
    ),
  );
  elements.rotationAllocationStyleHelp.replaceChildren(
    Object.assign(document.createElement("strong"), {
      textContent: "Past usage is context only: ",
    }),
    document.createTextNode("Lineup Lab does not use source totals as a minute cap, target, or scoring input."),
  );

  const usesPer36Rates = elements.rotationScoringBasis.value === "per36";
  if (!usesPer36Rates) {
    if (elements.rotationRateStability.value !== "raw") {
      elements.rotationRateStability.dataset.per36Value = elements.rotationRateStability.value;
    }
    elements.rotationRateStability.value = "raw";
  } else if (elements.rotationRateStability.dataset.per36Value) {
    elements.rotationRateStability.value = elements.rotationRateStability.dataset.per36Value;
    delete elements.rotationRateStability.dataset.per36Value;
  }
  elements.rotationRateStability.disabled = !usesPer36Rates;
  elements.rotationRateStabilityField.classList.toggle("is-disabled", !usesPer36Rates);
  elements.rotationRateStabilityField.title = usesPer36Rates
    ? "Choose whether limited role/attempt volume and larger-role projections are adjusted toward a same-season baseline"
    : "Per-game comparison uses raw source values, so rate stabilization does not apply";
  elements.rotationRateStabilityHelp.textContent = usesPer36Rates
    ? "When the source has matching evidence for every eligible player, the model stabilizes each stat with its own role-or-attempt-volume requirement. Past team totals are excluded. As a player expands beyond an established role, only an unproven advantage decays smoothly toward a conservative same-season bound; a below-baseline projection never improves just because more minutes were assigned. If evidence is incomplete, that stat stays raw for everyone."
    : "Per-game comparison uses raw historical per-game lines. Limited-role adjustment is available only with per-36 comparison.";
  renderRotationEvidencePreview();
}

function rotationModelSummary() {
  return "Game plan · projected rates + hard limits";
}

function syncRotationRoleCopy(isRotation = elements.mode.value === "rotation") {
  const roleMinutes = selectedRotationPositionRequirements();
  const automatic = elements.rotationPositionProfile.value === "automatic";
  const positionEvidence = automatic
    ? assessHistoricalPositionMinuteEvidence(
      state.dataset?.players || [],
      appearanceMinuteAnchorsForPositionMix(),
    )
    : null;
  const estimateCopy = positionEvidence?.fallbackApplied
    ? "No usable source-listed position and minutes-per-appearance evidence was available, so the standard 96 guard / 96 forward / 48 center estimate is used."
    : `${positionEvidence?.usableRows || 0} of ${positionEvidence?.sourceRows || 0} roster rows have both a source-listed position and minutes-per-appearance evidence; past team games are not used.`;
  const positionPolicy = elements.positionFlexibility.value;
  const policyCopy = positionPolicy === "seasonOnly"
    ? "Strict uses only the position listed for this team-season."
    : positionPolicy === "open"
      ? "Open lets every verified Basketball Reference career position cover an unrestricted role."
      : isRotation
        ? "Realistic leaves season-listed roles unrestricted and caps each verified career-only secondary role at 24 rotation minutes. That cap is a disclosed modeling assumption, not tracked historical position time."
        : "Realistic allows verified Basketball Reference career positions; each player can still fill only one required lineup slot.";
  elements.positionCoverageHelp.textContent = isRotation
    ? `Roster balance is a minimum composition rule. The ${automatic ? "roster role estimate" : "selected mix"} is ${roleMinutes.G} guard, ${roleMinutes.F} forward, and ${roleMinutes.C} center minutes. ${policyCopy} The automatic mix uses season-listed positions and minutes per appearance, never source totals. ${automatic ? estimateCopy : ""}`
    : `${policyCopy} For example, a PF-C may fill a forward or center requirement, but never both slots at once.`;
  elements.rotationMinutesHelp.textContent = `Every candidate receives exactly 240 integer minutes while covering the same ${roleMinutes.G} guard, ${roleMinutes.F} forward, and ${roleMinutes.C} center minute target.`;
  elements.rotationPositionProfile.title = automatic
    ? "An estimate from season-listed positions and minutes per appearance. Games played and source totals are excluded."
    : "A manual advanced position-minute experiment";
}

function setMobileResultCurrent(current) {
  elements.mobileSolveBar.classList.toggle("is-result-current", current);
  if (current) {
    elements.mobileSolveLabel.textContent = "Result up to date ✓";
    return;
  }
  // The success state becomes an inline confirmation on narrow screens rather
  // than a persistent overlay, so it cannot cover player cards while someone
  // reads their result. Restore the actionable scenario label as soon as an
  // input changes so mobile users and assistive technology never hear stale
  // success feedback.
  elements.mobileSolveLabel.textContent = elements.mode.value === "rotation"
    ? `${numberFromInput(elements.size, 9)}-player rotation · all 240 team minutes`
    : "Starting five";
}

function updateRunSummary() {
  const modeLabel = elements.mode.value === "rotation"
    ? `${numberFromInput(elements.size, 9)}-player rotation · all 240 team minutes`
    : "Starting five";
  elements.runModeSummary.textContent = modeLabel;
  if (!elements.mobileSolveBar.classList.contains("is-result-current")) {
    elements.mobileSolveLabel.textContent = modeLabel;
  }
  elements.runPresetSummary.textContent = PRESET_LABELS[state.activePreset] || "Custom mix";
  const isRotation = elements.mode.value === "rotation";
  elements.runMinuteModelRow.hidden = !isRotation;
  elements.runMinuteModelSummary.textContent = rotationModelSummary();
  elements.runLockedSummary.textContent = String(state.lockedIds.size);
  elements.runExcludedSummary.textContent = String(state.excludedIds.size);
  renderRotationEvidencePreview();
  updateSearchScope();
}

function cancelOptimization(message = "Optimization cancelled because the scenario changed.") {
  // A solve has two stages: one animation-frame yield and then a Worker task.
  // Advancing the token invalidates both stages, including the brief interval
  // before a Worker instance exists, so an older solve can never repaint a
  // newer scenario or re-enable its controls out of order.
  const nextToken = state.optimizationRunId += 1;
  state.optimizationWorker?.terminate();
  state.optimizationWorker = null;
  const reject = state.optimizationReject;
  state.optimizationReject = null;
  state.activeOptimizationToken = null;
  elements.form.removeAttribute("aria-busy");
  if (reject) {
    const error = new Error(message);
    error.name = "AbortError";
    reject(error);
  }
  return nextToken;
}

function clearRenderedResult({ heading = "Your result will appear here", copy = "Pick a strategy, set any must-have rules, and run the optimizer. You will get a best group, alternatives, and a constraint check." } = {}) {
  state.lastResult = null;
  setMobileResultCurrent(false);
  elements.results.classList.remove("is-stale");
  elements.resultFreshness.hidden = true;
  elements.resultFreshness.textContent = "";
  elements.results.hidden = true;
  elements.emptyResult.hidden = false;
  elements.emptyResultHeading.textContent = heading;
  elements.emptyResultCopy.textContent = copy;
  elements.copyResult.disabled = true;
  elements.downloadResult.disabled = true;
  elements.shareScenario.disabled = true;
  elements.printReport.disabled = true;
}

function markScenarioChanged() {
  state.scenarioVersion += 1;
  setMobileResultCurrent(false);
  state.replacementAnalyses.clear();
  if (state.optimizationWorker || state.activeOptimizationToken !== null || state.replacementRunToken !== null) cancelOptimization();
  if (state.replacementRunToken !== null) {
    finishPendingReplacement("The scenario changed. Run the optimizer again before testing replacements.");
  }
  if (state.lastResult) {
    elements.results.classList.add("is-stale");
    elements.resultFreshness.hidden = false;
    elements.resultFreshness.textContent = "Settings changed after this result was calculated. Run the optimizer again before copying or downloading it.";
    elements.copyResult.disabled = true;
    elements.downloadResult.disabled = true;
    elements.shareScenario.disabled = true;
    elements.printReport.disabled = true;
    setSolverStatus("Settings changed - update the result", "warning");
  } else {
    setSolverStatus("Ready with your latest settings");
  }
  setOptimizeButtons({ label: solveActionLabel({ update: Boolean(state.lastResult) }) });
  updateSearchScope();
}

function setMode(mode, { preserveSize = false } = {}) {
  const isRotation = mode === "rotation";
  elements.rotationSettings.hidden = !isRotation;
  elements.rotationScoringBasisField.hidden = !isRotation;
  syncRotationModelControls();
  const productionQualifier = document.createElement("span");
  productionQualifier.textContent = "(optional requirements)";
  elements.productionRulesLegend.replaceChildren(
    document.createTextNode(isRotation ? "Projected rotation production " : "Combined player profiles "),
    productionQualifier,
  );
  elements.productionRulesHelp.textContent = isRotation
    ? "For every candidate, these rules use the exact 240-minute plan to create minute-weighted per-game team projections. They are historical-stat estimates, not game predictions."
    : "In lineup mode, these rules add each selected player's historical per-game line. They describe the five-player profile; they do not forecast one team box score.";
  syncRotationRoleCopy(isRotation);
  elements.size.min = isRotation ? "8" : "5";
  elements.size.max = isRotation ? "12" : "5";
  if (!preserveSize) elements.size.value = isRotation ? "9" : "5";
  if (isRotation) {
    elements.minGuards.value = "3";
    elements.minForwards.value = "3";
    elements.minCenters.value = "2";
  } else {
    elements.minGuards.value = "2";
    elements.minForwards.value = "2";
    elements.minCenters.value = "1";
  }
  updateRunSummary();
}

function recommendedMinimumGames(seasonPhase, mode = "lineup") {
  // A rotation's conservative role/volume projection already handles limited
  // evidence. Applying a hidden team-stint games floor on top would exclude a
  // traded player solely because fewer appearances came with this team—the
  // exact behavior the product now forbids. Starting-five mode keeps a modest,
  // visible sample filter because it has no minute/role projection layer.
  if (mode === "rotation") return 0;
  // Keep the lineup-only default phase-aware so a short postseason is not
  // treated like an 82-game regular season.
  return seasonPhase === "playoffs" ? 3 : 20;
}

function recommendedMinimumMinutes(mode, seasonPhase) {
  // A regular-season rotation should be built from players who held a genuine
  // repeatable role. Postseason samples are shorter and benches tighten, so the
  // floor is intentionally lower there. Detailed mode still exposes the exact
  // field for historical edge cases and deliberate experiments.
  if (seasonPhase === "playoffs") return mode === "rotation" ? 4 : 3;
  return mode === "rotation" ? 8 : 6;
}

function solveActionLabel({ busy = false, update = false } = {}) {
  if (busy) return "Building…";
  const noun = elements.mode.value === "rotation" ? "rotation" : "lineup";
  return update ? `Rebuild ${noun}` : `Build ${noun}`;
}

function captureDetailedSettings() {
  const fields = [
    "alternatives",
    "minGames",
    "minMinutes",
    "minGuards",
    "minForwards",
    "minCenters",
    "minPoints",
    "minRebounds",
    "minAssists",
    "minSteals",
    "minBlocks",
    "maxTurnovers",
    "rotationMin",
    "rotationMax",
    "rotationMinutePlan",
    "rotationAllocationStyle",
    "rotationFlexibility",
    "rotationRateStability",
    "rotationScoringBasis",
    "rotationPositionProfile",
    "positionFlexibility",
  ];
  return {
    fields: Object.fromEntries(fields.map((name) => [name, elements[name].value])),
    activePreset: state.activePreset,
    familyWeights: { ...state.familyWeights },
    weights: { ...state.weights },
    analyticsView: state.analyticsView,
    simplePresetAtEntry: null,
  };
}

function restoreDetailedSettings() {
  const snapshot = state.detailedSettingsSnapshot;
  if (!snapshot) return false;
  for (const [name, value] of Object.entries(snapshot.fields || {})) {
    const input = elements[name];
    if (input && value !== undefined) input.value = value;
  }

  // Presets remain visible in Simple mode. Preserve a game-plan change made
  // there, but restore custom Detailed weights when the visitor simply returns
  // without changing that visible choice.
  if (state.activePreset === snapshot.simplePresetAtEntry) {
    state.activePreset = snapshot.activePreset;
    state.familyWeights = { ...snapshot.familyWeights };
    state.weights = { ...snapshot.weights };
  }
  state.analyticsView = snapshot.analyticsView;
  elements.analyticsView.value = state.analyticsView;
  state.detailedSettingsSnapshot = null;
  renderPresetState();
  renderWeightControls();
  syncRotationModelControls();
  syncRotationRoleCopy();
  updateRunSummary();
  renderPlayerTable();
  return true;
}

function applySimpleModelDefaults({ invalidate = false } = {}) {
  const phase = state.loadedLiveSelection?.seasonPhase
    || elements.liveSeasonPhase.value
    || DEFAULT_SEASON_PHASE;
  const isRotation = elements.mode.value === "rotation";

  // Simple mode is a complete, opinionated model—not a CSS mask over unknown
  // advanced settings. Reset every hidden input that can change selection so a
  // visitor never receives a result controlled by an invisible experiment.
  elements.alternatives.value = "3";
  const recommendedGames = recommendedMinimumGames(phase, elements.mode.value);
  elements.minGames.value = String(recommendedGames);
  state.recommendedMinGames = recommendedGames;
  elements.minMinutes.value = String(recommendedMinimumMinutes(elements.mode.value, phase));
  // A rotation already has the stronger exact G/F/C minute-flow proof. Hidden
  // 3/3/2 roster-count minimums could reject a group that covers every one of
  // those role minutes (especially on a thin historical roster), so Simple
  // mode does not stack a redundant invisible composition rule on top.
  elements.minGuards.value = isRotation ? "0" : "2";
  elements.minForwards.value = isRotation ? "0" : "2";
  elements.minCenters.value = isRotation ? "0" : "1";
  for (const input of [
    elements.minPoints,
    elements.minRebounds,
    elements.minAssists,
    elements.minSteals,
    elements.minBlocks,
    elements.maxTurnovers,
  ]) input.value = "";
  elements.rotationMin.value = "8";
  elements.rotationMax.value = "40";
  // Team-stint workload is display-only throughout the product. Reapply the
  // invariant here so returning from Detailed cannot resurrect an old saved
  // setting that changes rotation feasibility.
  elements.rotationMinutePlan.value = LINEUP_LAB_ROTATION_MINUTE_PLAN;
  elements.rotationAllocationStyle.value = "strategyFirst";
  elements.rotationFlexibility.value = "8";
  elements.rotationRateStability.value = "sampleAdjusted";
  elements.rotationScoringBasis.value = "per36";
  elements.rotationPositionProfile.value = "automatic";
  elements.positionFlexibility.value = "recommended";
  state.analyticsView = "perGame";
  elements.analyticsView.value = "perGame";
  if (state.activePreset === "custom") applyPreset("balanced", { invalidate: false });
  $$('details.detailed-only[open]').forEach((details) => details.removeAttribute("open"));
  syncRotationModelControls();
  syncRotationRoleCopy(isRotation);
  updateRunSummary();
  renderPlayerTable();
  if (invalidate) markScenarioChanged();
}

function setExperienceMode(
  mode,
  { applyDefaults = true, invalidate = false, announce = false } = {},
) {
  const nextMode = mode === "detailed" ? "detailed" : "simple";
  const priorMode = state.experienceMode;
  const movingFromDetailedToSimple = nextMode === "simple" && priorMode === "detailed" && applyDefaults;
  const savedDetailedSettings = movingFromDetailedToSimple;
  if (movingFromDetailedToSimple) state.detailedSettingsSnapshot = captureDetailedSettings();
  state.experienceMode = nextMode;
  const detailed = nextMode === "detailed";
  document.body.dataset.experienceMode = nextMode;
  elements.simpleMode.classList.toggle("is-active", !detailed);
  elements.detailedMode.classList.toggle("is-active", detailed);
  elements.simpleMode.setAttribute("aria-pressed", String(!detailed));
  elements.detailedMode.setAttribute("aria-pressed", String(detailed));
  elements.playersStepNumber.textContent = detailed ? "3" : "2";
  elements.playersStepNumber.setAttribute("aria-label", `Step ${detailed ? "3" : "2"}`);

  let restoredDetailedSettings = false;
  if (!detailed) {
    if ($('[data-view="optimizer"]')?.hidden) switchView("optimizer");
    if (applyDefaults) {
      applySimpleModelDefaults({ invalidate });
      if (state.detailedSettingsSnapshot) {
        state.detailedSettingsSnapshot.simplePresetAtEntry = state.activePreset;
      }
    }
  } else if (priorMode === "simple") {
    restoredDetailedSettings = restoreDetailedSettings();
    if (restoredDetailedSettings) markScenarioChanged();
  }
  if (announce) {
    showToast(restoredDetailedSettings
      ? "Detailed view restored your prior advanced settings. Rebuild the result to apply them."
      : detailed
        ? "Detailed view opened. Every model control and report is available."
        : savedDetailedSettings
          ? "Simple view opened with recommended defaults. Your prior detailed settings are saved until you return."
          : "Simple view uses recommended defaults and keeps the essential controls in focus.");
  }
}

function applyLoadedPhaseEligibilityDefault(seasonPhase) {
  const nextDefault = recommendedMinimumGames(seasonPhase, elements.mode.value);
  const preserveSharedValue = state.preserveSharedMinGamesOnNextLoad;
  state.preserveSharedMinGamesOnNextLoad = false;
  if (!preserveSharedValue && numberFromInput(elements.minGames, state.recommendedMinGames) === state.recommendedMinGames) {
    elements.minGames.value = String(nextDefault);
  }
  state.recommendedMinGames = nextDefault;
}

function isPlayerEligible(player) {
  return player.games >= numberFromInput(elements.minGames, 0)
    && player.minutes >= numberFromInput(elements.minMinutes, 0);
}

function createCell(row, text, className = "", label = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (label) cell.dataset.label = label;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function initialsForDisplay(value, fallback = "NBA") {
  const initials = String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials || fallback;
}

function updateDatasetMediaSummary() {
  const source = state.dataset?.source || {};
  const headshotPlayers = state.dataset?.players.filter((player) => safeExternalImageUrl(player.headshotUrl)) || [];
  const failedHeadshots = headshotPlayers.filter((player) => state.playerMediaStatus.get(player.id) === "failed").length;
  const usableHeadshots = Math.max(0, headshotPlayers.length - failedHeadshots);
  const hasLogoUrl = Boolean(safeExternalImageUrl(source.teamLogoUrl));
  const usableLogo = hasLogoUrl && state.teamLogoStatus !== "failed";
  const mediaParts = [];
  if (usableHeadshots) mediaParts.push(`${usableHeadshots} player headshot${usableHeadshots === 1 ? "" : "s"}`);
  if (usableLogo) mediaParts.push("team logo");

  if (mediaParts.length === 0) {
    elements.datasetMedia.textContent = "Player initials and the team mark are shown; no confirmed photos or logo is available for this pool.";
    return;
  }
  const availability = `${mediaParts.join(" and ")} available.`;
  const fallbacks = [];
  if (failedHeadshots) {
    fallbacks.push(`initials substituted for ${failedHeadshots} headshot${failedHeadshots === 1 ? "" : "s"} that could not load`);
  }
  if (hasLogoUrl && !usableLogo) fallbacks.push("team mark substituted for the logo that could not load");
  elements.datasetMedia.textContent = fallbacks.length
    ? `${availability} ${fallbacks.join("; ")}.`
    : `${availability} Initials stay in place until each remote image loads.`;
}

function recordPlayerMediaStatus(player, imageUrl, status) {
  // Lazy images from an old team can finish after the player pool changes.
  // Accept a result only when both the player ID and confirmed URL still match
  // the current dataset, preventing stale events from changing the new summary.
  const current = currentPlayer(String(player?.id || ""));
  if (!current || safeExternalImageUrl(current.headshotUrl) !== imageUrl) return;
  if (status === "failed" && state.playerMediaStatus.get(current.id) === "loaded") return;
  state.playerMediaStatus.set(current.id, status);
  updateDatasetMediaSummary();
}

function createPlayerAvatar(player, className = "player-avatar") {
  // Every player gets a stable visual footprint. A confirmed headshot overlays
  // the initials when it loads; a network failure simply leaves the useful
  // initials fallback in place instead of showing a broken-image icon.
  const visual = document.createElement("span");
  visual.className = className;
  visual.setAttribute("aria-hidden", "true");

  const fallback = document.createElement("span");
  fallback.className = `${className}__fallback`;
  fallback.textContent = initialsForDisplay(player?.name);
  visual.append(fallback);

  const imageUrl = safeExternalImageUrl(player?.headshotUrl);
  if (!imageUrl) return visual;

  const image = document.createElement("img");
  image.className = `${className}__image`;
  image.alt = "";
  image.width = 80;
  image.height = 80;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("load", () => {
    image.classList.add("is-loaded");
    recordPlayerMediaStatus(player, imageUrl, "loaded");
  }, { once: true });
  image.addEventListener("error", () => {
    recordPlayerMediaStatus(player, imageUrl, "failed");
    image.remove();
  }, { once: true });
  image.src = imageUrl;
  visual.append(image);
  return visual;
}

function createTableCheckbox(player, action, label, checked, disabled = false) {
  // The visible checkbox stays compact, while its label provides a full 44px
  // pointer/touch target. Keeping data-action on the input preserves delegated
  // change handling and keyboard behavior.
  const target = document.createElement("label");
  target.className = "table-check-target";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "table-check";
  input.dataset.action = action;
  input.dataset.playerId = player.id;
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute("aria-label", `${label} ${player.name}`);
  target.append(input);
  return target;
}

/**
 * Keep the active hard rules and convenience selections visible above a long
 * roster table. This is deliberately a summary of state—not another way to
 * select a player—so a fan can undo a choice without hunting through 20-plus
 * mobile cards or horizontal desktop columns.
 */
function renderActiveSelectionTray() {
  if (!state.dataset) return;
  const entries = [];
  const selectionTypes = [
    ["lock", state.lockedIds, "Must include"],
    ["exclude", state.excludedIds, "Do not use"],
    ["compare", state.compareIds, "Compare"],
    ["watch", state.watchlistIds, "Watch"],
  ];
  for (const [action, ids, label] of selectionTypes) {
    for (const id of ids) {
      const player = currentPlayer(id);
      if (!player) continue;
      entries.push({ action, id, label, player });
    }
  }

  elements.activeSelectionTray.replaceChildren();
  elements.activeSelectionTray.hidden = entries.length === 0;
  if (entries.length === 0) return;
  const heading = document.createElement("strong");
  heading.textContent = "Active choices";
  elements.activeSelectionTray.append(heading);
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `selection-chip selection-chip--${entry.action}`;
    button.dataset.selectionAction = entry.action;
    button.dataset.playerId = entry.id;
    button.textContent = `${entry.label}: ${entry.player.name} ×`;
    button.setAttribute("aria-label", `Remove ${entry.player.name} from ${entry.label.toLowerCase()}`);
    elements.activeSelectionTray.append(button);
  }
}

function handleActiveSelectionRemoval(event) {
  const button = event.target.closest("[data-selection-action][data-player-id]");
  if (!button) return;
  const { selectionAction: action, playerId } = button.dataset;
  if (action === "lock") {
    state.lockedIds.delete(playerId);
    markScenarioChanged();
  } else if (action === "exclude") {
    state.excludedIds.delete(playerId);
    markScenarioChanged();
  } else if (action === "compare") {
    state.compareIds.delete(playerId);
    renderCompare();
  } else if (action === "watch") {
    state.watchlistIds.delete(playerId);
    state.watchlistSnapshots.delete(playerId);
    saveWatchlist();
    renderWatchlist();
  } else {
    return;
  }
  renderPlayerTable();
}

function restorePlayerControlFocus(focusTarget) {
  if (!focusTarget) return;
  const control = [...elements.playerTableBody.querySelectorAll("[data-action][data-player-id]")]
    .find((candidate) => (
      candidate.dataset.action === focusTarget.action
      && candidate.dataset.playerId === focusTarget.playerId
    ));
  control?.focus({ preventScroll: true });
}

function renderPlayerTable({ focusTarget = null } = {}) {
  if (!state.dataset) return;
  const query = elements.playerSearch.value.trim().toLocaleLowerCase();
  const players = state.dataset.players.filter((player) => (
    !query || `${player.name} ${player.team} ${player.positions.join(" ")}`.toLocaleLowerCase().includes(query)
  ));
  const fragment = document.createDocumentFragment();

  for (const player of players) {
    const row = document.createElement("tr");
    const eligible = isPlayerEligible(player);
    row.classList.toggle("is-ineligible", !eligible);
    row.classList.toggle("is-locked", state.lockedIds.has(player.id));
    row.classList.toggle("is-excluded", state.excludedIds.has(player.id));

    const nameCell = document.createElement("td");
    nameCell.dataset.label = "Player";
    const nameWrap = document.createElement("span");
    nameWrap.className = "player-name";
    const name = document.createElement("strong");
    name.textContent = player.name;
    const sample = document.createElement("small");
    sample.textContent = `${player.games} games${eligible ? "" : " - below current filter"}`;
    nameWrap.append(name, sample);
    const identity = document.createElement("span");
    identity.className = "player-name__identity";
    const avatar = createPlayerAvatar(player);
    if (avatar) identity.append(avatar);
    identity.append(nameWrap);
    nameCell.append(identity);
    row.append(nameCell);

    createCell(row, player.positions.join("/"), "", "Position");
    createCell(row, formatNumber(player.minutes), "", "MPG");
    createCell(row, formatNumber(player.points), "", "PTS");
    createCell(row, formatNumber(player.rebounds), "", "REB");
    createCell(row, formatNumber(player.assists), "", "AST");
    createCell(row, formatNumber(player.steals), "detailed-only-column", "STL");
    createCell(row, formatNumber(player.blocks), "detailed-only-column", "BLK");
    createCell(row, formatNumber(player.turnovers), "detailed-only-column", "TOV");

    const lockCell = createCell(row, "", "", "Lock");
    lockCell.append(createTableCheckbox(
      player,
      "lock",
      "Lock",
      state.lockedIds.has(player.id),
      state.excludedIds.has(player.id),
    ));
    const excludeCell = createCell(row, "", "", "Exclude");
    excludeCell.append(createTableCheckbox(
      player,
      "exclude",
      "Exclude",
      state.excludedIds.has(player.id),
      state.lockedIds.has(player.id),
    ));
    const compareCell = createCell(row, "", "detailed-only-column", "Compare");
    compareCell.append(createTableCheckbox(
      player,
      "compare",
      "Compare",
      state.compareIds.has(player.id),
      state.compareIds.size >= 4 && !state.compareIds.has(player.id),
    ));
    const watchCell = createCell(row, "", "detailed-only-column", "Save");
    const watchButton = document.createElement("button");
    watchButton.type = "button";
    watchButton.className = "watch-toggle";
    watchButton.classList.toggle("is-active", state.watchlistIds.has(player.id));
    watchButton.dataset.action = "watch";
    watchButton.dataset.playerId = player.id;
    watchButton.setAttribute("aria-pressed", String(state.watchlistIds.has(player.id)));
    watchButton.setAttribute(
      "aria-label",
      `${state.watchlistIds.has(player.id) ? "Remove" : "Add"} ${player.name} ${state.watchlistIds.has(player.id) ? "from" : "to"} watchlist`,
    );
    watchButton.textContent = state.watchlistIds.has(player.id) ? "★" : "☆";
    watchCell.append(watchButton);
    fragment.append(row);
  }

  elements.playerTableBody.replaceChildren(fragment);
  if (players.length === 0) {
    const row = document.createElement("tr");
    createCell(row, "No players match that search.", "loading-cell").colSpan = 13;
    elements.playerTableBody.append(row);
  }
  renderActiveSelectionTray();
  renderPoolSummary(players.length);
  updateRunSummary();
  elements.compareCount.textContent = String(state.compareIds.size);
  elements.watchlistCount.textContent = String(state.watchlistIds.size);
  restorePlayerControlFocus(focusTarget);
}

function renderPoolSummary(visiblePlayers = state.dataset?.players.length || 0) {
  if (!state.dataset) return;
  const eligible = state.dataset.players.filter(isPlayerEligible);
  elements.poolSummary.replaceChildren();
  const parts = [
    `${eligible.length} of ${state.dataset.players.length} meet the sample filters`,
    `${state.lockedIds.size} must include`,
    `${state.excludedIds.size} do not use`,
    `${visiblePlayers} player${visiblePlayers === 1 ? "" : "s"} shown`,
  ];
  for (const part of parts) {
    const span = document.createElement("span");
    span.textContent = part;
    elements.poolSummary.append(span);
  }
}

function setDataset(dataset, { clearScenario = true, liveSelection = null, notice = "" } = {}) {
  const validation = validateDataset(dataset);
  if (!validation.valid) {
    const detail = validation.errors.slice(0, 2).map((error) => error.message).join(" ");
    throw new Error(detail || "The player dataset is invalid.");
  }
  if (liveSelection?.seasonPhase) applyLoadedPhaseEligibilityDefault(liveSelection.seasonPhase);
  cancelOptimization("Optimization cancelled because the player pool changed.");
  if (state.replacementRunToken !== null) {
    finishPendingReplacement("The player pool changed. Run a new result before testing replacements.");
  }
  state.scenarioVersion += 1;
  state.dataset = dataset;
  state.loadedLiveSelection = liveSelection;
  state.playerMediaStatus.clear();
  state.teamLogoStatus = "unavailable";
  clearOpponentScout(liveSelection
    ? "Choose another team from this season and phase to load its averages and historical rotation."
    : "Load a database team-season above before building an opponent scouting cue.");
  if (clearScenario) {
    state.lockedIds.clear();
    state.excludedIds.clear();
    state.compareIds.clear();
    elements.playerSearch.value = "";
    clearRenderedResult();
  }
  applyPendingScenarioPlayerSelections(dataset);
  if (state.experienceMode === "simple") applySimpleModelDefaults({ invalidate: false });
  const availableIds = new Set(dataset.players.map((player) => player.id));
  state.compareIds = new Set([...state.compareIds].filter((id) => availableIds.has(id)));
  let migratedWatchlistSnapshot = false;
  for (const player of dataset.players) {
    if (state.watchlistIds.has(player.id) && !state.watchlistSnapshots.has(player.id)) {
      rememberWatchlistPlayer(player.id);
      migratedWatchlistSnapshot = true;
    }
  }
  if (migratedWatchlistSnapshot) saveWatchlist();
  renderDatasetMeta();
  renderPlayerTable();
  renderCompare();
  renderWatchlist();
  updateLiveSelectionState({ preserveStatus: true });
  populateOpponentTeamOptions();
  setSolverStatus("Ready to solve");
  setOptimizeButtons({ label: solveActionLabel() });
  if (notice) showToast(notice);
}

function renderDatasetMeta() {
  const source = state.dataset?.source || {};
  const teams = teamValues();
  const teamCode = teams.length === 1 ? teams[0] : "NBA";
  elements.datasetName.textContent = source.label || "Imported player data";
  elements.datasetSeason.textContent = source.season || "Custom";
  elements.datasetTeam.textContent = teams.length === 1 ? teams[0] : `${teams.length} teams`;
  elements.datasetCount.textContent = String(state.dataset?.players.length || 0);
  const teamLogoUrl = safeExternalImageUrl(source.teamLogoUrl);
  elements.teamLogo.onload = null;
  elements.teamLogo.onerror = null;
  elements.teamLogo.classList.remove("is-loaded");
  const showLogoFallback = () => {
    state.teamLogoStatus = teamLogoUrl ? "failed" : "unavailable";
    elements.teamLogo.classList.remove("is-loaded");
    elements.teamLogo.hidden = true;
    elements.teamLogo.removeAttribute("src");
    elements.teamLogo.alt = "";
    elements.teamLogoFallback.textContent = teamCode;
    elements.teamLogoFallback.hidden = false;
    updateDatasetMediaSummary();
  };

  // A historical logo is useful context, but it is never required for the
  // optimizer. Preserve the team-code mark if a remote image expires or is
  // blocked so choosing a season never creates a broken visual control.
  if (teamLogoUrl) {
    state.teamLogoStatus = "pending";
    elements.teamLogo.classList.remove("is-loaded");
    elements.teamLogo.onload = () => {
      // Ignore a late response belonging to a player pool that has since been
      // replaced, just as the player-headshot status tracker does.
      if (safeExternalImageUrl(state.dataset?.source?.teamLogoUrl) !== teamLogoUrl) return;
      state.teamLogoStatus = "loaded";
      elements.teamLogo.classList.add("is-loaded");
      elements.teamLogoFallback.hidden = true;
      updateDatasetMediaSummary();
    };
    elements.teamLogo.onerror = () => {
      if (safeExternalImageUrl(state.dataset?.source?.teamLogoUrl) === teamLogoUrl) showLogoFallback();
    };
    elements.teamLogo.alt = `${source.teamName || source.team || teamCode} logo`;
    elements.teamLogo.hidden = false;
    elements.teamLogoFallback.textContent = teamCode;
    elements.teamLogoFallback.hidden = false;
    elements.teamLogo.src = teamLogoUrl;
    updateDatasetMediaSummary();
  } else {
    showLogoFallback();
  }
  elements.sourceAttribution.replaceChildren();
  const dateLabel = source.provider ? "retrieved" : "snapshot";
  const lead = document.createTextNode(
    `${source.label || "Current dataset"}${source.snapshotDate ? `, ${dateLabel} ${source.snapshotDate}` : ""}. `,
  );
  elements.sourceAttribution.append(lead);
  const sourceUrl = safeExternalSourceUrl(source.url);
  if (sourceUrl) {
    const link = document.createElement("a");
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.provider ? "View the cited source table" : "View the cited source page";
    elements.sourceAttribution.append(link);
    if (source.note) elements.sourceAttribution.append(document.createTextNode(". "));
  }
  if (source.note) elements.sourceAttribution.append(document.createTextNode(source.note));
}

async function loadFixture({ notice = "" } = {}) {
  const loadGeneration = beginNonLiveDatasetLoad();
  try {
    const response = await fetch(FIXTURE_URL, { cache: "no-store" });
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    if (!response.ok) throw new Error(`Demo data could not be loaded (${response.status}).`);
    const rawDataset = await response.json();
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    const dataset = normalizeDataset(rawDataset, { strict: true, warnOnGeneratedId: false });
    setDataset(dataset, { notice });
  } catch (error) {
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    throw error;
  }
}

function handlePlayerControl(event) {
  const control = event.target.closest("[data-action][data-player-id]");
  if (!control) return;
  const { action, playerId } = control.dataset;
  if ((action === "watch" && event.type !== "click") || (action !== "watch" && event.type !== "change")) {
    return;
  }
  if (action === "watch") {
    if (state.watchlistIds.has(playerId)) {
      state.watchlistIds.delete(playerId);
      state.watchlistSnapshots.delete(playerId);
    } else {
      state.watchlistIds.add(playerId);
      rememberWatchlistPlayer(playerId);
    }
    saveWatchlist();
    renderPlayerTable({ focusTarget: { action, playerId } });
    renderWatchlist();
    return;
  }
  const checked = control.checked;
  if (action === "lock") {
    if (checked) {
      state.lockedIds.add(playerId);
      state.excludedIds.delete(playerId);
    } else state.lockedIds.delete(playerId);
    markScenarioChanged();
  }
  if (action === "exclude") {
    if (checked) {
      state.excludedIds.add(playerId);
      state.lockedIds.delete(playerId);
    } else state.excludedIds.delete(playerId);
    markScenarioChanged();
  }
  if (action === "compare") {
    if (checked && state.compareIds.size >= 4) {
      control.checked = false;
      showToast("Choose up to four players for a readable comparison.");
      return;
    }
    if (checked) state.compareIds.add(playerId);
    else state.compareIds.delete(playerId);
    renderCompare();
  }
  renderPlayerTable({ focusTarget: { action, playerId } });
}

function buildOptimizerConfig() {
  const statMinimums = {};
  const statInputs = {
    points: elements.minPoints,
    rebounds: elements.minRebounds,
    assists: elements.minAssists,
    steals: elements.minSteals,
    blocks: elements.minBlocks,
  };
  for (const [stat, input] of Object.entries(statInputs)) {
    if (state.experienceMode === "simple") continue;
    const value = optionalNumber(input);
    if (value !== undefined) statMinimums[stat] = value;
  }
  const config = {
    mode: elements.mode.value,
    size: numberFromInput(elements.size, elements.mode.value === "rotation" ? 9 : 5),
    alternatives: numberFromInput(elements.alternatives, 5),
    weights: { ...state.weights },
    lockedIds: [...state.lockedIds],
    excludedIds: [...state.excludedIds],
    minGames: numberFromInput(elements.minGames, 0),
    minMinutes: numberFromInput(elements.minMinutes, 0),
    positionMinimums: {
      G: numberFromInput(elements.minGuards, 0),
      F: numberFromInput(elements.minForwards, 0),
      C: numberFromInput(elements.minCenters, 0),
    },
    statMinimums,
  };
  const maxTurnovers = state.experienceMode === "detailed"
    ? optionalNumber(elements.maxTurnovers)
    : undefined;
  if (maxTurnovers !== undefined) config.maxTurnovers = maxTurnovers;
  if (config.mode === "rotation") {
    config.rotationOptions = {
      minMinutes: numberFromInput(elements.rotationMin, 8),
      maxMinutes: numberFromInput(elements.rotationMax, 40),
      // The exact allocator receives a rate-normalized priority rather than
      // raw per-game output by default. Projections still use source per-minute
      // production, so this changes only who earns time—not the unit math.
      scoringBasis: elements.rotationScoringBasis.value,
      // Team-stint games and total minutes are intentionally absent from this
      // payload. The exact allocator receives only the user's hard limits,
      // role requirements, and evidence-adjusted game-plan objective.
      minutePlan: LINEUP_LAB_ROTATION_MINUTE_PLAN,
      historicalAllocationStyle: elements.rotationAllocationStyle.value,
      minuteFlexibility: numberFromInput(elements.rotationFlexibility, 8),
      rateStability: elements.rotationRateStability.value,
      positionMinuteRequirements: selectedRotationPositionRequirements(),
    };
  }
  return config;
}

function assignedPosition(lineup, playerId) {
  for (const [position, ids] of Object.entries(lineup.positionAssignment || {})) {
    if (ids.includes(playerId)) return position;
  }
  return "UTIL";
}

function renderScoreCard(label, value, primary = false) {
  const card = document.createElement("div");
  card.className = `score-card${primary ? " score-card--primary" : ""}`;
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  card.append(labelNode, valueNode);
  return card;
}

function playerInsightFor(explanation, playerId) {
  return explanation?.selectedPlayers?.find((item) => item.playerId === playerId) || null;
}

function renderPlayerSeasonContext(player, insight) {
  const context = document.createElement("p");
  context.className = "lineup-player__context";
  const source = player.analytics?.source || state.dataset?.source || {};
  const sample = insight?.sample || analyticsRateViews(player).sample || {};
  const phase = source.phase === "playoffs" || source.seasonPhase === "playoffs"
    ? "Playoffs"
    : "Regular season";
  const parts = [
    source.season || state.dataset?.source?.season,
    source.team || player.team,
    phase,
    Number.isFinite(Number(sample.games)) ? `${formatNumber(sample.games, 0)} source games` : "",
    Number.isFinite(Number(sample.totalMinutes)) ? `${formatNumber(sample.totalMinutes, 0)} source minutes` : "",
  ].filter(Boolean);
  if (player.analytics?.postseasonAvailable === true) parts.push("Playoff stats available");
  context.textContent = parts.join(" · ");
  return context;
}

function renderRoleTags(roles = []) {
  const tags = document.createElement("div");
  tags.className = "role-tags";
  if (!Array.isArray(roles) || roles.length === 0) {
    const tag = document.createElement("span");
    tag.className = "role-tag role-tag--neutral";
    tag.textContent = "Role signal not established";
    tag.title = "The current comparison pool did not establish a statistical role signal for this player.";
    tags.append(tag);
    return tags;
  }
  roles.slice(0, 3).forEach((role) => {
    const tag = document.createElement("span");
    tag.className = "role-tag";
    const provisional = role.confidence === "small-sample";
    // Keep short-stint labels useful while making their uncertainty obvious at
    // the exact place a fan first sees them—not only in a later method note.
    tag.textContent = provisional
      ? `Limited evidence · ${role.shortLabel || role.label}`
      : role.shortLabel || role.label;
    tag.title = `${role.label}${provisional ? " (limited evidence; not counted toward role coverage)" : ""}: ${role.evidence?.[0] || "statistical role signal"}`;
    tags.append(tag);
  });
  return tags;
}

function renderExactObjectiveReasons(player, result, insight) {
  const details = document.createElement("details");
  details.className = "why-selected";
  const summary = document.createElement("summary");
  summary.textContent = "Why the exact model selected this player";
  details.append(summary);

  const rotationBasis = result?.diagnostics?.rotationScoringBasis;
  const rateStability = result?.diagnostics?.rotationRateStabilityEvidence;
  const minutePlan = result?.best?.rotation?.minutePlan;
  const historicalGuidance = result?.best?.rotation?.historicalGuidance;
  const minutePlanExplanation = minutePlan === "historicalAware"
    ? historicalGuidance?.applied
      ? historicalGuidance?.allocationStyleApplied === "preserveWorkload"
        ? `Your game-plan fit selected this roster. The optional recorded-workload rule then keeps the plan close to source usage inside its disclosed capacity window${historicalGuidance.status === "expanded-for-role-coverage" ? ", including the disclosed position-coverage expansion" : ""}.`
        : `${historicalGuidance.allocationStyleReason || "Minutes shift toward the best-fitting profiles inside the displayed recorded-minutes capacity caps."}`
      : `The optional past-minutes guardrail could not be applied, so minutes use the hard limits you set. ${historicalGuidance?.reason || "The report identifies the missing minutes evidence."}`
    : "Game-plan minutes optimize inside the hard limits you set; source usage did not affect this result.";
  const assignedRoleScoring = result?.best?.rotation?.diagnostics?.roleConditionedScoring;
  const roleProjectionCopy = assignedRoleScoring?.applied
    ? `Rates are stabilized toward the same-season NBA baseline, and the ${formatNumber(assignedRoleScoring.expandedMinutes, 0)} planned minute${Number(assignedRoleScoring.expandedMinutes) === 1 ? "" : "s"} beyond established roles are valued at that baseline before `
    : rateStability?.roleAdjustedPlayerMetricCount > 0
      ? `Because this rotation asks players to carry about ${formatNumber(rateStability.roleMinutesTarget, 1)} minutes each on average, limited-role rates are adjusted toward the same-season NBA baseline before `
      : rateStability?.applied
        ? "Smaller samples are stabilized toward the same-season NBA baseline before "
        : "";
  const basis = document.createElement("p");
  basis.textContent = rotationBasis === "per36"
    ? `${roleProjectionCopy}counting stats are ranked per 36 minutes. ${minutePlanExplanation} The contribution below reflects the proposed minutes.`
    : rotationBasis === "perGame"
      ? "This rotation uses the raw per-game comparison; the contribution below also reflects the proposed minutes."
      : "This lineup gives each selected player an equal share of the configured pool-relative objective.";
  details.append(basis);

  const contribution = result?.best?.playerContributions?.[player.id];
  const entries = Object.entries(contribution?.metrics || {})
    .filter(([, item]) => Number(item?.scoreContribution) > 0)
    .sort((left, right) => Number(right[1].scoreContribution) - Number(left[1].scoreContribution));
  const list = document.createElement("ul");
  if (entries.length) {
    entries.slice(0, 3).forEach(([metric, item]) => {
      const row = document.createElement("li");
      const percentile = Number(item.percentile);
      const percentileContext = item.assignedRoleAdjusted
        ? "percentile after the extra-minute adjustment"
        : "percentile in this search";
      row.textContent = `${resultMetricLabel(metric)}: ${formatOrdinal(percentile * 100)} ${percentileContext}; ${formatNumber(item.scoreContribution, 2)} points toward this result.`;
      list.append(row);
    });
    const total = document.createElement("li");
    total.textContent = `Contribution to this result: ${formatNumber(contribution.scoreContribution, 2)} of ${formatNumber(result.best.score)} game-plan-fit points in this search.`;
    list.append(total);
  } else {
    // The explanation layer remains useful if a future compatible optimizer
    // does not return player-level contributions. It is visibly labelled as a
    // pool-relative profile, not back-filled as an exact solver explanation.
    (insight?.whySelected || []).slice(0, 3).forEach((reason) => {
      const row = document.createElement("li");
      row.textContent = reason;
      list.append(row);
    });
  }
  details.append(list);
  return details;
}

function replacementResultElement(playerId) {
  return [...elements.resultContent.querySelectorAll("[data-replacement-result]")]
    .find((element) => element.dataset.replacementResult === playerId) || null;
}

function replacementButtonElement(playerId) {
  return [...elements.resultContent.querySelectorAll('[data-action="exact-replacement"]')]
    .find((element) => element.dataset.playerId === playerId) || null;
}

function replacementAnalysisMarkup(playerId, analysis) {
  const output = document.createElement("p");
  output.className = "exact-replacement__result";
  output.dataset.replacementResult = playerId;
  // Do not imply that a replacement is infeasible before the visitor asks the
  // exact solver to test one. The empty node gives the delegated handler a
  // stable place to render its result without layout-jumping the player card.
  if (analysis === undefined) {
    output.hidden = true;
    return output;
  }
  if (!analysis?.ok) {
    output.dataset.status = "unavailable";
    output.textContent = analysis?.message || "No feasible exact replacement was found under the current rules.";
    return output;
  }
  const deltas = analysis.deltas || {};
  const deltaParts = [
    `PTS ${formatSignedDifference(deltas.points)}`,
    `REB ${formatSignedDifference(deltas.rebounds)}`,
    `AST ${formatSignedDifference(deltas.assists)}`,
    `TOV ${formatSignedDifference(deltas.turnovers)}`,
  ].filter((part) => !part.endsWith("-"));
  output.textContent = `Exact replacement: ${analysis.replacementName}. ${deltaParts.join(" · ")}. This is the best feasible one-player swap while preserving every other selected player and current rule. Fit-score change is omitted because removing a player changes the percentile comparison pool.`;
  return output;
}

function renderExactReplacementPanel(player, result, insight) {
  const wrap = document.createElement("div");
  wrap.className = "exact-replacement";
  const cached = state.replacementAnalyses.get(`${state.scenarioVersion}:${player.id}`);
  const nearest = insight?.replacements?.byRemovedPlayerId?.[player.id];
  if (nearest) {
    const nearby = document.createElement("p");
    nearby.textContent = `Closest displayed alternative: ${nearest.summary} It may change more than one player.`;
    wrap.append(nearby);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button--quiet";
  button.dataset.action = "exact-replacement";
  button.dataset.playerId = player.id;
  button.textContent = "Test exact replacement";
  if (state.lockedIds.has(player.id)) {
    button.disabled = true;
    const unavailable = replacementAnalysisMarkup(player.id, {
      ok: false,
      message: "This player is locked by the current scenario. Unlock them to test a replacement.",
    });
    wrap.append(button, unavailable);
    return wrap;
  }
  wrap.append(button, replacementAnalysisMarkup(player.id, cached));
  return wrap;
}

function renderLineupPlayer(player, lineup, index, { result, insight } = {}) {
  const card = document.createElement("article");
  card.className = "lineup-player";
  const top = document.createElement("div");
  top.className = "lineup-player__top";
  const position = document.createElement("span");
  position.className = "position-pill";
  position.textContent = assignedPosition(lineup, player.id);
  const positionEvidence = player.positionEvidence;
  if (positionEvidence?.usesCareerProfile) {
    const seasonRoles = Array.isArray(positionEvidence.seasonListed) && positionEvidence.seasonListed.length
      ? positionEvidence.seasonListed.join("/")
      : "not supplied";
    const eligibleRoles = Array.isArray(positionEvidence.eligible) && positionEvidence.eligible.length
      ? positionEvidence.eligible.join("/")
      : player.positions.join("/");
    position.title = `Assigned ${position.textContent}. Eligible ${eligibleRoles}; season listing ${seasonRoles}; verified career-profile roles are available for this scenario.`;
  }
  const rank = document.createElement("span");
  rank.className = "lineup-player__rank";
  rank.textContent = String(index + 1).padStart(2, "0");
  top.append(position);
  if (lineup.rotation) {
    const minutes = document.createElement("strong");
    minutes.className = "lineup-player__minutes";
    minutes.textContent = `${Number(lineup.rotation.byId?.[player.id] || 0)} min`;
    top.append(minutes);
  }
  top.append(rank);
  const avatar = createPlayerAvatar(player, "lineup-player__portrait");
  const name = document.createElement("h3");
  name.textContent = player.name;
  const stats = document.createElement("dl");
  for (const metric of ["points", "rebounds", "assists"]) {
    const label = analyticsMetricShortLabel(metric);
    const value = analyticsValue(player, metric);

    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = analyticsMetricText(metric, value);
    wrap.append(dt, dd);
    stats.append(wrap);
  }
  // Simple mode keeps each card to the facts needed to scan a recommendation.
  // The audit trail, role proxies, replacement experiment, and inventory link
  // remain intact in Detailed view without turning the default answer into a
  // wall of secondary controls.
  const roleTags = renderRoleTags(insight?.roles);
  roleTags.classList.add("detailed-only");
  const exactReasons = renderExactObjectiveReasons(player, result, insight);
  exactReasons.classList.add("detailed-only");
  const replacementPanel = renderExactReplacementPanel(player, result, insight);
  replacementPanel.classList.add("detailed-only");
  const cardSearch = createCardSearchLink(player);
  cardSearch.classList.add("detailed-only");
  card.append(top);
  if (avatar) card.append(avatar);
  card.append(
    name,
    renderPlayerSeasonContext(player, insight),
    stats,
    roleTags,
    exactReasons,
    replacementPanel,
    cardSearch,
  );
  return card;
}

function renderContributionList(breakdown) {
  const list = document.createElement("ul");
  list.className = "contribution-list";
  const entries = Object.entries(breakdown || {}).sort(
    (left, right) => right[1].scoreContribution - left[1].scoreContribution,
  );
  for (const [metric, detail] of entries) {
    if (detail.weight <= 0) continue;
    const item = document.createElement("li");
    item.className = "metric-bar";
    const label = document.createElement("span");
    label.textContent = resultMetricLabel(metric);
    const track = document.createElement("span");
    track.className = "metric-bar__track";
    const fill = document.createElement("span");
    fill.className = "metric-bar__fill";
    fill.style.width = `${Math.max(2, Math.min(100, detail.averagePercentile * 100))}%`;
    track.append(fill);
    const value = document.createElement("strong");
    value.textContent = `${Math.round(detail.averagePercentile * 100)}`;
    item.append(label, track, value);
    list.append(item);
  }
  return list;
}

function auditRow(labelText, valueText, passed = true) {
  const row = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = labelText;
  const value = document.createElement("strong");
  value.className = passed ? "pass" : "fail";
  value.textContent = valueText;
  row.append(label, value);
  return row;
}

function renderAudit(audit) {
  const list = document.createElement("ul");
  list.className = "audit-list";
  list.append(auditRow(
    "Roster size",
    `${audit.exactSize.actual} / ${audit.exactSize.required}`,
    audit.exactSize.passed,
  ));
  const requiredPositions = Object.entries(audit.positionMinimums.required)
    .filter(([, count]) => count > 0)
    .map(([position, count]) => `${position} ${count}`)
    .join(", ") || "None";
  list.append(auditRow("Position slots", requiredPositions, audit.positionMinimums.passed));
  if (audit.lockedPlayers.requiredIds.length > 0) {
    list.append(auditRow(
      "Locked players",
      `${audit.lockedPlayers.includedIds.length} / ${audit.lockedPlayers.requiredIds.length}`,
      audit.lockedPlayers.passed,
    ));
  }
  for (const [stat, check] of Object.entries(audit.statMinimums.checks || {})) {
    list.append(auditRow(
      `${titleCase(stat)} ${audit.rotationMinutes ? "projected minimum" : "profile minimum"}`,
      `${formatNumber(check.actual)} / ${formatNumber(check.required)}`,
      check.passed,
    ));
  }
  if (audit.maxTurnovers.maximum !== null) {
    list.append(auditRow(
      audit.rotationMinutes ? "Projected turnover ceiling" : "Profile turnover ceiling",
      `${formatNumber(audit.maxTurnovers.actual)} / ${formatNumber(audit.maxTurnovers.maximum)}`,
      audit.maxTurnovers.passed,
    ));
  }
  if (audit.rotationMinutes) {
    list.append(auditRow(
      "Player-minutes",
      `${audit.rotationMinutes.actual} / ${audit.rotationMinutes.required}`,
      audit.rotationMinutes.passed,
    ));
  }
  if (audit.rotationPositionMinutes) {
    const required = audit.rotationPositionMinutes.required;
    const actual = audit.rotationPositionMinutes.actual;
    list.append(auditRow(
      "On-court role minutes",
      `G ${actual.G}/${required.G} · F ${actual.F}/${required.F} · C ${actual.C}/${required.C}`,
      audit.rotationPositionMinutes.passed,
    ));
  }
  return list;
}

function roleMinuteSummary(roleMinutes) {
  return Object.entries(roleMinutes || {})
    .filter(([, minutes]) => Number(minutes) > 0)
    .map(([role, minutes]) => `${role} ${minutes}`)
    .join(" · ");
}

function resultEvidenceItem(label, value, detail) {
  const item = document.createElement("div");
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  const detailNode = document.createElement("small");
  detailNode.textContent = detail;
  item.append(labelNode, valueNode, detailNode);
  return item;
}

function renderResultEvidence(result) {
  const source = state.dataset?.source || {};
  const strip = document.createElement("section");
  strip.className = "result-evidence";
  strip.setAttribute("aria-label", "Result evidence and limitations");
  const phase = source.seasonPhase === "playoffs" ? "Playoffs" : "Regular season";
  strip.append(resultEvidenceItem(
    "Stats used",
    `${source.teamName || source.team || "Selected team"} · ${source.season || "Season unavailable"}`,
    `${phase} stats recorded with this team from ${source.provider || source.label || "the loaded dataset"}`,
  ));

  if (result.best?.rotation) {
    strip.append(resultEvidenceItem(
      "Minute plan",
      "Game-plan allocation",
      "Past team games and total minutes did not affect selection or assigned minutes; only your game plan, position coverage, and hard limits did.",
    ));
  } else {
    strip.append(resultEvidenceItem(
      "Historical scope",
      "Selected team row",
      "Games and starts describe the source sample; they do not act as a player-quality score or minute target.",
    ));
  }

  const rateEvidence = result.diagnostics?.rotationRateStabilityEvidence;
  const assignedRoleScoring = result.best?.rotation?.diagnostics?.roleConditionedScoring;
  if (result.best?.rotation && rateEvidence?.applied) {
    const roleProjectionDetail = rateEvidence.roleAdjustedPlayerMetricCount > 0
      ? ` ${rateEvidence.roleAdjustedPlayers} player${rateEvidence.roleAdjustedPlayers === 1 ? " also had" : "s also had"} at least one rate adjusted for the ${formatNumber(rateEvidence.roleMinutesTarget, 1)}-minute average rotation role.`
      : "";
    const assignedRoleDetail = assignedRoleScoring?.applied
      ? ` ${formatNumber(assignedRoleScoring.expandedMinutes, 0)} planned minute${Number(assignedRoleScoring.expandedMinutes) === 1 ? "" : "s"} beyond established roles use the same-season baseline. This changes projected value, not player availability or a minute cap.`
      : "";
    strip.append(resultEvidenceItem(
      "Rate projection",
      assignedRoleScoring?.applied
        ? "Opportunity + role + assigned minutes"
        : rateEvidence.roleAdjustedPlayerMetricCount > 0
          ? "Opportunity + role adjusted"
          : "Opportunity-adjusted",
      `${rateEvidence.adjustedPlayers} of ${rateEvidence.eligiblePlayers} eligible players had at least one rate stabilized. Past team totals were excluded.${roleProjectionDetail}${assignedRoleDetail}`,
    ));
  } else if (result.best?.rotation) {
    strip.append(resultEvidenceItem(
      "Rate projection",
      "Raw source rates",
      rateEvidence?.reason || "The selected source did not provide enough evidence for stabilization.",
    ));
  } else {
    strip.append(resultEvidenceItem(
      "Scoring layer",
      "Pool-relative player profiles",
      "Equal-player lineup fit; no proposed rotation minutes.",
    ));
  }
  const objectiveEvidence = result.diagnostics?.objectiveMetricEvidence;
  const requestedImpact = ["offensiveImpact", "defensiveImpact"]
    .filter((metric) => Number(result.weights?.[metric]) > 0);
  const disabledImpact = (objectiveEvidence?.disabledRequestedMetrics || [])
    .filter((metric) => metric === "offensiveImpact" || metric === "defensiveImpact");
  strip.append(resultEvidenceItem(
    "Impact cross-check",
    requestedImpact.length === 0
      ? "Not requested"
      : disabledImpact.length > 0
        ? "Incomplete — safely omitted"
        : "OBPM/DBPM available",
    requestedImpact.length === 0
      ? "This custom strategy used only its selected standard box-score inputs."
      : disabledImpact.length > 0
        ? "The incomplete impact signal was disabled for every eligible player and its small weight was redistributed across the remaining priorities."
        : "Basketball Reference OBPM/DBPM supplied a modest individual offense/defense check; the exact result still follows your visible priorities.",
  ));
  strip.append(resultEvidenceItem(
    "Lineup chemistry data",
    "Not included",
    "OBPM/DBPM are individual box estimates, not lineup chemistry. Verified play-by-play must be a separate sourced layer.",
  ));
  return strip;
}

function renderResultRankingContext(result) {
  const wrap = document.createElement("div");
  wrap.className = "result-ranking-context";
  const best = result.best;
  const next = result.alternatives?.[1];
  const coreIds = best.playerIds.filter((id) => (
    result.alternatives.every((alternative) => alternative.playerIds.includes(id))
  ));
  const feasibleCount = Math.max(1, Number(result.diagnostics?.feasibleCombinations) || 1);
  const feasibleCountComplete = result.diagnostics?.feasibleCombinationCountComplete !== false;
  const fitGap = next ? Math.max(0, Number(best.score) - Number(next.score)) : null;
  const entries = [
    [
      "Exact rank",
      feasibleCountComplete
        ? `#1 of ${feasibleCount.toLocaleString()} confirmed feasible groups`
        : `#1; at least ${feasibleCount.toLocaleString()} feasible groups confirmed`,
    ],
    ["How close is #2?", next ? fitGapSummary(fitGap) : "No second feasible result returned"],
    ["Stable core", `${coreIds.length} of ${best.playerIds.length} players appear in every displayed result`],
  ];
  for (const [label, value] of entries) {
    const item = document.createElement("div");
    const term = document.createElement("span");
    term.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = value;
    item.append(term, detail);
    wrap.append(item);
  }
  return wrap;
}

/**
 * Scores only compare groups inside one exact search. Treating a two-decimal
 * gap as a meaningful forecasting edge would overstate the box-score model,
 * so translate small gaps into a plain-language confidence cue everywhere a
 * visitor compares the recommended answer with the next alternative.
 */
function fitGapSummary(gap) {
  if (!Number.isFinite(gap)) return "Difference unavailable";
  if (gap <= 0.25) return `Nearly tied · ${formatNumber(gap, 2)} fit points`;
  if (gap <= 1) return `Close alternative · ${formatNumber(gap, 2)} fit points`;
  return `Clearer lead · ${formatNumber(gap, 2)} fit points`;
}

function renderRotationMinutes(rotation) {
  const card = document.createElement("section");
  card.className = "result-card rotation-plan";
  const headingRow = document.createElement("div");
  headingRow.className = "rotation-plan__heading";
  const heading = document.createElement("h3");
  heading.textContent = "Your 240-minute plan";
  const planChip = document.createElement("span");
  planChip.className = "model-status-chip";
  const guidance = rotation.historicalGuidance || {};
  planChip.textContent = rotation.minutePlan === "historicalAware" && guidance.applied
    ? guidance.allocationStyleApplied === "preserveWorkload"
      ? "Recorded-minutes guardrail"
      : "Game-plan-first plan"
    : rotation.minutePlan === "openWhatIf"
      ? "Game-plan allocation"
      : ROTATION_MINUTE_PLAN_LABELS[rotation.minutePlan] || "Exact minute plan";
  headingRow.append(heading, planChip);
  const note = document.createElement("p");
  note.className = "rotation-plan-note";
  const required = rotation.positionMinutes?.required || { G: 96, F: 96, C: 48 };
  if (guidance.applied) {
    const requestedFlexibility = guidance.minuteFlexibility ?? 8;
    const appliedFlexibility = guidance.flexibilityUsed ?? requestedFlexibility;
    const expandedForRoles = appliedFlexibility > requestedFlexibility;
    // Role-minute feasibility can require a modest, deterministic widening of
    // the requested observed-workload window. Surface that exception here instead of
    // letting the result appear to have ignored the selected control.
    const roleCoverageNote = expandedForRoles
      ? ` You requested a ±${requestedFlexibility}-minute recorded-minutes window, and the exact position check widened it to ±${appliedFlexibility} minutes so the group could cover ${required.G} guard, ${required.F} forward, and ${required.C} center minutes.`
      : ` Role splits prove ${required.G} guard, ${required.F} forward, and ${required.C} center minutes.`;
    note.textContent = guidance.allocationStyleApplied === "preserveWorkload"
      ? `Your game plan selected this roster; the optional recorded-minutes mode then kept its minute plan close to past usage inside the displayed caps and hard limits.${roleCoverageNote}`
      : `${guidance.allocationStyleReason || "The minute solver shifted time toward the player profiles that best fit your strategy inside the recorded-minutes caps."}${roleCoverageNote}`;
  } else if (rotation.minutePlan === "openWhatIf") {
    note.textContent = `This allocation maximizes your game-plan fit inside your hard player limits. It does not try to recreate the source team's rotation. Role splits prove ${required.G} guard, ${required.F} forward, and ${required.C} center minutes.`;
  } else {
    note.textContent = `${guidance.reason || "Recorded-minutes evidence was unavailable, so the plan used your hard player limits."} Role splits prove ${required.G} guard, ${required.F} forward, and ${required.C} center minutes.`;
  }
  const list = document.createElement("ul");
  list.className = "minutes-list";
  const sorted = [...rotation.allocations].sort((left, right) => right.minutes - left.minutes);
  for (const allocation of sorted) {
    const player = currentPlayer(allocation.id);
    const row = document.createElement("li");
    const playerLabel = document.createElement("span");
    playerLabel.className = "minutes-list__player";
    const name = document.createElement("strong");
    name.textContent = player?.name || allocation.id;
    const roles = document.createElement("small");
    const anchor = Number(guidance.anchorsById?.[allocation.id]);
    const target = Number(guidance.targetsById?.[allocation.id]);
    const workloadParts = [roleMinuteSummary(allocation.roleMinutes) || "Utility minutes"];
    if (Number.isFinite(anchor)) workloadParts.push(`recorded ${formatNumber(anchor)} team-game min`);
    if (Number.isFinite(target)) workloadParts.push(`recorded-minutes target ${formatNumber(target, 0)}`);
    workloadParts.push(`allowed ${allocation.minimum}–${allocation.maximum}`);
    roles.textContent = workloadParts.join(" · ");
    playerLabel.append(name, roles);
    const track = document.createElement("span");
    track.className = "metric-bar__track";
    const fill = document.createElement("span");
    fill.className = "metric-bar__fill";
    fill.style.width = `${(allocation.minutes / 48) * 100}%`;
    track.append(fill);
    const minutes = document.createElement("strong");
    const targetDifference = Number.isFinite(target)
      ? allocation.minutes - target
      : null;
    const difference = targetDifference === 0
      ? " (on target)"
      : Number.isFinite(targetDifference)
        ? ` (${formatSignedDifference(targetDifference)} vs target)`
        : Number.isFinite(anchor)
          ? ` (${formatSignedDifference(allocation.minutes - anchor)} vs recorded)`
          : "";
    minutes.textContent = `${allocation.minutes} min${difference}`;
    row.append(playerLabel, track, minutes);
    list.append(row);
  }
  card.append(headingRow, note, list);
  return card;
}

function renderHistoricalWorkloadBenchmark(result) {
  const best = result.best;
  if (!best?.rotation) return null;
  const guidance = best.rotation.historicalGuidance || {};
  // Open what-if intentionally tells optimizer-core not to use anchors, so its
  // guidance envelope is empty even when the loaded source has workload data.
  // Rebuild those anchors for this descriptive comparison only; they do not
  // alter the exact result or imply that historical guardrails were enforced.
  const optimizerAnchors = guidance.anchorsById || {};
  const benchmarkAnchors = Object.keys(optimizerAnchors).length > 0
    ? optimizerAnchors
    : historicalMinuteAnchorsForCurrentDataset();
  const card = document.createElement("section");
  card.className = "result-card historical-benchmark";
  const heading = document.createElement("h3");
  heading.textContent = "Recorded minutes comparison (optional)";
  const sourceLeaders = Array.isArray(state.dataset?.source?.rotation)
    ? state.dataset.source.rotation
    : [];
  const sourceLeaderIds = new Set(sourceLeaders.map((player) => player.id));
  const overlap = best.playerIds.filter((id) => sourceLeaderIds.has(id)).length;
  const note = document.createElement("p");
  if (Object.keys(benchmarkAnchors).length === 0) {
    note.textContent = "Recorded team-game minutes are unavailable for this source, so a past-minutes comparison cannot be shown. The exact result above remains valid under the displayed hard limits.";
    card.append(heading, note);
    return card;
  }
  if (best.rotation.minutePlan === "openWhatIf") {
    note.textContent = "This game-plan allocation did not use source usage. The source minutes below are context only—not an optimizer input and not a claim that the historical allocation was optimal.";
  } else {
    note.textContent = sourceLeaders.length > 0
      ? `${overlap} of ${best.playerIds.length} selected players appear among this source's ${sourceLeaders.length} largest historical minute shares. Recorded minutes describe past usage—not a claim that the coach's allocation was optimal.`
      : "Recorded team-game minutes are compared with the proposal below. They describe past usage—not a claim that the historical allocation was optimal.";
  }

  // A mathematically legal plan can still be a large departure from the
  // player's observed team-stint role—especially after the selected group's
  // workload is rescaled to 240 minutes. Flag large departures before the
  // table so fans do not mistake an aggressive strategy-fit result for a
  // faithful reconstruction of the coach's actual rotation.
  const workloadStretches = best.rotation.allocations.filter((allocation) => {
    const recorded = Number(benchmarkAnchors[allocation.id]);
    return Number.isFinite(recorded) && Math.abs(allocation.minutes - recorded) >= 12;
  });
  const stretchNote = document.createElement("p");
  stretchNote.className = "workload-stretch-note";
  stretchNote.hidden = workloadStretches.length === 0;
  stretchNote.textContent = workloadStretches.length > 0
    ? `Reality check: ${workloadStretches.length} selected player${workloadStretches.length === 1 ? " is" : "s are"} at least 12 minutes from recorded team-game usage. Treat this as a game-plan result, not a likely real-world rotation.`
    : "";

  const wrap = document.createElement("div");
  wrap.className = "table-wrap historical-benchmark__table";
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "Recorded and proposed rotation minutes");
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Player", "Recorded team-game min", "Rescaled target", "Proposed", "Change vs recorded"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  [...best.rotation.allocations]
    .sort((left, right) => right.minutes - left.minutes)
    .forEach((allocation) => {
      const player = currentPlayer(allocation.id);
      const recorded = Number(benchmarkAnchors[allocation.id]);
      const target = Number(guidance.targetsById?.[allocation.id]);
      const row = document.createElement("tr");
      createCell(row, player?.name || allocation.name || allocation.id);
      createCell(row, Number.isFinite(recorded) ? formatNumber(recorded) : "Unavailable");
      createCell(row, Number.isFinite(target) ? formatNumber(target, 0) : "Not used");
      createCell(row, `${allocation.minutes} min`);
      createCell(row, Number.isFinite(recorded) ? formatSignedDifference(allocation.minutes - recorded) : "—");
      body.append(row);
    });
  table.append(head, body);
  wrap.append(table);
  card.append(heading, note, stretchNote, wrap);
  return card;
}

function summarizeAlternativeTradeoff(lineup, best) {
  if (lineup.rank === 1) return "Baseline";
  const metrics = [
    ["points", "PTS", false],
    ["rebounds", "REB", false],
    ["assists", "AST", false],
    ["steals", "STL", false],
    ["blocks", "BLK", false],
    ["turnovers", "TOV", true],
  ];
  // Turnovers are the only lower-is-better production column. Convert every
  // raw delta to a common benefit direction to identify the clearest gain and
  // sacrifice, while displaying the original signed stat change to the user.
  const changes = metrics.map(([metric, label, lowerIsBetter]) => {
    const delta = Number(lineup.totals[metric]) - Number(best.totals[metric]);
    return { label, delta, benefit: lowerIsBetter ? -delta : delta };
  }).filter((change) => Number.isFinite(change.delta) && Math.abs(change.delta) >= 0.05);
  const gain = changes.filter((change) => change.benefit > 0)
    .sort((left, right) => right.benefit - left.benefit)[0];
  const cost = changes.filter((change) => change.benefit < 0)
    .sort((left, right) => left.benefit - right.benefit)[0];
  const parts = [];
  if (gain) parts.push(`Gain ${formatSignedDifference(gain.delta)} ${gain.label}`);
  if (cost) parts.push(`Cost ${formatSignedDifference(cost.delta)} ${cost.label}`);
  return parts.join(" · ") || "Nearly identical production";
}

function renderAlternatives(alternatives, best) {
  const section = document.createElement("section");
  section.className = "alternatives-section";
  const heading = document.createElement("h3");
  heading.textContent = "Next-best groups under the same rules";
  const note = document.createElement("p");
  note.textContent = `Plan Fit Index uses the same-season NBA baseline (100), while the search score only ranks groups inside this exact run. Neither is a player rating or win prediction. ${best.rotation ? "Production columns use each group's own 240-minute plan." : "Production columns add the selected players' per-game profiles."}`;
  const wrap = document.createElement("div");
  wrap.className = "alternatives-wrap table-wrap";
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "Next-best feasible lineup alternatives");
  const table = document.createElement("table");
  table.className = "alternatives-table";
  const caption = document.createElement("caption");
  caption.className = "sr-only";
  caption.textContent = "Top feasible lineup alternatives";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const heading of ["Rank", "Players", "Plan Fit Index", "Search score", "Changes from #1", "Main tradeoff", "PTS", "REB", "AST", "TOV"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  const bestIds = new Set(best.players.map((player) => player.id));
  for (const lineup of alternatives) {
    const lineupIds = new Set(lineup.players.map((player) => player.id));
    const added = lineup.players.filter((player) => !bestIds.has(player.id)).map((player) => player.name);
    const removed = best.players.filter((player) => !lineupIds.has(player.id)).map((player) => player.name);
    const changes = lineup.rank === 1
      ? "Recommended group"
      : `In: ${added.join(", ") || "none"}; Out: ${removed.join(", ") || "none"}`;
    const row = document.createElement("tr");
    createCell(row, `#${lineup.rank}`);
    createCell(row, lineup.players.map((player) => player.name).join(", "));
    createCell(row, Number.isFinite(Number(lineup.planFitIndex)) ? formatNumber(lineup.planFitIndex) : "Unavailable");
    createCell(row, `${formatNumber(lineup.score)} / 100`);
    createCell(row, changes);
    createCell(row, summarizeAlternativeTradeoff(lineup, best));
    createCell(row, formatNumber(lineup.totals.points));
    createCell(row, formatNumber(lineup.totals.rebounds));
    createCell(row, formatNumber(lineup.totals.assists));
    createCell(row, formatNumber(lineup.totals.turnovers));
    body.append(row);
  }
  table.append(caption, head, body);
  wrap.append(table);
  section.append(heading, note, wrap);
  return section;
}

function analyticsAverage(players, metric, { rotation = null } = {}) {
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const player of players) {
    const value = Number(analyticsValue(player, metric));
    if (!Number.isFinite(value)) continue;
    const weight = rotation ? Number(rotation.byId?.[player.id] || 0) : 1;
    if (!(weight > 0)) continue;
    weightedTotal += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedTotal / weightTotal : null;
}

function renderAnalyticsComparisonChart(best, pool) {
  const section = document.createElement("section");
  section.className = "fan-report__chart";
  const heading = document.createElement("h4");
  heading.textContent = "Selected group vs eligible pool";
  const note = document.createElement("p");
  const view = analyticsViewDetail();
  note.textContent = `${best.rotation ? "Selected values are minute-weighted by the exact 240-minute plan" : "Selected values are averaged across the five selected players"}; pool values are unweighted across ${pool.length} player${pool.length === 1 ? "" : "s"} available in this search. ${view.note}`;
  section.append(heading, note);

  const chart = document.createElement("div");
  chart.className = "analytics-chart";
  let rendered = 0;
  for (const [metric, label, lowerIsBetter] of COMPARE_METRICS) {
    const selected = analyticsAverage(best.players, metric, { rotation: best.rotation });
    const poolAverage = analyticsAverage(pool, metric);
    if (!Number.isFinite(selected) || !Number.isFinite(poolAverage)) continue;
    const maximum = Math.max(Math.abs(selected), Math.abs(poolAverage), 0.01);
    const row = document.createElement("div");
    row.className = "analytics-chart__row";
    const name = document.createElement("strong");
    name.textContent = label;
    const track = document.createElement("span");
    track.className = "analytics-chart__track";
    const bar = document.createElement("span");
    bar.className = "analytics-chart__bar";
    if (lowerIsBetter && selected > poolAverage) bar.classList.add("analytics-chart__bar--warning");
    bar.style.setProperty("--bar-width", `${Math.max(2, (Math.abs(selected) / maximum) * 100)}%`);
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${label}: selected group ${analyticsMetricText(metric, selected)}, eligible-pool average ${analyticsMetricText(metric, poolAverage)}.`);
    track.append(bar);
    const values = document.createElement("span");
    values.textContent = `${analyticsMetricText(metric, selected)} / ${analyticsMetricText(metric, poolAverage)}`;
    row.append(name, track, values);
    chart.append(row);
    rendered += 1;
  }
  if (rendered === 0) {
    const unavailable = document.createElement("p");
    unavailable.textContent = "This view is not available for the current source. Per game and per 36 remain available for compatible player rows.";
    section.append(unavailable);
  } else {
    section.append(chart);
  }
  return section;
}

function renderInsightList(headingText, entries, { warning = false, emptyText } = {}) {
  const section = document.createElement("section");
  const heading = document.createElement("h4");
  heading.textContent = headingText;
  const list = document.createElement("ul");
  list.className = `insight-list${warning ? " insight-list--warning" : ""}`;
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.textContent = emptyText;
    list.append(item);
  } else {
    entries.slice(0, 4).forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = entry.message;
      list.append(item);
    });
  }
  section.append(heading, list);
  return section;
}

function renderRoleMatrix(roleCoverage) {
  const section = document.createElement("section");
  section.className = "fan-report__matrix";
  const heading = document.createElement("h4");
  heading.textContent = "Player strengths at a glance";
  const note = document.createElement("p");
  note.textContent = `Each mark is a statistical strength compared with the ${roleCoverage.comparisonLabel} (${roleCoverage.referencePlayerCount} players). ✓ has enough evidence for the role check; △ is limited evidence shown only for context. These are box-score signals, not scouting certainties.`;
  section.append(heading, note);
  const scroll = document.createElement("div");
  scroll.className = "role-matrix table-wrap";
  scroll.tabIndex = 0;
  scroll.setAttribute("aria-label", "Selected-player strengths table");
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Player", ...FAN_ROLE_DEFINITIONS.map((role) => role.shortLabel)]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  roleCoverage.matrix.forEach((row) => {
    const tableRow = document.createElement("tr");
    createCell(tableRow, row.playerName);
    FAN_ROLE_DEFINITIONS.forEach((definition) => {
      const role = row.roles?.[definition.id];
      const provisional = role?.confidence === "small-sample";
      const cell = createCell(tableRow, role ? (provisional ? "△" : "✓") : "—");
      cell.title = role
        ? `${definition.label}${provisional ? " (limited evidence; excluded from coverage targets)" : ""}: ${role.evidence?.[0] || "statistical signal"}`
        : `${definition.label} signal not established`;
      cell.setAttribute("aria-label", `${row.playerName}: ${role ? `${provisional ? "limited-evidence " : ""}${definition.label}` : `no ${definition.label.toLowerCase()} signal`}`);
    });
    body.append(tableRow);
  });
  table.append(head, body);
  scroll.append(table);
  section.append(scroll);
  return section;
}

function renderFanScoutingReport(result, explanation) {
  if (!explanation?.available || !explanation.roleCoverage) return null;
  const best = result.best;
  const source = state.dataset?.source || {};
  const report = document.createElement("section");
  report.className = "fan-report";
  report.setAttribute("aria-labelledby", "fanReportHeading");

  const header = document.createElement("div");
  header.className = "fan-report__header";
  const headerText = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow print-only";
  // The report explains a user-defined game plan using historical statistics. It does
  // not claim to reproduce a real NBA depth chart, so lead with the useful concept.
  eyebrow.textContent = "Lineup Lab game-plan report";
  const heading = document.createElement("h3");
  heading.id = "fanReportHeading";
  heading.textContent = "Strengths, gaps, and evidence";
  const intro = document.createElement("p");
  intro.textContent = "Explore the evidence behind this result: strengths, sample context, player comparisons, and alternatives. This is historical statistical scouting—not a game prediction, depth chart, injury report, or betting recommendation.";
  headerText.append(eyebrow, heading, intro);
  const provenance = document.createElement("p");
  provenance.className = "report-provenance";
  const postseasonCount = best.players.filter((player) => player.analytics?.postseasonAvailable === true).length;
  provenance.textContent = [
    `${source.teamName || source.team || "Selected team"} · ${source.season || "season unavailable"}`,
    source.seasonPhase === "playoffs" ? "Playoffs" : "Regular season",
    `${best.players.length} selected players using stats with this team`,
    `${postseasonCount} with playoff statistics for this team`,
    source.provider || "Source context unavailable",
  ].join(" · ");
  header.append(headerText, provenance);
  report.append(header);

  const grid = document.createElement("div");
  grid.className = "fan-report__grid";
  grid.append(
    renderInsightList(
      "What this group does well",
      explanation.roleCoverage.strengths || [],
      { emptyText: "No role signal cleared its configured coverage target in this comparison pool." },
    ),
    renderInsightList(
      "Potential weak spots",
      explanation.roleCoverage.deficiencies || [],
      {
        warning: true,
        emptyText: "No thin or missing role signal was identified by this box-score model.",
      },
    ),
  );
  report.append(grid, renderRoleMatrix(explanation.roleCoverage), renderAnalyticsComparisonChart(best, comparisonPool()));

  const caveats = [...new Set([
    analyticsViewDetail().note,
    ...(explanation.caveats || []),
  ])];
  if (caveats.length) {
    const note = document.createElement("p");
    note.className = "report-provenance";
    note.textContent = `Method note: ${caveats.join(" ")}`;
    report.append(note);
  }
  return report;
}

function resultMetricLabel(metric) {
  if (metric === "historicalReadiness") return "Recorded role evidence";
  if (metric === "efgPct" && state.experienceMode === "simple") return "Shooting efficiency (eFG%)";
  return METRIC_LABELS[metric] || titleCase(metric);
}

function simpleRoleConcern(entry) {
  // Detailed mode retains the complete, statistical role labels. Simple mode
  // translates the first gap into a basketball question a visitor can act on.
  const concernByRole = {
    primaryCreator: "this group does not have a clear lead playmaker based on assists and turnovers.",
    secondaryCreator: "this group has limited secondary playmaking support.",
    leadScorer: "this group lacks a clear high-volume scorer in this player pool.",
    movementShooter: "this group lacks a clear high-volume 3-point shooting option in this player pool.",
    perimeterShooter: "this group has limited 3-point shooting accuracy in this player pool.",
    connector: "this group has limited low-turnover passing support.",
    rimProtector: "this group has limited shot-blocking evidence.",
    switchDefender: "this group has limited multi-position steals-and-blocks activity.",
    rebounder: "this group has limited rebounding strength.",
    disruptor: "this group has limited combined steals-and-blocks activity.",
  };
  return concernByRole[entry?.roleId]
    || "one part of this group has limited box-score evidence.";
}

function renderSimpleResultOverview(result, fanExplanation) {
  const best = result.best;
  const panel = document.createElement("section");
  panel.className = "simple-result-overview simple-only";
  const heading = document.createElement("h3");
  heading.textContent = "Why this group was recommended";
  const benchmark = document.createElement("div");
  benchmark.className = "simple-benchmark";
  if (Number.isFinite(Number(best.planFitIndex))) {
    benchmark.append(
      renderScoreCard("Plan Fit Index", formatNumber(best.planFitIndex), true),
      renderScoreCard("Offense", formatNumber(best.offenseIndex)),
      renderScoreCard("Defense", formatNumber(best.defenseIndex)),
    );
    const benchmarkHelp = document.createElement("p");
    benchmarkHelp.className = "simple-benchmark__help";
    benchmarkHelp.textContent = "100 is the same-season NBA baseline. Higher means this group is stronger in the priorities you selected; it is not a win probability or overall team rating.";
    benchmark.append(benchmarkHelp);
  } else {
    const unavailable = document.createElement("p");
    unavailable.className = "simple-benchmark__help";
    unavailable.textContent = "This source does not include enough same-season evidence for a stable Plan Fit Index. The exact #1 ranking is still available.";
    benchmark.append(unavailable);
  }
  const list = document.createElement("ul");
  list.className = "simple-result-reasons";

  const strongest = Object.entries(best.contributionBreakdown || {})
    .filter(([metric, detail]) => metric !== "historicalReadiness" && Number(detail.scoreContribution) > 0)
    .sort((left, right) => Number(right[1].scoreContribution) - Number(left[1].scoreContribution))
    .slice(0, 3)
    .map(([metric]) => resultMetricLabel(metric));
  const fitReason = document.createElement("li");
  fitReason.textContent = strongest.length
    ? `It matches your game plan most through ${strongest.join(", ")}.`
    : "It is the strongest game-plan fit under the rules you selected.";
  list.append(fitReason);

  if (best.rotation) {
    const readinessReason = document.createElement("li");
    readinessReason.textContent = "This rotation follows your game plan inside the hard player-minute limits; past team games and total minutes did not affect the roster or assigned minutes.";
    list.append(readinessReason);
  }

  const requestedImpact = ["offensiveImpact", "defensiveImpact"]
    .filter((metric) => Number(result.weights?.[metric]) > 0);
  const disabledImpact = (result.diagnostics?.objectiveMetricEvidence?.disabledRequestedMetrics || [])
    .filter((metric) => metric === "offensiveImpact" || metric === "defensiveImpact");
  if (requestedImpact.length > 0) {
    const impactReason = document.createElement("li");
    impactReason.textContent = disabledImpact.length > 0
      ? "OBPM/DBPM was incomplete for this pool, so the model omitted that check for everyone and redistributed its small share across the remaining priorities."
      : "Complete OBPM/DBPM supplied a small offense/defense cross-check; your visible game-plan priorities still drove the ranking.";
    list.append(impactReason);
  }

  const exactReason = document.createElement("li");
  exactReason.textContent = `The exact search ranked it #1 after applying every active player and position rule.`;
  list.append(exactReason);

  const deficiencies = fanExplanation?.roleCoverage?.deficiencies || [];
  if (deficiencies.length > 0) {
    const concern = document.createElement("p");
    concern.className = "simple-result-concern";
    concern.textContent = `Possible weakness: ${simpleRoleConcern(deficiencies[0])}`;
    panel.append(benchmark, heading, list, concern);
  } else {
    panel.append(benchmark, heading, list);
  }

  const alternative = result.alternatives?.[1];
  if (alternative) {
    const bestIds = new Set(best.playerIds || best.players.map((player) => player.id));
    const alternativeIds = new Set(alternative.playerIds || alternative.players.map((player) => player.id));
    const added = alternative.players.filter((player) => !bestIds.has(player.id)).map((player) => player.name);
    const removed = best.players.filter((player) => !alternativeIds.has(player.id)).map((player) => player.name);
    const indexGap = Number.isFinite(Number(best.planFitIndex)) && Number.isFinite(Number(alternative.planFitIndex))
      ? Math.max(0, Number(best.planFitIndex) - Number(alternative.planFitIndex))
      : null;
    const next = document.createElement("p");
    next.className = "simple-result-next";
    next.textContent = `Next-best exact group${indexGap === null ? "" : ` (${formatNumber(indexGap)} Plan Fit Index point${Math.abs(indexGap - 1) < 0.001 ? "" : "s"} lower)`}: ${added.length || removed.length
      ? `swap ${removed.join(", ") || "the changed player"} for ${added.join(", ") || "the alternative"}.`
      : "the same player group with a nearly identical plan."} ${summarizeAlternativeTradeoff(alternative, best)}.`;
    panel.append(next);
  }

  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.className = "button button--quiet simple-result-details";
  detailsButton.dataset.action = "show-detailed";
  detailsButton.textContent = "See details and alternatives";
  panel.append(detailsButton);
  return panel;
}

function renderSuccess(result) {
  const best = result.best;
  const comparisonPlayers = comparisonPool();
  // Selection remains entirely inside optimizer-core. This pure explanation
  // call translates the returned exact choice into readable strengths, sample
  // context, and tradeoffs; it cannot alter feasibility, minutes, or ranking.
  const fanExplanation = explainOptimizationSelection(result, {
    candidatePool: comparisonPlayers,
    referencePlayers: comparisonPlayers,
    weights: state.weights,
    comparisonLabel: "players available in this search",
  });
  const feasibleCount = Number(result.diagnostics.feasibleCombinations || 0);
  const possibleCount = Number(result.combinationsEvaluated || 0);
  const countIsComplete = result.diagnostics.feasibleCombinationCountComplete !== false;
  const validLabel = countIsComplete
    ? `${feasibleCount.toLocaleString()} group${feasibleCount === 1 ? "" : "s"} that met every rule`
    : `at least ${feasibleCount.toLocaleString()} proven valid group${feasibleCount === 1 ? "" : "s"}`;
  // Keep the headline plain: this is the highest-scoring fit inside this exact
  // search, not a prediction of wins or an assertion about a real team's depth chart.
  const planFitHeadline = Number.isFinite(Number(best.planFitIndex))
    ? ` Plan Fit Index ${formatNumber(best.planFitIndex)}, where 100 is the same-season NBA baseline for the selected priorities.`
    : " A same-season Plan Fit Index was unavailable for this source.";
  elements.resultSummary.textContent = `Recommended #1 of ${validLabel}.${planFitHeadline} The solver checked ${possibleCount.toLocaleString()} possible group${possibleCount === 1 ? "" : "s"}. This is an optimizer result—not a win prediction or real-world depth chart.`;

  const fragment = document.createDocumentFragment();
  const lineup = document.createElement("div");
  lineup.className = "lineup-grid";
  best.players.forEach((player, index) => lineup.append(renderLineupPlayer(player, best, index, {
    result,
    insight: playerInsightFor(fanExplanation, player.id),
  })));
  fragment.append(lineup, renderSimpleResultOverview(result, fanExplanation));

  // Detailed view is deliberately progressive: even advanced users see the
  // actual players first, then choose when to open score math, rule proofs,
  // alternative tables, and descriptive skill signals.
  const fullAnalysis = document.createElement("details");
  fullAnalysis.className = "full-analysis detailed-only";
  const fullSummary = document.createElement("summary");
  fullSummary.textContent = "See score, alternatives, and evidence";
  const scoreExplanation = document.createElement("p");
  scoreExplanation.className = "full-analysis__intro";
  scoreExplanation.textContent = best.rotation
    ? "Plan Fit Index is anchored to the same-season NBA baseline (100) and uses the priorities you selected. The technical search-relative score below ranks only this eligible pool. Rotation projections stabilize limited samples and smoothly reduce unproven advantages as roles expand; neither score is team quality or win probability."
    : "Plan Fit Index is anchored to the same-season NBA baseline (100) and uses the priorities you selected. The technical search-relative score ranks only this eligible pool; neither score is team quality or win probability.";
  const scoreboard = document.createElement("div");
  scoreboard.className = "result-scoreboard";
  const productionPrefix = best.rotation ? "Projected" : "Combined";
  if (Number.isFinite(Number(best.planFitIndex))) {
    scoreboard.append(
      renderScoreCard("Plan Fit Index · 100 = league baseline", formatNumber(best.planFitIndex), true),
      renderScoreCard("Offense Index", formatNumber(best.offenseIndex)),
      renderScoreCard("Defense Index", formatNumber(best.defenseIndex)),
    );
  }
  scoreboard.append(renderScoreCard(
    "Search-relative ranking score",
    `${formatNumber(best.score)} / 100`,
    !Number.isFinite(Number(best.planFitIndex)),
  ));
  scoreboard.append(
    renderScoreCard(`${productionPrefix} PTS`, formatNumber(best.totals.points)),
    renderScoreCard(`${productionPrefix} REB`, formatNumber(best.totals.rebounds)),
    renderScoreCard(`${productionPrefix} AST`, formatNumber(best.totals.assists)),
  );

  const detailGrid = document.createElement("div");
  detailGrid.className = "result-detail-grid";
  const contributionCard = document.createElement("section");
  contributionCard.className = "result-card";
  const contributionHeading = document.createElement("h3");
  contributionHeading.textContent = "What drove this ranking";
  contributionCard.append(contributionHeading, renderContributionList(best.contributionBreakdown));
  const auditCard = document.createElement("section");
  auditCard.className = "result-card";
  const auditHeading = document.createElement("h3");
  auditHeading.textContent = "Rules check";
  auditCard.append(auditHeading, renderAudit(best.constraintAudit));
  detailGrid.append(contributionCard, auditCard);

  fullAnalysis.append(
    fullSummary,
    scoreExplanation,
    scoreboard,
    renderResultEvidence(result),
    renderResultRankingContext(result),
    detailGrid,
  );
  if (best.rotation) {
    fullAnalysis.append(renderRotationMinutes(best.rotation));
    const historicalBenchmark = renderHistoricalWorkloadBenchmark(result);
    if (historicalBenchmark) fullAnalysis.append(historicalBenchmark);
  }
  if (result.alternatives.length > 1) fullAnalysis.append(renderAlternatives(result.alternatives, best));
  const fanReport = renderFanScoutingReport(result, fanExplanation);
  if (fanReport) fullAnalysis.append(fanReport);
  fragment.append(fullAnalysis);
  elements.resultContent.replaceChildren(fragment);
  setMobileResultCurrent(true);
}

function renderFailure(result) {
  // A failed rerun replaces any prior successful solve. Clear the compact
  // mobile success state before presenting the recovery guidance.
  setMobileResultCurrent(false);
  const category = result.diagnostics?.category;
  if (category === "performance") {
    elements.resultsHeading.textContent = "Narrow the exact search";
    elements.resultSummary.textContent = "This scenario is larger than the browser-safe exact-search limit.";
  } else if (category === "worker-unavailable") {
    elements.resultsHeading.textContent = "Background solver unavailable";
    elements.resultSummary.textContent = "This browser could not start the exact-search worker.";
  } else if (category === "worker-error") {
    elements.resultsHeading.textContent = "Background solver issue";
    elements.resultSummary.textContent = "The browser could not complete this exact search in the background.";
  } else if (category === "validation") {
    elements.resultsHeading.textContent = "Review the scenario settings";
    elements.resultSummary.textContent = "One or more settings need attention before the optimizer can run.";
  } else {
    elements.resultsHeading.textContent = result.mode === "rotation" ? "No feasible rotation" : "No feasible lineup";
    elements.resultSummary.textContent = "The current requirements do not leave a feasible group.";
  }
  const card = document.createElement("div");
  card.className = "error-card";
  const heading = document.createElement("h3");
  heading.textContent = category === "performance"
    ? "Reduce the search space"
    : category === "worker-unavailable"
      ? "Use a current browser"
      : category === "worker-error"
        ? "Refresh and try again"
      : "Try loosening one rule";
  const list = document.createElement("ul");
  for (const reason of result.reasons || ["No feasible group was found."]) {
    const item = document.createElement("li");
    item.textContent = reason;
    list.append(item);
  }
  // A safety-limit message should tell a fan which visible controls actually
  // shrink the proof, not merely expose an implementation limit. The live
  // Groups-to-evaluate readout lets them confirm the effect before rerunning.
  if (category === "performance") {
    const recovery = document.createElement("li");
    recovery.textContent = "Try raising Minimum games or MPG, excluding nonessential players, or loosening the production threshold. Check Groups to evaluate, then run the exact search again.";
    list.append(recovery);
  }
  card.append(heading, list);
  elements.resultContent.replaceChildren(card);
}

function workerUnavailableError() {
  const error = new Error("This browser cannot start the background exact solver. Use a current browser and try again.");
  error.name = "WorkerUnavailableError";
  return error;
}

function workerExecutionError(message) {
  const error = new Error(message);
  error.name = "WorkerExecutionError";
  return error;
}

function runOptimization(players, config, jobToken) {
  if (jobToken !== state.optimizationRunId) {
    const error = new Error("Optimization cancelled because the scenario changed.");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  if (typeof window.Worker !== "function") {
    return Promise.reject(workerUnavailableError());
  }
  const requestId = `${Date.now()}-${jobToken}`;
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(OPTIMIZER_WORKER_URL, { type: "module", name: "djhc-lineup-optimizer" });
    } catch {
      reject(workerUnavailableError());
      return;
    }
    if (jobToken !== state.optimizationRunId) {
      worker.terminate();
      const error = new Error("Optimization cancelled because the scenario changed.");
      error.name = "AbortError";
      reject(error);
      return;
    }
    state.optimizationWorker = worker;
    let settled = false;
    let rejectCurrent = null;
    const timeout = window.setTimeout(() => {
      const error = new Error("The exact search took too long. Narrow the player pool and try again.");
      error.name = "TimeoutError";
      rejectCurrent?.(error);
    }, 30000);
    // Keep every Worker exit path in one cleanup function. A thrown postMessage,
    // timeout, error event, or normal result must all terminate the Worker and
    // clear the matching timeout/reject handles before the next solve begins.
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      if (state.optimizationWorker === worker) state.optimizationWorker = null;
      if (state.optimizationReject === rejectCurrent) state.optimizationReject = null;
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    rejectCurrent = (error) => finish(reject, error);
    state.optimizationReject = rejectCurrent;
    worker.addEventListener("message", (messageEvent) => {
      if (messageEvent.data?.requestId !== requestId) return;
      if (messageEvent.data.error) {
        finish(reject, workerExecutionError(String(messageEvent.data.error)));
        return;
      }
      finish(resolve, messageEvent.data.result);
    });
    worker.addEventListener("error", (errorEvent) => {
      errorEvent.preventDefault();
      finish(reject, workerExecutionError("The background optimizer could not start. Refresh the page and try again."));
    });
    worker.addEventListener("messageerror", () => {
      finish(reject, workerExecutionError("The background optimizer returned an unreadable result. Refresh the page and try again."));
    });
    try {
      worker.postMessage({ requestId, players, config });
    } catch {
      finish(reject, workerExecutionError("The background optimizer could not receive this request. Refresh the page and try again."));
    }
  });
}

async function runOptimizer(event) {
  event?.preventDefault();
  if (!state.dataset) return;
  if (!canOptimizeCurrentDataset()) {
    setLiveDataStatus("Load the selected team-season before running an exact search.", "warning");
    showToast("Load the selected team-season before optimizing it.");
    return;
  }
  updateSearchScope();
  if (!state.searchScopeCanRun) return;
  if (!elements.form.reportValidity()) return;
  if (state.replacementRunToken !== null) {
    // The main exact search owns the same worker as a one-player test. Close
    // the visible pending state before aborting it so a new solve cannot leave
    // an old card indefinitely saying that it is still checking.
    finishPendingReplacement("A new exact result is being calculated, so this replacement test was cancelled.");
  }
  const jobToken = cancelOptimization("A newer optimization replaced the previous request.");
  const scenarioVersion = state.scenarioVersion;
  state.activeOptimizationToken = jobToken;
  elements.results.classList.remove("is-stale");
  elements.resultFreshness.hidden = true;
  elements.resultFreshness.textContent = "";
  setOptimizeButtons({ disabled: true, label: solveActionLabel({ busy: true }) });
  elements.form.setAttribute("aria-busy", "true");
  setSolverStatus("Running an exact search...", "working");
  // Yield once so the "Solving" state can paint, then re-check both identities.
  // A fast user edit in that frame cancels the request before any expensive
  // combination enumeration is sent to the Worker.
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  try {
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    const result = await runOptimization(optimizerPlayersForCurrentScenario(), buildOptimizerConfig(), jobToken);
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    state.lastResult = result;
    elements.results.classList.remove("is-stale");
    elements.resultFreshness.hidden = true;
    elements.resultsHeading.textContent = result.mode === "rotation"
      ? "Recommended rotation"
      : "Recommended lineup";
    if (result.ok) renderSuccess(result);
    else renderFailure(result);
    elements.resultActions.hidden = !result.ok;
    elements.emptyResult.hidden = true;
    elements.results.hidden = false;
    elements.copyResult.disabled = !result.ok;
    elements.downloadResult.disabled = !result.ok;
    syncShareScenarioAvailability();
    elements.printReport.disabled = !result.ok;
    setSolverStatus(result.ok ? "Exact result ready" : "Scenario needs attention", result.ok ? "success" : "warning");
    elements.resultsHeading.focus({ preventScroll: true });
    elements.results.scrollIntoView({ behavior: motionBehavior(), block: "start" });
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    const detail = error instanceof Error ? error.message : "The optimizer could not run.";
    const failure = {
      mode: elements.mode.value,
      reasons: [detail],
      diagnostics: {
        category: error?.name === "TimeoutError"
          ? "performance"
          : error?.name === "WorkerUnavailableError"
            ? "worker-unavailable"
            : error?.name === "WorkerExecutionError"
              ? "worker-error"
            : "validation",
      },
    };
    state.lastResult = failure;
    renderFailure(failure);
    elements.resultActions.hidden = true;
    elements.emptyResult.hidden = true;
    elements.results.hidden = false;
    elements.copyResult.disabled = true;
    elements.downloadResult.disabled = true;
    elements.shareScenario.disabled = true;
    elements.printReport.disabled = true;
    setSolverStatus("Scenario needs attention", "warning");
    showToast(detail);
  } finally {
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    state.activeOptimizationToken = null;
    elements.form.removeAttribute("aria-busy");
    setOptimizeButtons({ disabled: false });
    const needsUpdate = !elements.resultFreshness.hidden;
    setOptimizeButtons({ label: solveActionLabel({ update: needsUpdate }) });
  }
}

function replaceReplacementOutput(playerId, analysis) {
  const existing = replacementResultElement(playerId);
  if (!existing) return;
  existing.replaceWith(replacementAnalysisMarkup(playerId, analysis));
}

function restoreReplacementButtons() {
  elements.resultContent.querySelectorAll('[data-action="exact-replacement"]').forEach((button) => {
    const player = currentPlayer(button.dataset.playerId);
    button.disabled = !player || state.lockedIds.has(button.dataset.playerId);
    button.textContent = "Test exact replacement";
  });
}

function setReplacementButtonsBusy(activePlayerId) {
  // Each counterfactual uses the same exact-search worker. Keeping one
  // request in flight makes cancellation deterministic and prevents another
  // card from being left at a misleading "Checking…" state.
  elements.resultContent.querySelectorAll('[data-action="exact-replacement"]').forEach((button) => {
    button.disabled = true;
    button.textContent = button.dataset.playerId === activePlayerId
      ? "Testing exact replacement…"
      : "Replacement test running…";
  });
}

async function runExactReplacement(playerId) {
  const originalResult = state.lastResult;
  const originalBest = originalResult?.best;
  const player = currentPlayer(playerId);
  if (!originalResult?.ok || !originalBest || !player || !elements.resultFreshness.hidden) return;
  if (state.replacementRunToken !== null) return;
  if (state.lockedIds.has(playerId)) {
    replaceReplacementOutput(playerId, {
      ok: false,
      message: "This player is locked by the current scenario. Unlock them to test a replacement.",
    });
    return;
  }

  const cacheKey = `${state.scenarioVersion}:${playerId}`;
  if (state.replacementAnalyses.has(cacheKey)) {
    replaceReplacementOutput(playerId, state.replacementAnalyses.get(cacheKey));
    return;
  }

  const originalIds = new Set(originalBest.players.map((item) => item.id));
  const preservedIds = originalBest.players
    .map((item) => item.id)
    .filter((id) => id !== playerId);
  const replacementConfig = buildOptimizerConfig();
  // Locking the other returned IDs and excluding the tested player turns a
  // broad top-N search into an auditable one-player counterfactual. It keeps
  // every current eligibility, position, production, and minute rule intact.
  replacementConfig.lockedIds = [...new Set([
    ...replacementConfig.lockedIds.filter((id) => id !== playerId),
    ...preservedIds,
  ])];
  replacementConfig.excludedIds = [...new Set([
    ...replacementConfig.excludedIds,
    playerId,
  ])].filter((id) => !replacementConfig.lockedIds.includes(id));
  replacementConfig.alternatives = 1;

  const scenarioVersion = state.scenarioVersion;
  const jobToken = cancelOptimization("The exact replacement test started.");
  state.replacementRunToken = jobToken;
  state.replacementPlayerId = playerId;
  setReplacementButtonsBusy(playerId);
  const pending = replacementResultElement(playerId);
  if (pending) {
    pending.hidden = false;
    delete pending.dataset.status;
    pending.textContent = "Checking every eligible one-player replacement under the current exact rules…";
  }

  try {
    const replacementResult = await runOptimization(
      optimizerPlayersForCurrentScenario(),
      replacementConfig,
      jobToken,
    );
    if (
      jobToken !== state.optimizationRunId
      || state.replacementRunToken !== jobToken
      || scenarioVersion !== state.scenarioVersion
      || state.lastResult !== originalResult
    ) return;
    let analysis;
    if (!replacementResult.ok || !replacementResult.best) {
      analysis = {
        ok: false,
        message: "No feasible one-player replacement meets every current rule.",
      };
    } else {
      const replacement = replacementResult.best.players.find((item) => !originalIds.has(item.id));
      if (!replacement) {
        analysis = {
          ok: false,
          message: "The solver did not return a distinct replacement under the current rules.",
        };
      } else {
        const deltas = Object.fromEntries(
          ["points", "rebounds", "assists", "turnovers"].map((metric) => [
            metric,
            Number(replacementResult.best.totals?.[metric]) - Number(originalBest.totals?.[metric]),
          ]),
        );
        analysis = {
          ok: true,
          replacementId: replacement.id,
          replacementName: replacement.name,
          deltas,
        };
      }
    }
    state.replacementAnalyses.set(cacheKey, analysis);
    replaceReplacementOutput(playerId, analysis);
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (
      jobToken !== state.optimizationRunId
      || state.replacementRunToken !== jobToken
      || scenarioVersion !== state.scenarioVersion
      || state.lastResult !== originalResult
    ) return;
    const analysis = {
      ok: false,
      message: error instanceof Error ? error.message : "The exact replacement check could not run.",
    };
    state.replacementAnalyses.set(cacheKey, analysis);
    replaceReplacementOutput(playerId, analysis);
  } finally {
    if (jobToken !== state.optimizationRunId || state.replacementRunToken !== jobToken) return;
    state.replacementRunToken = null;
    state.replacementPlayerId = null;
    restoreReplacementButtons();
  }
}

function comparisonPool() {
  // These are the same two pool gates applied before exact combinations are
  // enumerated. Locks affect membership in a lineup, not the population used
  // to interpret a player's percentile.
  return state.dataset.players.filter(
    (player) => isPlayerEligible(player) && !state.excludedIds.has(player.id),
  );
}

function percentileForPoolValue(value, poolValues, lowerIsBetter = false) {
  const values = poolValues
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (values.length === 0 || !Number.isFinite(Number(value))) return null;
  if (values.length <= 1) return 100;
  const numericValue = Number(value);
  const lower = values.filter((candidate) => candidate < numericValue).length;
  const equal = values.filter((candidate) => candidate === numericValue).length;
  const rawPercentile = ((lower + Math.max(0, equal - 1) / 2) / (values.length - 1)) * 100;
  // A selected comparison can remain on screen after exclusion. Clamp that
  // out-of-pool reference value instead of letting it produce a bar above 100.
  const percentile = Math.max(0, Math.min(100, rawPercentile));
  return lowerIsBetter ? 100 - percentile : percentile;
}

function renderCompare() {
  if (!state.dataset) return;
  const selected = [...state.compareIds].map(currentPlayer).filter(Boolean).slice(0, 4);
  const pool = comparisonPool();
  const view = analyticsViewDetail();
  elements.compareContent.replaceChildren();
  if (selected.length < 2) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const heading = document.createElement("h3");
    heading.textContent = selected.length === 1 ? "Choose one more player" : "Choose two to four players";
    const copy = document.createElement("p");
    copy.textContent = `Use the Compare checkboxes in the player table. The current comparison contains ${pool.length} player${pool.length === 1 ? "" : "s"} available in this search.`;
    empty.append(heading, copy);
    elements.compareContent.append(empty);
    return;
  }

  const poolNote = document.createElement("p");
  poolNote.className = "compare-pool-note";
  poolNote.textContent = `${pool.length} player${pool.length === 1 ? "" : "s"} meet the current sample filters and are not excluded. Values use ${view.label.toLowerCase()}. Percentiles below use exactly that pool; a compared player can remain visible after being excluded. ${view.note}`;

  const legend = document.createElement("div");
  legend.className = "compare-legend";
  selected.forEach((player, index) => {
    const item = document.createElement("span");
    const dot = document.createElement("i");
    dot.style.background = CHART_COLORS[index];
    const avatar = createPlayerAvatar(player, "compare-legend__avatar");
    item.append(dot, avatar, document.createTextNode(player.name));
    legend.append(item);
  });
  const scroll = document.createElement("div");
  scroll.className = "table-wrap";
  scroll.tabIndex = 0;
  scroll.setAttribute("aria-label", `Percentile comparison across ${pool.length} players available in this search`);
  const bars = document.createElement("div");
  bars.className = "compare-bars";
  bars.style.padding = "1rem";
  for (const [metric, labelText, lowerIsBetter] of COMPARE_METRICS) {
    const poolValues = pool.map((item) => analyticsValue(item, metric));
    const row = document.createElement("div");
    row.className = "compare-row";
    const label = document.createElement("strong");
    label.textContent = labelText;
    const rowBars = document.createElement("div");
    rowBars.className = "compare-row__bars";
    selected.forEach((player, index) => {
      const rawValue = analyticsValue(player, metric);
      const percentile = percentileForPoolValue(rawValue, poolValues, lowerIsBetter);
      const valueText = analyticsMetricText(metric, rawValue);
      const line = document.createElement("div");
      line.className = "compare-player-line";
      const track = document.createElement("span");
      track.className = "compare-player-track";
      const bar = document.createElement("div");
      bar.className = "compare-player-bar";
      bar.style.width = `${percentile === null ? 0 : Math.max(2, percentile)}%`;
      bar.style.background = CHART_COLORS[index];
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(percentile || 0)));
      bar.setAttribute("aria-label", `${player.name}: ${labelText}`);
      bar.setAttribute("aria-valuetext", percentile === null
        ? `${player.name}, ${labelText}: unavailable in the selected ${view.shortLabel} view.`
        : `${player.name}, ${labelText}: ${valueText}; ${formatOrdinal(percentile)} percentile among ${pool.length} players available in this search`);
      const value = document.createElement("span");
      value.className = "compare-player-value";
      value.textContent = valueText;
      value.setAttribute("aria-hidden", "true");
      track.append(bar);
      line.append(track, value);
      rowBars.append(line);
    });
    row.append(label, rowBars);
    bars.append(row);
  }
  scroll.append(bars);
  elements.compareContent.append(poolNote, legend, scroll);
}

function renderWatchlist() {
  if (!state.dataset) return;
  const players = [...state.watchlistIds]
    .map((id) => state.watchlistSnapshots.get(id) || currentPlayer(id))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
  elements.watchlistContent.replaceChildren();
  elements.downloadWatchlist.disabled = players.length === 0;
  elements.watchlistCount.textContent = String(state.watchlistIds.size);
  const unresolvedCount = Math.max(0, state.watchlistIds.size - players.length);
  if (players.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel empty-state";
    const heading = document.createElement("h3");
    heading.textContent = unresolvedCount ? "A saved player is waiting for its original pool" : "Your watchlist is empty";
    const copy = document.createElement("p");
    copy.textContent = unresolvedCount
      ? "This entry was saved before cross-season snapshots were added. Load the team-season where you starred that player once to restore its card."
      : "Select the star beside a player to keep a private shortlist across team-season searches on this device.";
    empty.append(heading, copy);
    elements.watchlistContent.append(empty);
    return;
  }
  for (const player of players) {
    const card = document.createElement("article");
    card.className = "watch-card";
    const headingWrap = document.createElement("div");
    headingWrap.className = "watch-card__heading";
    const identity = document.createElement("div");
    identity.className = "watch-card__identity";
    const avatar = createPlayerAvatar(player, "watch-card__avatar");
    const text = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = player.name;
    const meta = document.createElement("p");
    const context = player.watchlistContext || {};
    const metaParts = [
      context.season || state.dataset.source?.season || "Custom",
      context.team || player.team,
      Array.isArray(player.positions) ? player.positions.join("/") : String(player.positions || "Position unavailable"),
    ];
    // Older imports and source pages do not always provide age. Omitting that
    // fragment is clearer than rendering "age undefined" on a saved card.
    if (Number.isFinite(Number(player.age)) && Number(player.age) > 0) {
      metaParts.push(`Age ${formatNumber(player.age)}`);
    }
    meta.textContent = metaParts.filter(Boolean).join(" · ");
    text.append(heading, meta);
    if (avatar) identity.append(avatar);
    identity.append(text);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "watch-toggle is-active";
    remove.dataset.action = "watch";
    remove.dataset.playerId = player.id;
    remove.setAttribute("aria-label", `Remove ${player.name} from watchlist`);
    remove.textContent = "★";
    headingWrap.append(identity, remove);
    const stats = document.createElement("div");
    stats.className = "watch-card__stats";
    for (const [label, value] of [
      ["PTS", player.points],
      ["REB", player.rebounds],
      ["AST", player.assists],
      ["3P", formatPercent(player.threePct)],
    ]) {
      const block = document.createElement("div");
      const statLabel = document.createElement("span");
      statLabel.textContent = label;
      const statValue = document.createElement("strong");
      statValue.textContent = typeof value === "number" ? formatNumber(value) : value;
      block.append(statLabel, statValue);
      stats.append(block);
    }
    card.append(headingWrap, stats, createCardSearchLink(player));
    elements.watchlistContent.append(card);
  }
  if (unresolvedCount) {
    const note = document.createElement("p");
    note.className = "watchlist-migration-note";
    note.textContent = unresolvedCount === 1
      ? "1 older saved entry is waiting for its original team-season to be loaded once."
      : `${unresolvedCount} older saved entries are waiting for their original team-seasons to be loaded once.`;
    elements.watchlistContent.append(note);
  }
}

function switchView(viewName, { scroll = false } = {}) {
  let activeView = null;
  $$('[data-view]').forEach((view) => {
    const selected = view.dataset.view === viewName;
    view.hidden = !selected;
    if (selected) activeView = view;
  });
  $$(".tool-nav [role='tab']").forEach((button) => {
    const selected = button.dataset.viewTarget === viewName;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  if (viewName === "compare") renderCompare();
  if (viewName === "watchlist") renderWatchlist();
  if (scroll) {
    $("#workspace").scrollIntoView({ behavior: motionBehavior(), block: "start" });
    activeView?.focus({ preventScroll: true });
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function resultSummaryText() {
  const result = state.lastResult;
  // Result actions are disabled when inputs change, but retain this guard for
  // keyboard/programmatic calls during an async roster-selector refresh.
  if (!result?.ok || !elements.resultFreshness.hidden) return "";
  const best = result.best;
  const lines = [
    `DJ's Lineup Lab - ${elements.mode.value === "rotation" ? "Recommended rotation and minutes plan" : "Recommended lineup"}`,
    `Strategy: ${PRESET_LABELS[state.activePreset] || "Custom mix"}`,
    ...(Number.isFinite(Number(best.planFitIndex))
      ? [`Plan Fit Index: ${formatNumber(best.planFitIndex)} (100 = same-season NBA baseline)`, `Offense: ${formatNumber(best.offenseIndex)}; Defense: ${formatNumber(best.defenseIndex)}`]
      : ["Plan Fit Index: unavailable for this source"]),
    `Search-relative ranking score: ${formatNumber(best.score)} / 100`,
    `Players: ${best.players.map((player) => player.name).join(", ")}`,
    `${best.rotation ? "Minute-weighted projection" : "Combined player profiles"}: ${formatNumber(best.totals.points)} PTS, ${formatNumber(best.totals.rebounds)} REB, ${formatNumber(best.totals.assists)} AST, ${formatNumber(best.totals.turnovers)} TOV`,
  ];
  if (best.rotation) {
    lines.push(`Minutes: ${best.rotation.allocations.map((item) => `${currentPlayer(item.id)?.name || item.id} ${item.minutes}`).join(", ")}`);
  }
  lines.push("Historical-stat exploration only; not a prediction or betting recommendation.");
  return lines.join("\n");
}

async function copyResult() {
  const text = resultSummaryText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  showToast("Result summary copied.");
}

function downloadResult() {
  const best = state.lastResult?.best;
  if (!best || !elements.resultFreshness.hidden) return;
  const minutesById = best.rotation?.byId || {};
  const rows = [
    ["Player", "Team", "Eligible Positions", "Roster Slot", "Minutes", "Guard Minutes", "Forward Minutes", "Center Minutes", "PTS", "REB", "AST", "STL", "BLK", "TOV", "eFG%", "3P%"],
    ...best.players.map((player) => {
      const roleMinutes = best.rotation?.positionMinutes?.byPlayer?.[player.id] || {};
      return [
        player.name,
        player.team,
        player.positions.join("/"),
        assignedPosition(best, player.id),
        minutesById[player.id] ?? "",
        roleMinutes.G ?? "",
        roleMinutes.F ?? "",
        roleMinutes.C ?? "",
        player.points,
        player.rebounds,
        player.assists,
        player.steals,
        player.blocks,
        player.turnovers,
        player.efgPct,
        player.threePct,
      ];
    }),
  ];
  downloadText("djhc-optimized-lineup.csv", rows.map((row) => row.map(csvEscape).join(",")).join("\r\n"));
  showToast("Lineup CSV downloaded.");
}

function exportDataset() {
  if (!state.dataset) return;
  downloadText("djhc-lineup-player-data.csv", datasetToCsv(state.dataset));
  showToast("Current player data exported.");
}

function downloadTemplate() {
  const template = {
    schemaVersion: 1,
    source: { label: "CSV template", season: "YYYY-YY" },
    players: [state.dataset.players[0]],
  };
  downloadText("djhc-lineup-import-template.csv", datasetToCsv(template));
  showToast("CSV template downloaded.");
}

function downloadWatchlist() {
  const players = [...state.watchlistIds]
    .map((id) => state.watchlistSnapshots.get(id) || currentPlayer(id))
    .filter(Boolean);
  if (players.length === 0) return;
  downloadText(
    "djhc-player-watchlist.csv",
    datasetToCsv({
      schemaVersion: 1,
      source: {
        label: "DJHC saved player watchlist",
        season: "Multiple team-seasons",
        snapshotDate: new Date().toISOString().slice(0, 10),
      },
      players,
    }),
  );
  showToast("Watchlist CSV downloaded.");
}

async function importCsvFile(file) {
  const loadGeneration = beginNonLiveDatasetLoad();
  let text;
  try {
    text = await file.text();
  } catch (error) {
    if (!datasetLoadIsCurrent(loadGeneration)) return;
    throw error;
  }
  if (!datasetLoadIsCurrent(loadGeneration)) return;
  const defaultTeam = teamValues()[0] || undefined;
  const dataset = parsePlayerCsv(text, {
    defaultTeam,
    source: {
      label: file.name,
      season: "Imported",
      snapshotDate: new Date().toISOString().slice(0, 10),
      note: "User-imported CSV; values are historical and not a live provider feed.",
    },
  });
  if (dataset.diagnostics.errors.length > 0) {
    const details = dataset.diagnostics.errors.slice(0, 3).map((item) => item.message).join(" ");
    throw new Error(details || "The CSV could not be validated.");
  }
  if (!datasetLoadIsCurrent(loadGeneration)) return;
  const warningCount = dataset.diagnostics.warnings.length;
  setDataset(dataset, {
    notice: `${dataset.players.length} players imported${warningCount ? ` with ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}.`,
  });
  setLiveDataStatus("Using an imported CSV. Choose a team and season above to return to live data.");
}

function resetScenario() {
  const hasPendingReplacement = state.replacementRunToken !== null;
  cancelOptimization("Optimization cancelled because the scenario was reset.");
  if (hasPendingReplacement) {
    finishPendingReplacement("The scenario was reset. Run a new result before testing replacements.");
  }
  state.scenarioVersion += 1;
  // Reset is an intentional fresh start, so it also discards any temporary
  // Detailed-view snapshot that otherwise exists only to survive one view switch.
  state.detailedSettingsSnapshot = null;
  elements.mode.value = "lineup";
  setMode("lineup");
  elements.alternatives.value = "5";
  const loadedPhase = state.loadedLiveSelection?.seasonPhase || DEFAULT_SEASON_PHASE;
  state.recommendedMinGames = recommendedMinimumGames(loadedPhase, "lineup");
  elements.minGames.value = String(state.recommendedMinGames);
  elements.minMinutes.value = "6";
  elements.minPoints.value = "";
  elements.minRebounds.value = "";
  elements.minAssists.value = "";
  elements.minSteals.value = "";
  elements.minBlocks.value = "";
  elements.maxTurnovers.value = "";
  elements.rotationMin.value = "8";
  elements.rotationMax.value = "40";
  elements.rotationMinutePlan.value = "openWhatIf";
  elements.rotationAllocationStyle.value = "strategyFirst";
  elements.rotationFlexibility.value = "8";
  elements.rotationRateStability.value = "sampleAdjusted";
  elements.rotationPositionProfile.value = "automatic";
  state.analyticsView = "perGame";
  elements.analyticsView.value = state.analyticsView;
  elements.rotationScoringBasis.value = "per36";
  syncRotationModelControls();
  state.lockedIds.clear();
  state.excludedIds.clear();
  state.opponentWeightUndo = null;
  applyPreset("balanced", { invalidate: false });
  if (state.experienceMode === "simple") applySimpleModelDefaults({ invalidate: false });
  clearRenderedResult();
  setSolverStatus("Ready to solve");
  setOptimizeButtons({ label: solveActionLabel() });
  renderPlayerTable();
  if (state.opponentDataset) renderOpponentScout();
  showToast("Scenario reset. Your comparison and watchlist were kept.");
}

function bindEvents() {
  $$("[data-view-target]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.viewTarget, { scroll: !button.closest(".tool-nav") }));
  });
  $$("[data-preset]").forEach((button) => {
    button.addEventListener("click", () => applyPreset(button.dataset.preset, { announce: true }));
  });
  $$('[data-family]').forEach((input) => {
    input.addEventListener("input", () => {
      state.familyWeights[input.dataset.family] = Number(input.value);
      // The solver never receives an opaque family score. Convert the six
      // readable controls back to the same eight auditable metric weights used
      // by presets, shared links, contribution details, and exact search.
      state.weights = weightsFromSkillFamilies(state.familyWeights);
      input.parentElement.querySelector("output").textContent = input.value;
      state.activePreset = "custom";
      state.opponentWeightUndo = null;
      renderPresetState();
      renderWeightShareSummary();
      updateRunSummary();
      markScenarioChanged();
    });
    input.addEventListener("change", () => {
      // Rebuild the comparison once the drag is complete so its Current column
      // stays accurate without repeatedly reloading avatars on every slider tick.
      if (state.opponentDataset) renderOpponentScout();
    });
  });
  elements.mode.addEventListener("change", () => {
    setMode(elements.mode.value);
    if (state.experienceMode === "simple") applySimpleModelDefaults({ invalidate: false });
    markScenarioChanged();
  });
  elements.analyticsView.addEventListener("change", () => {
    state.analyticsView = ANALYTICS_VIEW_DETAILS[elements.analyticsView.value]
      ? elements.analyticsView.value
      : "perGame";
    // Rate display is deliberately presentation-only. Keep the exact result
    // fresh and redraw the facts/cards instead of forcing a needless re-solve.
    renderCompare();
    if (state.lastResult?.ok && elements.resultFreshness.hidden) renderSuccess(state.lastResult);
  });
  elements.rotationScoringBasis.addEventListener("change", () => {
    syncRotationModelControls();
    markScenarioChanged();
  });
  elements.rotationMinutePlan.addEventListener("change", () => {
    syncRotationModelControls();
    updateRunSummary();
    markScenarioChanged();
  });
  elements.rotationAllocationStyle.addEventListener("change", () => {
    syncRotationModelControls();
    updateRunSummary();
    markScenarioChanged();
  });
  elements.rotationFlexibility.addEventListener("change", () => {
    updateRunSummary();
    markScenarioChanged();
  });
  elements.rotationRateStability.addEventListener("change", markScenarioChanged);
  elements.rotationPositionProfile.addEventListener("change", () => {
    syncRotationRoleCopy();
    updateRunSummary();
    markScenarioChanged();
  });
  elements.positionFlexibility.addEventListener("change", () => {
    syncRotationRoleCopy();
    updateRunSummary();
    markScenarioChanged();
  });
  elements.form.addEventListener("submit", runOptimizer);
  elements.simpleMode.addEventListener("click", () => {
    setExperienceMode("simple", { applyDefaults: true, invalidate: true, announce: true });
  });
  elements.detailedMode.addEventListener("click", () => {
    setExperienceMode("detailed", { applyDefaults: false, announce: true });
  });
  elements.playerTableBody.addEventListener("change", handlePlayerControl);
  elements.playerTableBody.addEventListener("click", handlePlayerControl);
  elements.activeSelectionTray.addEventListener("click", handleActiveSelectionRemoval);
  elements.resultContent.addEventListener("click", (event) => {
    const detailedButton = event.target.closest('[data-action="show-detailed"]');
    if (detailedButton) {
      setExperienceMode("detailed", { applyDefaults: false, announce: true });
      const analysis = elements.resultContent.querySelector(".full-analysis");
      if (analysis) {
        analysis.open = true;
        analysis.scrollIntoView({ behavior: motionBehavior(), block: "start" });
        // The source button disappears in Detailed mode. Move focus to the
        // newly revealed disclosure so keyboard and screen-reader users stay
        // oriented at the point their action opened.
        requestAnimationFrame(() => analysis.querySelector("summary")?.focus({ preventScroll: true }));
      }
      return;
    }
    const button = event.target.closest('[data-action="exact-replacement"]');
    if (!button || button.disabled) return;
    runExactReplacement(button.dataset.playerId).catch((error) => {
      showToast(error instanceof Error ? error.message : "The exact replacement check could not run.");
    });
  });
  elements.watchlistContent.addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="watch"]');
    if (!button) return;
    const shouldRestoreFocus = document.activeElement === button;
    const id = button.dataset.playerId;
    state.watchlistIds.delete(id);
    state.watchlistSnapshots.delete(id);
    saveWatchlist();
    renderWatchlist();
    renderPlayerTable();
    if (shouldRestoreFocus) {
      const nextControl = elements.watchlistContent.querySelector('[data-action="watch"]');
      (nextControl || elements.watchlistTab).focus({ preventScroll: true });
    }
  });
  elements.playerSearch.addEventListener("input", () => renderPlayerTable());
  [elements.minGames, elements.minMinutes].forEach((input) => input.addEventListener("input", () => {
    renderPlayerTable();
    markScenarioChanged();
  }));
  [
    elements.size,
    elements.alternatives,
    elements.minGuards,
    elements.minForwards,
    elements.minCenters,
  ].forEach((input) => input.addEventListener("input", () => {
    updateRunSummary();
    markScenarioChanged();
  }));
  [
    elements.minPoints,
    elements.minRebounds,
    elements.minAssists,
    elements.minSteals,
    elements.minBlocks,
    elements.maxTurnovers,
    elements.rotationMin,
    elements.rotationMax,
  ].forEach((input) => input.addEventListener("input", markScenarioChanged));
  elements.resetScenario.addEventListener("click", resetScenario);
  elements.copyResult.addEventListener("click", copyResult);
  elements.shareScenario.addEventListener("click", copyScenarioLink);
  elements.downloadResult.addEventListener("click", downloadResult);
  elements.printReport.addEventListener("click", printScoutingReport);
  elements.loadLiveData.addEventListener("click", () => {
    loadLiveDataset({ force: true }).catch((error) => {
      showToast(error instanceof Error ? `Couldn't load team data: ${error.message}` : "Team data could not be loaded.");
    });
  });
  const handleSeasonOrPhaseChange = () => {
    // The selector value changes synchronously, while the team list refreshes
    // asynchronously. Stale the old result before the network request so it
    // cannot be copied, downloaded, printed, or shared in that short window.
    markResultStaleForDatasetSelection();
    clearOpponentScout("Apply the updated team-season before building an opponent scouting cue.");
    refreshLiveTeamOptions();
  };
  elements.liveSeason.addEventListener("change", handleSeasonOrPhaseChange);
  elements.liveSeasonPhase.addEventListener("change", handleSeasonOrPhaseChange);
  elements.liveTeam.addEventListener("change", () => {
    updateLiveSelectionState();
    clearOpponentScout("Apply this team as the player pool before building an opponent scouting cue.");
    populateOpponentTeamOptions();
  });
  elements.loadOpponent.addEventListener("click", loadOpponentScout);
  elements.opponentTeam.addEventListener("change", () => {
    if (state.opponentDataset?.source?.team !== elements.opponentTeam.value) {
      state.opponentDataset = null;
      state.opponentStrategy = null;
      state.opponentWeightUndo = null;
      elements.opponentScoutSummary.hidden = true;
      elements.opponentScoutSummary.replaceChildren();
      setOpponentScoutStatus(`Build a scouting cue for ${teamNameForCode(elements.opponentTeam.value)} to view historical averages and rotation.`);
    }
  });
  elements.importCsv.addEventListener("click", () => elements.csvFile.click());
  elements.csvFile.addEventListener("change", async () => {
    const [file] = elements.csvFile.files;
    if (!file) return;
    try {
      await importCsvFile(file);
    } catch (error) {
      showToast(error instanceof Error ? `Couldn't import this CSV: ${error.message}` : "This CSV could not be imported.");
    } finally {
      elements.csvFile.value = "";
    }
  });
  elements.resetDataset.addEventListener("click", () => {
    loadFixture({ notice: "The original course-project snapshot was restored." })
      .then(() => setLiveDataStatus("Using the stable course-project demo. Load a team above to return to the historical database."))
      .catch((error) => showToast(error.message));
  });
  elements.exportDataset.addEventListener("click", exportDataset);
  elements.downloadTemplate.addEventListener("click", downloadTemplate);
  elements.downloadWatchlist.addEventListener("click", downloadWatchlist);

  const tabs = $$(".tool-nav [role='tab']");
  $(".tool-nav").addEventListener("keydown", (event) => {
    const currentIndex = tabs.indexOf(event.target.closest("[role='tab']"));
    if (currentIndex < 0) return;
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    tabs[nextIndex].focus();
    switchView(tabs[nextIndex].dataset.viewTarget);
  });
}

async function initialize() {
  const initialLoadGeneration = beginDatasetLoadIntent();
  pruneLiveDatasetCache();
  bindEvents();
  applyPreset("balanced", { invalidate: false });
  setMode("lineup", { preserveSize: true });
  setExperienceMode(state.experienceMode, { applyDefaults: false });
  const sharedScenario = state.pendingScenario;
  applySharedScenarioControls(sharedScenario);
  if (state.experienceMode === "simple") applySimpleModelDefaults({ invalidate: false });
  try {
    await populateLiveDataControls({ sharedScenario });
    if (!datasetLoadIsCurrent(initialLoadGeneration)) return;
    await loadLiveDataset({ intentGeneration: initialLoadGeneration });
    if (!datasetLoadIsCurrent(initialLoadGeneration)) return;
    await replaySharedScenarioAfterLoad(sharedScenario);
  } catch (error) {
    if (!datasetLoadIsCurrent(initialLoadGeneration)) return;
    try {
      await loadFixture({ notice: "Historical data was unavailable, so the course-project demo was loaded." });
      setLiveDataStatus("Using the stable course-project demo. Historical team data could not be loaded.", "warning");
    } catch (fixtureError) {
      elements.playerTableBody.replaceChildren();
      const row = document.createElement("tr");
      const cell = createCell(
        row,
        fixtureError instanceof Error ? fixtureError.message : "Player data could not be loaded.",
        "loading-cell",
      );
      cell.colSpan = 13;
      elements.playerTableBody.append(row);
      setOptimizeButtons({ disabled: true });
      showToast("Player data could not be loaded. Refresh the page and try again.");
    }
  } finally {
    flushPendingScenarioWarnings();
  }
}

initialize();
