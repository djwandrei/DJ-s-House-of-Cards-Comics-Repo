import {
  DEFAULT_MAX_EXACT_COMBINATIONS,
  DEFAULT_MAX_ROTATION_EXACT_COMBINATIONS,
  DEFAULT_PRESETS,
} from "./optimizer-core.js?v=20260824a";
import {
  datasetToCsv,
  normalizeDataset,
  parsePlayerCsv,
  validateDataset,
} from "./player-data.js?v=20260824a";
import {
  fetchSupabaseNbaTeamDataset,
  listSupabaseNbaSeasons,
  listSupabaseNbaTeams,
  nbaSeasonLabel,
} from "./supabase-nba-data.js?v=20260824a";

// Keep every Lineup Lab dependency on the same reviewed release revision. The
// storefront service worker caches by full request URL, so versioned module
// requests prevent a newly deployed app shell from pairing with an old solver,
// dataset adapter, worker, or course-fixture response.
const FIXTURE_URL = "./fixtures/timberwolves-2021-22.json?v=20260824a";
const OPTIMIZER_WORKER_URL = new URL("./optimizer-worker.js?v=20260824a", import.meta.url);
const WATCHLIST_KEY = "djhc-lineup-lab-watchlist-v1";
const WATCHLIST_SNAPSHOTS_KEY = "djhc-lineup-lab-watchlist-snapshots-v2";
// Bump this when the normalized live payload changes materially. In this
// release, cached team stints can be missing newly imported media and the
// reconstructed team-average/rotation summary. A new prefix makes the browser
// rebuild that source context immediately instead of waiting for the old
// 24-hour entry to expire.
const NBA_CACHE_PREFIX = "djhc-lineup-lab-bref-supabase-v4";
const NBA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TEAM_CODE = "MIN";
const DEFAULT_SEASON_PHASE = "regular";
const UI_TO_ENGINE_PRESET = Object.freeze({
  balanced: "balanced",
  defense: "defense",
  offense: "scoring",
  shooting: "shooting",
  playmaking: "playmaking",
});
const PRESET_LABELS = Object.freeze({
  balanced: "Balanced",
  defense: "Lockdown Defense",
  offense: "Need a Bucket",
  shooting: "Space the Floor",
  playmaking: "Move the Ball",
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
});
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
const CHART_COLORS = ["#1f2fa3", "#e51e2b", "#08775b", "#b06c00"];
const CARD_SEARCH_PATH = "/basketball-cards.html";
const TRUSTED_MEDIA_HOSTS = new Set([
  "www.basketball-reference.com",
  "cdn.ssref.net",
]);

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  form: $("#optimizerForm"),
  playerTableBody: $("#playerTableBody"),
  playerSearch: $("#playerSearchInput"),
  poolSummary: $("#poolSummary"),
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
  productionRulesLegend: $("#productionRulesLegend"),
  productionRulesHelp: $("#productionRulesHelp"),
  positionCoverageHelp: $("#positionCoverageHelp"),
  rotationMinutesHelp: $("#rotationMinutesHelp"),
};

const state = {
  dataset: null,
  activePreset: "balanced",
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
};

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
    return new Map(Object.entries(saved).filter(([, player]) => player && typeof player === "object"));
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
  state.watchlistSnapshots.set(playerId, {
    ...player,
    headshotUrl: safeExternalImageUrl(player.headshotUrl),
    watchlistContext: {
      team: player.team,
      season: source.season || "Custom season",
      sourceLabel: source.label || "Imported player pool",
      savedAt: new Date().toISOString(),
    },
  });
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

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : "-";
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
  link.textContent = "View Cards";
  link.setAttribute("aria-label", `View cards matching ${player?.name || "this player"} in the storefront (opens in a new tab)`);
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

function liveCacheKey(team, season, seasonPhase) {
  return `${NBA_CACHE_PREFIX}:${season}:${seasonPhase}:${team}`;
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
    setSearchScope("Loading the roster data…", "neutral", false);
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
  for (const button of [elements.optimize, elements.mobileOptimize]) {
    button.disabled = disabled || !state.searchScopeCanRun;
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

function liveSelectionMatches(left, right) {
  return Boolean(left && right)
    && left.team === right.team
    && Number(left.season) === Number(right.season)
    && left.seasonPhase === right.seasonPhase;
}

function updateLiveSelectionState({ preserveStatus = false } = {}) {
  if (state.liveDataLoading || !elements.liveTeam.value || !elements.liveSeason.value) return;
  const selection = selectionFromControls();
  const matches = liveSelectionMatches(state.loadedLiveSelection, selection);
  elements.liveDataPanel.dataset.selectionState = matches ? "loaded" : "pending";
  elements.datasetStrip.classList.toggle("has-pending-selection", Boolean(state.dataset && !matches));
  elements.loadLiveData.textContent = matches ? "Reload roster data" : "Load selected roster";
  if (!preserveStatus && !matches) {
    setLiveDataStatus(
      `Selection changed. Load the ${selectedLiveTeamName()} ${nbaSeasonLabel(selection.season)} ${selectedLivePhaseLabel()} roster to replace the current data.`,
      "warning",
    );
  } else if (!preserveStatus && matches) {
    setLiveDataStatus(
      `The current roster matches ${selectedLiveTeamName()} ${nbaSeasonLabel(selection.season)} ${selectedLivePhaseLabel()} stats.`,
      "success",
    );
  }
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
  dataset.players = dataset.players.map((player) => ({
    ...player,
    headshotUrl: headshots.get(player.id) || "",
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
    setOpponentScoutStatus("Apply the team, season, and phase above before building a style counter.");
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

async function populateLiveDataControls() {
  setLiveDataLoading(true, "Loading seasons...");
  setLiveDataStatus("Loading the imported 1980+ NBA seasons...");
  try {
    const seasons = await listSupabaseNbaSeasons();
    if (!Array.isArray(seasons) || seasons.length === 0) {
      throw new Error("No imported NBA seasons are available yet.");
    }
    populateSeasonOptions(seasons);
    await populateLiveTeamOptions({ preferredTeam: DEFAULT_TEAM_CODE });
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
  try {
    localStorage.setItem(
      liveCacheKey(team, season, seasonPhase),
      JSON.stringify({ cachedAt: Date.now(), dataset }),
    );
  } catch {
    // Caching is an optional request-saving optimization.
  }
}

async function loadLiveDataset({ force = false } = {}) {
  if (state.liveDataLoading) return;
  const team = elements.liveTeam.value;
  const season = Number(elements.liveSeason.value);
  const seasonPhase = elements.liveSeasonPhase.value;
  const teamName = selectedLiveTeamName();
  const cached = force ? null : readCachedLiveDataset(team, season, seasonPhase);
  if (cached?.fresh) {
    setDataset(cached.dataset, {
      liveSelection: { team, season, seasonPhase },
      notice: "",
    });
    setLiveDataStatus(
      `Showing a cached Basketball Reference snapshot. Use Reload roster data to check for newer ${teamName} totals.`,
      "success",
    );
    return;
  }

  setLiveDataLoading(true);
  setLiveDataStatus(`Loading ${teamName} ${nbaSeasonLabel(season)} ${selectedLivePhaseLabel()} totals...`);
  try {
    const dataset = await fetchSupabaseNbaTeamDataset({ team, season, seasonPhase, force });
    cacheLiveDataset(team, season, seasonPhase, dataset);
    setDataset(dataset, {
      liveSelection: { team, season, seasonPhase },
      notice: force ? `${dataset.players.length} ${teamName} players loaded from the Basketball Reference database.` : "",
    });
    setLiveDataStatus(
      `Loaded ${dataset.players.length} team-stint players for ${teamName}; totals were converted to per-game stats.`,
      "success",
    );
  } catch (error) {
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
    setLiveDataLoading(false);
  }
}

function setOpponentLoading(loading) {
  state.opponentLoading = loading;
  elements.opponentScout.setAttribute("aria-busy", String(loading));
  elements.opponentTeam.disabled = loading;
  elements.loadOpponent.disabled = loading;
  elements.loadOpponent.textContent = loading ? "Building counter..." : "Build style counter";
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
  if (!(total > 0)) return { ...state.weights };
  return Object.fromEntries(
    Object.entries(rawWeights).map(([metric, value]) => [metric, Math.round((Math.max(0, Number(value) || 0) / total) * 100)]),
  );
}

function deriveHistoricalCounterStrategy(ownAverages, opponentAverages) {
  // This suggestion deliberately uses only same-season team totals already
  // shown to the user. It is a transparent heuristic—not a hidden prediction
  // model—and it never changes settings until the user presses Apply.
  const weights = { ...DEFAULT_PRESETS.balanced };
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
    weights.rebounds += 1.2;
    weights.blocks += 0.2;
    reasons.push("The opponent held a rebounding edge, so the suggestion raises rebounding and interior size.");
  }
  if (leadsByAmount("efgPct", 0.008)) {
    weights.steals += 0.8;
    weights.blocks += 0.8;
    reasons.push("The opponent posted the higher effective field-goal rate, so disruption and rim protection receive more weight.");
  }
  if (leadsByAmount("threePct", 0.01)) {
    weights.steals += 0.6;
    weights.efgPct += 0.35;
    reasons.push("The opponent shot better from three, so perimeter disruption and efficient answering offense rise.");
  }
  if (leadsByRatio("assists", 1.03)) {
    weights.steals += 0.7;
    reasons.push("The opponent created more assists, so the suggestion favors active passing-lane defenders.");
  }
  if (finite(own.turnovers) && finite(opponent.turnovers) && Number(own.turnovers) > Number(opponent.turnovers) + 0.5) {
    weights.ballSecurity += 1;
    reasons.push("The current team committed more turnovers, so ball security becomes a larger priority.");
  }
  if (leadsByRatio("points", 1.02)) {
    weights.points += 0.7;
    weights.efgPct += 0.7;
    reasons.push("The opponent scored more per team game, so the counter adds scoring and shot efficiency.");
  }
  if (reasons.length === 0) {
    reasons.push("No large same-season statistical gap crossed the comparison thresholds, so a balanced mix remains the suggestion.");
  }
  return { weights: normalizedDisplayWeights(weights), reasons };
}

function objectiveWeightsMatch(left, right) {
  return Object.keys(METRIC_LABELS).every((metric) => Number(left?.[metric] || 0) === Number(right?.[metric] || 0));
}

function renderCounterWeightPreview(strategy) {
  const wrap = document.createElement("div");
  wrap.className = "counter-weight-preview table-wrap";
  wrap.tabIndex = 0;
  wrap.setAttribute("aria-label", "Current and suggested optimizer weight comparison");
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
  for (const [metric, label] of Object.entries(METRIC_LABELS)) {
    const current = Number(state.weights[metric] || 0);
    const suggested = Number(strategy.weights[metric] || 0);
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
  teamNote.textContent = `${gameCount} denominator for the ${phase}, estimated from aggregate player minutes with the largest GP total as a lower bound. Team averages are reconstructed from stored team-stint totals.`;
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
      activePreset: state.activePreset,
    };
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
  setOpponentScoutStatus(
    `${source.teamName || source.team} ${source.season} comparison ready. Review the sourced averages, signed gaps, and optional weight preview below.`,
    "success",
  );
}

async function loadOpponentScout() {
  if (state.opponentLoading || state.liveDataLoading) return;
  const selection = selectionFromControls();
  if (!liveSelectionMatches(state.loadedLiveSelection, selection)) {
    clearOpponentScout("Apply the selected team-season above before building a style counter.");
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
      staleResponseMessage = "The team, season, phase, or opponent changed while the comparison was loading. Load the current roster, then build the style counter again.";
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

function applyPreset(uiPreset, { announce = false, invalidate = true } = {}) {
  const enginePreset = UI_TO_ENGINE_PRESET[uiPreset] || "balanced";
  const rawWeights = DEFAULT_PRESETS[enginePreset];
  const total = Object.values(rawWeights).reduce((sum, weight) => sum + weight, 0);
  state.activePreset = uiPreset;
  state.weights = Object.fromEntries(
    Object.entries(rawWeights).map(([metric, weight]) => [metric, Math.round((weight / total) * 100)]),
  );
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
  $$('[data-weight]').forEach((input) => {
    input.value = String(state.weights[input.dataset.weight] ?? 0);
    const output = input.parentElement.querySelector("output");
    output.textContent = input.value;
  });
}

function updateRunSummary() {
  const modeLabel = elements.mode.value === "rotation"
    ? `${numberFromInput(elements.size, 9)}-player rotation · 240 total minutes`
    : "Best 5-player group";
  elements.runModeSummary.textContent = modeLabel;
  elements.mobileSolveLabel.textContent = modeLabel;
  elements.runPresetSummary.textContent = PRESET_LABELS[state.activePreset] || "Custom mix";
  elements.runLockedSummary.textContent = String(state.lockedIds.size);
  elements.runExcludedSummary.textContent = String(state.excludedIds.size);
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
  elements.results.classList.remove("is-stale");
  elements.resultFreshness.hidden = true;
  elements.resultFreshness.textContent = "";
  elements.results.hidden = true;
  elements.emptyResult.hidden = false;
  elements.emptyResultHeading.textContent = heading;
  elements.emptyResultCopy.textContent = copy;
  elements.copyResult.disabled = true;
  elements.downloadResult.disabled = true;
}

function markScenarioChanged() {
  state.scenarioVersion += 1;
  if (state.optimizationWorker || state.activeOptimizationToken !== null) cancelOptimization();
  if (state.lastResult) {
    elements.results.classList.add("is-stale");
    elements.resultFreshness.hidden = false;
    elements.resultFreshness.textContent = "Settings changed after this result was calculated. Run the optimizer again before copying or downloading it.";
    elements.copyResult.disabled = true;
    elements.downloadResult.disabled = true;
    setSolverStatus("Settings changed - update the result", "warning");
  } else {
    setSolverStatus("Ready with your latest settings");
  }
  const verb = state.lastResult ? "Update" : "Optimize";
  setOptimizeButtons({ label: `${verb} ${elements.mode.value === "rotation" ? "rotation" : "lineup"}` });
  updateSearchScope();
}

function setMode(mode, { preserveSize = false } = {}) {
  const isRotation = mode === "rotation";
  elements.rotationSettings.hidden = !isRotation;
  const productionQualifier = document.createElement("span");
  productionQualifier.textContent = "(optional requirements)";
  elements.productionRulesLegend.replaceChildren(
    document.createTextNode(isRotation ? "Projected rotation production " : "Combined player profiles "),
    productionQualifier,
  );
  elements.productionRulesHelp.textContent = isRotation
    ? "For every candidate, these rules use the exact 240-minute plan to create minute-weighted per-game team projections. They are historical-stat estimates, not game predictions."
    : "In lineup mode, these rules add each selected player's historical per-game line. They describe the five-player profile; they do not forecast one team box score.";
  elements.positionCoverageHelp.textContent = isRotation
    ? "Roster counts are minimum composition requirements. Separately, every plan must cover 96 guard, 96 forward, and 48 center minutes. Source-listed flex players can split their minutes across compatible roles."
    : "Players can cover every source-listed role. For example, a PF-C may fill a forward or center requirement, but each selected player fills only one required roster slot.";
  elements.rotationMinutesHelp.textContent = "For every candidate, the optimizer assigns exactly 240 integer minutes to maximize your strategy fit while covering 96 guard, 96 forward, and 48 center minutes.";
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

function recommendedMinimumGames(seasonPhase) {
  // A 20-game floor is useful for an 82-game regular season but would erase
  // most legitimate postseason pools. Keep the defaults phase-aware while
  // preserving any value the user deliberately customized.
  return seasonPhase === "playoffs" ? 3 : 20;
}

function applyLoadedPhaseEligibilityDefault(seasonPhase) {
  const nextDefault = recommendedMinimumGames(seasonPhase);
  if (numberFromInput(elements.minGames, state.recommendedMinGames) === state.recommendedMinGames) {
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
    createCell(row, formatNumber(player.steals), "", "STL");
    createCell(row, formatNumber(player.blocks), "", "BLK");
    createCell(row, formatNumber(player.turnovers), "", "TOV");

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
    const compareCell = createCell(row, "", "", "Compare");
    compareCell.append(createTableCheckbox(
      player,
      "compare",
      "Compare",
      state.compareIds.has(player.id),
      state.compareIds.size >= 4 && !state.compareIds.has(player.id),
    ));
    const watchCell = createCell(row, "", "", "Watch");
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
    `${state.lockedIds.size} locked`,
    `${state.excludedIds.size} excluded`,
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
  state.scenarioVersion += 1;
  state.dataset = dataset;
  state.loadedLiveSelection = liveSelection;
  state.playerMediaStatus.clear();
  state.teamLogoStatus = "unavailable";
  clearOpponentScout(liveSelection
    ? "Choose another team from this season and phase to load its averages and historical rotation."
    : "Load a database team-season above before building a style counter.");
  if (clearScenario) {
    state.lockedIds.clear();
    state.excludedIds.clear();
    state.compareIds.clear();
    elements.playerSearch.value = "";
    clearRenderedResult();
  }
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
  setOptimizeButtons({ label: elements.mode.value === "rotation" ? "Optimize rotation" : "Optimize lineup" });
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
  if (source.url) {
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.provider ? "View the cited source table" : "View the cited source page";
    elements.sourceAttribution.append(link);
    if (source.note) elements.sourceAttribution.append(document.createTextNode(". "));
  }
  if (source.note) elements.sourceAttribution.append(document.createTextNode(source.note));
}

async function loadFixture({ notice = "" } = {}) {
  const response = await fetch(FIXTURE_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Demo data could not be loaded (${response.status}).`);
  const rawDataset = await response.json();
  const dataset = normalizeDataset(rawDataset, { strict: true, warnOnGeneratedId: false });
  setDataset(dataset, { notice });
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
  const maxTurnovers = optionalNumber(elements.maxTurnovers);
  if (maxTurnovers !== undefined) config.maxTurnovers = maxTurnovers;
  if (config.mode === "rotation") {
    config.rotationOptions = {
      minMinutes: numberFromInput(elements.rotationMin, 8),
      maxMinutes: numberFromInput(elements.rotationMax, 40),
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

function renderLineupPlayer(player, lineup, index) {
  const card = document.createElement("article");
  card.className = "lineup-player";
  const top = document.createElement("div");
  top.className = "lineup-player__top";
  const position = document.createElement("span");
  position.className = "position-pill";
  position.textContent = assignedPosition(lineup, player.id);
  const rank = document.createElement("span");
  rank.className = "lineup-player__rank";
  rank.textContent = String(index + 1).padStart(2, "0");
  top.append(position, rank);
  const avatar = createPlayerAvatar(player, "lineup-player__portrait");
  const name = document.createElement("h3");
  name.textContent = player.name;
  const stats = document.createElement("dl");
  for (const [label, value] of [
    ["PTS", player.points],
    ["REB", player.rebounds],
    ["AST", player.assists],
  ]) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = formatNumber(value);
    wrap.append(dt, dd);
    stats.append(wrap);
  }
  card.append(top);
  if (avatar) card.append(avatar);
  card.append(name, stats, createCardSearchLink(player));
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
    label.textContent = METRIC_LABELS[metric] || titleCase(metric);
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

function renderRotationMinutes(rotation) {
  const card = document.createElement("section");
  card.className = "result-card";
  const heading = document.createElement("h3");
  heading.textContent = "240-minute rotation plan";
  const note = document.createElement("p");
  note.className = "rotation-plan-note";
  note.textContent = "Minutes maximize the selected strategy within your player limits. Role splits prove the group can cover 96 guard, 96 forward, and 48 center minutes.";
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
    roles.textContent = roleMinuteSummary(allocation.roleMinutes) || "Utility minutes";
    playerLabel.append(name, roles);
    const track = document.createElement("span");
    track.className = "metric-bar__track";
    const fill = document.createElement("span");
    fill.className = "metric-bar__fill";
    fill.style.width = `${(allocation.minutes / 48) * 100}%`;
    track.append(fill);
    const minutes = document.createElement("strong");
    minutes.textContent = `${allocation.minutes} min`;
    row.append(playerLabel, track, minutes);
    list.append(row);
  }
  card.append(heading, note, list);
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
  heading.textContent = "Recommended and next-best feasible groups";
  const note = document.createElement("p");
  note.textContent = `Fit gap shows points below the recommended group's pool-relative score. Roster changes make each tradeoff explicit. ${best.rotation ? "Production columns are minute-weighted from each group's own 240-minute plan." : "Production columns add the selected players' per-game profiles."}`;
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
  for (const heading of ["Rank", "Players", "Fit score", "Fit gap", "Changes from #1", "Main production tradeoff", "PTS", "REB", "AST", "TOV"]) {
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
    const scoreGap = Math.max(0, Number(best.score) - Number(lineup.score));
    const row = document.createElement("tr");
    createCell(row, `#${lineup.rank}`);
    createCell(row, lineup.players.map((player) => player.name).join(", "));
    createCell(row, formatNumber(lineup.score));
    createCell(row, lineup.rank === 1 ? "Best" : `−${formatNumber(scoreGap)}`);
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

function renderSuccess(result) {
  const best = result.best;
  const fitPoolSize = state.dataset.players.filter((player) => isPlayerEligible(player) && !state.excludedIds.has(player.id)).length;
  const productionExplanation = best.rotation
    ? "Production is minute-weighted from the exact 240-minute plan."
    : "Profiles add each selected player's per-game averages.";
  const feasibleCount = result.diagnostics.feasibleCombinations;
  const possibleCount = result.combinationsEvaluated;
  const countIsComplete = result.diagnostics.feasibleCombinationCountComplete !== false;
  // Bound-pruned rotations do not need full constraint classification once
  // their best-possible score cannot enter the displayed top results. The
  // winner and alternatives remain exact, but calling the confirmed feasible
  // count complete would overstate what the proof established.
  const feasibilityExplanation = countIsComplete
    ? `${feasibleCount.toLocaleString()} group${feasibleCount === 1 ? "" : "s"} met every requirement after checking ${possibleCount.toLocaleString()} possible group${possibleCount === 1 ? "" : "s"}.`
    : `At least ${feasibleCount.toLocaleString()} group${feasibleCount === 1 ? "" : "s"} met every requirement. The displayed top results were proven exact after bounding ${result.diagnostics.constraintBoundPruned.toLocaleString()} lower-ceiling group${result.diagnostics.constraintBoundPruned === 1 ? "" : "s"} among ${possibleCount.toLocaleString()} possibilities; bounded groups did not need full constraint classification.`;
  elements.resultSummary.textContent = `${feasibilityExplanation} The fit score is relative to ${fitPoolSize} eligible, non-excluded players—not a win probability. ${productionExplanation}`;
  const fragment = document.createDocumentFragment();
  const scoreboard = document.createElement("div");
  scoreboard.className = "result-scoreboard";
  const productionPrefix = best.rotation ? "Projected" : "Combined";
  scoreboard.append(
    renderScoreCard("Fit score in this pool", `${formatNumber(best.score)} / 100`, true),
    renderScoreCard(`${productionPrefix} PTS`, formatNumber(best.totals.points)),
    renderScoreCard(`${productionPrefix} REB`, formatNumber(best.totals.rebounds)),
    renderScoreCard(`${productionPrefix} AST`, formatNumber(best.totals.assists)),
    renderScoreCard(`${productionPrefix} TOV`, formatNumber(best.totals.turnovers)),
  );
  const lineup = document.createElement("div");
  lineup.className = "lineup-grid";
  best.players.forEach((player, index) => lineup.append(renderLineupPlayer(player, best, index)));

  const detailGrid = document.createElement("div");
  detailGrid.className = "result-detail-grid";
  const contributionCard = document.createElement("section");
  contributionCard.className = "result-card";
  const contributionHeading = document.createElement("h3");
  contributionHeading.textContent = "Why this group fits your strategy";
  contributionCard.append(contributionHeading, renderContributionList(best.contributionBreakdown));
  const auditCard = document.createElement("section");
  auditCard.className = "result-card";
  const auditHeading = document.createElement("h3");
  auditHeading.textContent = "Constraint check";
  auditCard.append(auditHeading, renderAudit(best.constraintAudit));
  detailGrid.append(contributionCard, auditCard);

  fragment.append(scoreboard, lineup, detailGrid);
  if (best.rotation) fragment.append(renderRotationMinutes(best.rotation));
  if (result.alternatives.length > 1) fragment.append(renderAlternatives(result.alternatives, best));
  elements.resultContent.replaceChildren(fragment);
}

function renderFailure(result) {
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
  event.preventDefault();
  if (!state.dataset) return;
  updateSearchScope();
  if (!state.searchScopeCanRun) return;
  if (!elements.form.reportValidity()) return;
  const jobToken = cancelOptimization("A newer optimization replaced the previous request.");
  const scenarioVersion = state.scenarioVersion;
  state.activeOptimizationToken = jobToken;
  elements.results.classList.remove("is-stale");
  elements.resultFreshness.hidden = true;
  elements.resultFreshness.textContent = "";
  setOptimizeButtons({ disabled: true, label: "Solving..." });
  elements.form.setAttribute("aria-busy", "true");
  setSolverStatus("Running an exact search...", "working");
  // Yield once so the "Solving" state can paint, then re-check both identities.
  // A fast user edit in that frame cancels the request before any expensive
  // combination enumeration is sent to the Worker.
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  try {
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    const result = await runOptimization(state.dataset.players, buildOptimizerConfig(), jobToken);
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    state.lastResult = result;
    elements.results.classList.remove("is-stale");
    elements.resultFreshness.hidden = true;
    elements.resultsHeading.textContent = result.mode === "rotation"
      ? "Best rotation for these settings"
      : "Best lineup for these settings";
    if (result.ok) renderSuccess(result);
    else renderFailure(result);
    elements.resultActions.hidden = !result.ok;
    elements.emptyResult.hidden = true;
    elements.results.hidden = false;
    elements.copyResult.disabled = !result.ok;
    elements.downloadResult.disabled = !result.ok;
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
    setSolverStatus("Scenario needs attention", "warning");
    showToast(detail);
  } finally {
    if (jobToken !== state.optimizationRunId || scenarioVersion !== state.scenarioVersion) return;
    state.activeOptimizationToken = null;
    elements.form.removeAttribute("aria-busy");
    setOptimizeButtons({ disabled: false });
    const needsUpdate = !elements.resultFreshness.hidden;
    setOptimizeButtons({
      label: elements.mode.value === "rotation"
        ? (needsUpdate ? "Update rotation" : "Optimize rotation")
        : (needsUpdate ? "Update lineup" : "Optimize lineup"),
    });
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

function percentileWithinPool(player, metric, lowerIsBetter = false, pool = comparisonPool()) {
  const values = pool
    .map((item) => Number(item[metric]))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (values.length === 0 || !Number.isFinite(Number(player[metric]))) return 0;
  if (values.length <= 1) return 100;
  const value = Number(player[metric]);
  const lower = values.filter((candidate) => candidate < value).length;
  const equal = values.filter((candidate) => candidate === value).length;
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
  elements.compareContent.replaceChildren();
  if (selected.length < 2) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const heading = document.createElement("h3");
    heading.textContent = selected.length === 1 ? "Choose one more player" : "Choose two to four players";
    const copy = document.createElement("p");
    copy.textContent = `Use the Compare checkboxes in the optimizer's player table. The current percentile pool contains ${pool.length} eligible, non-excluded player${pool.length === 1 ? "" : "s"}.`;
    empty.append(heading, copy);
    elements.compareContent.append(empty);
    return;
  }

  const poolNote = document.createElement("p");
  poolNote.className = "compare-pool-note";
  poolNote.textContent = `${pool.length} player${pool.length === 1 ? "" : "s"} meet the current sample filters and are not excluded. Percentiles below use exactly that pool; a compared player can remain visible after being excluded.`;

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
  scroll.setAttribute("aria-label", `Percentile comparison across ${pool.length} eligible, non-excluded players`);
  const bars = document.createElement("div");
  bars.className = "compare-bars";
  bars.style.padding = "1rem";
  for (const [metric, labelText, lowerIsBetter] of COMPARE_METRICS) {
    const row = document.createElement("div");
    row.className = "compare-row";
    const label = document.createElement("strong");
    label.textContent = labelText;
    const rowBars = document.createElement("div");
    rowBars.className = "compare-row__bars";
    selected.forEach((player, index) => {
      const percentile = percentileWithinPool(player, metric, lowerIsBetter, pool);
      const valueText = metric.endsWith("Pct")
        ? formatPercent(player[metric])
        : formatNumber(player[metric]);
      const line = document.createElement("div");
      line.className = "compare-player-line";
      const track = document.createElement("span");
      track.className = "compare-player-track";
      const bar = document.createElement("div");
      bar.className = "compare-player-bar";
      bar.style.width = `${Math.max(2, percentile)}%`;
      bar.style.background = CHART_COLORS[index];
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-valuemin", "0");
      bar.setAttribute("aria-valuemax", "100");
      bar.setAttribute("aria-valuenow", String(Math.round(percentile)));
      bar.setAttribute("aria-label", `${player.name}: ${labelText}`);
      bar.setAttribute("aria-valuetext", `${player.name}, ${labelText}: ${valueText}; ${Math.round(percentile)}th percentile among ${pool.length} eligible, non-excluded players`);
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
  if (!result?.ok) return "";
  const best = result.best;
  const lines = [
    `DJ's Lineup Lab - ${elements.mode.value === "rotation" ? "Optimized rotation roster + minutes plan" : "Optimized lineup"}`,
    `Strategy: ${PRESET_LABELS[state.activePreset] || "Custom mix"}`,
    `Pool-relative fit score: ${formatNumber(best.score)} / 100`,
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
  if (!best) return;
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
  const text = await file.text();
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
  const warningCount = dataset.diagnostics.warnings.length;
  setDataset(dataset, {
    notice: `${dataset.players.length} players imported${warningCount ? ` with ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}.`,
  });
  setLiveDataStatus("Using an imported CSV. Choose a team and season above to return to live data.");
}

function resetScenario() {
  cancelOptimization("Optimization cancelled because the scenario was reset.");
  state.scenarioVersion += 1;
  elements.mode.value = "lineup";
  setMode("lineup");
  elements.alternatives.value = "5";
  const loadedPhase = state.loadedLiveSelection?.seasonPhase || DEFAULT_SEASON_PHASE;
  state.recommendedMinGames = recommendedMinimumGames(loadedPhase);
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
  state.lockedIds.clear();
  state.excludedIds.clear();
  state.opponentWeightUndo = null;
  applyPreset("balanced", { invalidate: false });
  clearRenderedResult();
  setSolverStatus("Ready to solve");
  setOptimizeButtons({ label: "Optimize lineup" });
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
  $$('[data-weight]').forEach((input) => {
    input.addEventListener("input", () => {
      state.weights[input.dataset.weight] = Number(input.value);
      input.parentElement.querySelector("output").textContent = input.value;
      state.activePreset = "custom";
      state.opponentWeightUndo = null;
      renderPresetState();
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
    markScenarioChanged();
  });
  elements.form.addEventListener("submit", runOptimizer);
  elements.playerTableBody.addEventListener("change", handlePlayerControl);
  elements.playerTableBody.addEventListener("click", handlePlayerControl);
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
  elements.downloadResult.addEventListener("click", downloadResult);
  elements.loadLiveData.addEventListener("click", () => {
    loadLiveDataset({ force: true }).catch((error) => {
      showToast(error instanceof Error ? `Couldn't load team data: ${error.message}` : "Team data could not be loaded.");
    });
  });
  const handleSeasonOrPhaseChange = () => {
    clearOpponentScout("Apply the updated team-season before building a style counter.");
    refreshLiveTeamOptions();
  };
  elements.liveSeason.addEventListener("change", handleSeasonOrPhaseChange);
  elements.liveSeasonPhase.addEventListener("change", handleSeasonOrPhaseChange);
  elements.liveTeam.addEventListener("change", () => {
    updateLiveSelectionState();
    clearOpponentScout("Apply this team as the player pool before building a style counter.");
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
      setOpponentScoutStatus(`Build a style counter for ${teamNameForCode(elements.opponentTeam.value)} to view historical averages and rotation.`);
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
  bindEvents();
  applyPreset("balanced", { invalidate: false });
  setMode("lineup", { preserveSize: true });
  try {
    await populateLiveDataControls();
    await loadLiveDataset();
  } catch (error) {
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
  }
}

initialize();
