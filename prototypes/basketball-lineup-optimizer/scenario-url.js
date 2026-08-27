/**
 * Versioned, browser-safe scenario URL codec for the Lineup Lab.
 *
 * A shared link describes assumptions, not a cached result. The recipient
 * always reloads the cited team stint and runs the exact solver locally, which
 * keeps a shared scenario honest when the underlying source snapshot updates.
 */

export const SCENARIO_URL_VERSION = "1";

const MODE_VALUES = new Set(["lineup", "rotation"]);
const EXPERIENCE_VALUES = new Set(["simple", "detailed"]);
const PHASE_VALUES = new Set(["regular", "playoffs"]);
const PRESET_VALUES = new Set(["balanced", "defense", "offense", "shooting", "playmaking", "rebounding", "custom"]);
const POSITION_FLEXIBILITY_VALUES = new Set(["recommended", "open", "seasonOnly"]);
const ROTATION_MINUTE_PLAN_VALUES = new Set(["historicalAware", "openWhatIf"]);
const ROTATION_ALLOCATION_STYLE_VALUES = new Set(["preserveWorkload", "strategyFirst"]);
const ROTATION_RATE_STABILITY_VALUES = new Set(["sampleAdjusted", "raw"]);
const ROTATION_POSITION_PROFILE_VALUES = new Set(["automatic", "traditional", "small", "big"]);
// These sets mirror the visible selects in index.html. A shared URL must never
// claim to restore an assumption the receiving UI cannot actually represent.
const ROTATION_MINUTE_FLEXIBILITY_VALUES = new Set([4, 8, 12, 16]);
const ROTATION_ROLE_PROFILE_VALUES = new Set([
  "96:96:48",
  "120:96:24",
  "72:120:48",
]);
const WEIGHT_CODES = Object.freeze({
  points: "p",
  efgPct: "e",
  threePct: "h",
  rebounds: "r",
  assists: "a",
  steals: "s",
  blocks: "b",
  ballSecurity: "t",
  offensiveImpact: "o",
  defensiveImpact: "d",
});
const WEIGHT_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(WEIGHT_CODES).map(([field, code]) => [code, field]),
));
const STAT_CODES = Object.freeze({
  points: "p",
  rebounds: "r",
  assists: "a",
  steals: "s",
  blocks: "b",
});
const STAT_FIELDS = Object.freeze(Object.fromEntries(
  Object.entries(STAT_CODES).map(([field, code]) => [code, field]),
));
const MAX_SHARED_IDS = 24;
const MAX_QUERY_LENGTH = 3500;

function finiteNumber(value, { minimum = -Infinity, maximum = Infinity, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) return undefined;
  return integer && !Number.isInteger(number) ? undefined : number;
}

function commaSeparatedIds(value, warnings, label) {
  if (!value) return [];
  const seen = new Set();
  const ids = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((id) => {
      if (!/^[a-z0-9_-]{1,80}$/i.test(id)) {
        warnings.push(`Ignored an invalid ${label} player ID from the shared link.`);
        return false;
      }
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, MAX_SHARED_IDS);
  if (seen.size > MAX_SHARED_IDS) {
    warnings.push(`Shared links can include at most ${MAX_SHARED_IDS} locked or excluded player IDs.`);
  }
  return ids;
}

function addFiniteParameter(params, key, value, options) {
  const number = finiteNumber(value, options);
  if (number !== undefined) params.set(key, String(number));
}

function encodeWeights(weights = {}) {
  return Object.entries(WEIGHT_CODES)
    .map(([field, code]) => {
      const value = finiteNumber(weights[field], { minimum: 0, maximum: 100, integer: true });
      return value && value > 0 ? `${code}:${value}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function decodeWeights(value, warnings) {
  const weights = {};
  for (const entry of String(value || "").split(",")) {
    const [code, rawValue] = entry.split(":");
    const field = WEIGHT_FIELDS[code];
    const number = finiteNumber(rawValue, { minimum: 0, maximum: 100, integer: true });
    if (!field || number === undefined) {
      if (entry) warnings.push("Ignored an invalid strategy weight from the shared link.");
      continue;
    }
    weights[field] = number;
  }
  return weights;
}

function encodeStatMinimums(minimums = {}) {
  return Object.entries(STAT_CODES)
    .map(([field, code]) => {
      const value = finiteNumber(minimums[field], { minimum: 0, maximum: 10000 });
      return value !== undefined && value > 0 ? `${code}:${value}` : "";
    })
    .filter(Boolean)
    .join(",");
}

function decodeStatMinimums(value, warnings) {
  const statMinimums = {};
  for (const entry of String(value || "").split(",")) {
    const [code, rawValue] = entry.split(":");
    const field = STAT_FIELDS[code];
    const number = finiteNumber(rawValue, { minimum: 0, maximum: 10000 });
    if (!field || number === undefined) {
      if (entry) warnings.push("Ignored an invalid production rule from the shared link.");
      continue;
    }
    statMinimums[field] = number;
  }
  return statMinimums;
}

/** Encode visible scenario controls into a compact query string without a `?`. */
export function encodeScenarioQuery(input = {}) {
  const params = new URLSearchParams();
  params.set("v", SCENARIO_URL_VERSION);
  const team = String(input.team || "").trim().toUpperCase();
  if (/^[A-Z0-9]{2,8}$/.test(team)) params.set("team", team);
  addFiniteParameter(params, "season", input.season, { minimum: 1980, maximum: 2200, integer: true });
  if (PHASE_VALUES.has(input.phase)) params.set("phase", input.phase);
  if (EXPERIENCE_VALUES.has(input.experience)) params.set("experience", input.experience);
  if (MODE_VALUES.has(input.mode)) params.set("mode", input.mode);
  addFiniteParameter(params, "size", input.size, { minimum: 5, maximum: 12, integer: true });
  addFiniteParameter(params, "alts", input.alternatives, { minimum: 1, maximum: 50, integer: true });
  if (PRESET_VALUES.has(input.preset)) params.set("preset", input.preset);
  if (POSITION_FLEXIBILITY_VALUES.has(input.positionFlexibility)) {
    params.set("positionFlex", input.positionFlexibility);
  }
  const weights = encodeWeights(input.weights);
  if (weights) params.set("w", weights);
  addFiniteParameter(params, "games", input.minGames, { minimum: 0, maximum: 200, integer: true });
  addFiniteParameter(params, "mpg", input.minMinutes, { minimum: 0, maximum: 48 });
  const positions = input.positionMinimums || {};
  const positionParts = [
    ["g", positions.G],
    ["f", positions.F],
    ["c", positions.C],
  ].map(([code, value]) => {
    const number = finiteNumber(value, { minimum: 0, maximum: 12, integer: true });
    return number !== undefined ? `${code}:${number}` : "";
  }).filter(Boolean);
  if (positionParts.length) params.set("pos", positionParts.join(","));
  const statMinimums = encodeStatMinimums(input.statMinimums);
  if (statMinimums) params.set("min", statMinimums);
  addFiniteParameter(params, "tov", input.maxTurnovers, { minimum: 0, maximum: 1000 });
  addFiniteParameter(params, "rmin", input.rotationMin, { minimum: 0, maximum: 48, integer: true });
  addFiniteParameter(params, "rmax", input.rotationMax, { minimum: 0, maximum: 48, integer: true });
  if (["perGame", "per36", "per100Estimated", "eraRelative"].includes(input.analyticsView)) {
    params.set("view", input.analyticsView);
  }
  if (["perGame", "per36"].includes(input.rotationScoreBasis)) {
    params.set("scoreBasis", input.rotationScoreBasis);
  }
  if (ROTATION_MINUTE_PLAN_VALUES.has(input.rotationMinutePlan)) {
    params.set("minutePlan", input.rotationMinutePlan);
  }
  if (ROTATION_ALLOCATION_STYLE_VALUES.has(input.rotationHistoricalAllocationStyle)) {
    params.set("minuteStyle", input.rotationHistoricalAllocationStyle);
  }
  const minuteFlexibility = finiteNumber(input.rotationMinuteFlexibility, {
    minimum: 0,
    maximum: 48,
    integer: true,
  });
  if (ROTATION_MINUTE_FLEXIBILITY_VALUES.has(minuteFlexibility)) {
    params.set("minuteFlex", String(minuteFlexibility));
  }
  if (ROTATION_RATE_STABILITY_VALUES.has(input.rotationRateStability)) {
    params.set("rateStability", input.rotationRateStability);
  }
  if (ROTATION_POSITION_PROFILE_VALUES.has(input.rotationPositionProfile)) {
    params.set("roleProfile", input.rotationPositionProfile);
  }
  const roleMinutes = input.rotationPositionMinuteRequirements || {};
  const normalizedRoleMinutes = [
    ["g", "G"],
    ["f", "F"],
    ["c", "C"],
  ].map(([code, field]) => ({
    code,
    value: finiteNumber(roleMinutes[field], { minimum: 0, maximum: 240, integer: true }),
  }));
  const hasCompleteRoleProfile = normalizedRoleMinutes.every(({ value }) => value !== undefined);
  const roleMinuteTotal = normalizedRoleMinutes.reduce(
    (sum, { value }) => sum + (value ?? 0),
    0,
  );
  const roleProfileKey = normalizedRoleMinutes.map(({ value }) => value ?? "").join(":");
  // Automatic uses the full loaded roster to derive its target at run time.
  // Do not pin a coincidentally familiar 240-minute split into the link: the
  // receiving page should derive the same current team-season profile rather
  // than restoring a stale manual-looking snapshot alongside "automatic".
  const isAutomaticRoleProfile = input.rotationPositionProfile === "automatic";
  if (
    !isAutomaticRoleProfile &&
    hasCompleteRoleProfile &&
    roleMinuteTotal === 240 &&
    ROTATION_ROLE_PROFILE_VALUES.has(roleProfileKey)
  ) {
    params.set(
      "roleMinutes",
      normalizedRoleMinutes.map(({ code, value }) => `${code}:${value}`).join(","),
    );
  }
  const lockedIds = Array.isArray(input.lockedIds) ? input.lockedIds.slice(0, MAX_SHARED_IDS) : [];
  const excludedIds = Array.isArray(input.excludedIds) ? input.excludedIds.slice(0, MAX_SHARED_IDS) : [];
  if (lockedIds.length) params.set("lock", lockedIds.map(String).join(","));
  if (excludedIds.length) params.set("exclude", excludedIds.map(String).join(","));
  const query = params.toString();
  // The UI will surface a friendly message rather than generating links that
  // browsers, email clients, or social sites may truncate.
  if (query.length > MAX_QUERY_LENGTH) throw new Error("This scenario has too many saved player IDs to share in one link.");
  return query;
}

/** Decode a query string defensively; malformed entries are ignored with notes. */
export function decodeScenarioQuery(search = "") {
  const raw = String(search || "").replace(/^\?/, "");
  const params = new URLSearchParams(raw);
  const warnings = [];
  if (!params.has("v")) return { scenario: null, warnings };
  if (params.get("v") !== SCENARIO_URL_VERSION) {
    return { scenario: null, warnings: ["This shared scenario uses an unsupported link version."] };
  }
  const scenario = { version: SCENARIO_URL_VERSION };
  const team = String(params.get("team") || "").trim().toUpperCase();
  if (team) {
    if (/^[A-Z0-9]{2,8}$/.test(team)) scenario.team = team;
    else warnings.push("Ignored an invalid team from the shared link.");
  }
  const season = finiteNumber(params.get("season"), { minimum: 1980, maximum: 2200, integer: true });
  if (season !== undefined) scenario.season = season;
  for (const [key, allowed] of [
    ["phase", PHASE_VALUES],
    ["mode", MODE_VALUES],
    ["preset", PRESET_VALUES],
    ["experience", EXPERIENCE_VALUES],
  ]) {
    const value = params.get(key);
    if (!value) continue;
    if (allowed.has(value)) scenario[key] = value;
    else warnings.push(`Ignored an invalid ${key} from the shared link.`);
  }
  for (const [parameter, property, options] of [
    ["size", "size", { minimum: 5, maximum: 12, integer: true }],
    ["alts", "alternatives", { minimum: 1, maximum: 50, integer: true }],
    ["games", "minGames", { minimum: 0, maximum: 200, integer: true }],
    ["mpg", "minMinutes", { minimum: 0, maximum: 48 }],
    ["tov", "maxTurnovers", { minimum: 0, maximum: 1000 }],
    ["rmin", "rotationMin", { minimum: 0, maximum: 48, integer: true }],
    ["rmax", "rotationMax", { minimum: 0, maximum: 48, integer: true }],
  ]) {
    const rawValue = params.get(parameter);
    if (rawValue === null) continue;
    const value = finiteNumber(rawValue, options);
    if (value === undefined) warnings.push(`Ignored an invalid ${property} from the shared link.`);
    else scenario[property] = value;
  }
  scenario.weights = decodeWeights(params.get("w"), warnings);
  scenario.statMinimums = decodeStatMinimums(params.get("min"), warnings);
  const positionMinimums = {};
  for (const entry of String(params.get("pos") || "").split(",")) {
    const [code, rawValue] = entry.split(":");
    const field = ({ g: "G", f: "F", c: "C" })[code];
    const value = finiteNumber(rawValue, { minimum: 0, maximum: 12, integer: true });
    if (!entry) continue;
    if (!field || value === undefined) warnings.push("Ignored an invalid position requirement from the shared link.");
    else positionMinimums[field] = value;
  }
  scenario.positionMinimums = positionMinimums;
  const analyticsView = params.get("view");
  if (analyticsView) {
    if (["perGame", "per36", "per100Estimated", "eraRelative"].includes(analyticsView)) scenario.analyticsView = analyticsView;
    else warnings.push("Ignored an invalid analytics view from the shared link.");
  }
  const rotationScoreBasis = params.get("scoreBasis");
  if (rotationScoreBasis) {
    if (["perGame", "per36"].includes(rotationScoreBasis)) scenario.rotationScoreBasis = rotationScoreBasis;
    else warnings.push("Ignored an invalid rotation scoring basis from the shared link.");
  }
  const rotationMinutePlan = params.get("minutePlan");
  if (rotationMinutePlan) {
    if (ROTATION_MINUTE_PLAN_VALUES.has(rotationMinutePlan)) scenario.rotationMinutePlan = rotationMinutePlan;
    else warnings.push("Ignored an invalid rotation minute plan from the shared link.");
  }
  const rotationHistoricalAllocationStyle = params.get("minuteStyle");
  if (rotationHistoricalAllocationStyle) {
    if (ROTATION_ALLOCATION_STYLE_VALUES.has(rotationHistoricalAllocationStyle)) {
      scenario.rotationHistoricalAllocationStyle = rotationHistoricalAllocationStyle;
    } else {
      warnings.push("Ignored an invalid rotation minute-use style from the shared link.");
    }
  }
  const rotationMinuteFlexibility = finiteNumber(params.get("minuteFlex"), {
    minimum: 0,
    maximum: 48,
    integer: true,
  });
  if (params.has("minuteFlex")) {
    if (!ROTATION_MINUTE_FLEXIBILITY_VALUES.has(rotationMinuteFlexibility)) warnings.push("Ignored an unsupported rotation minute flexibility from the shared link.");
    else scenario.rotationMinuteFlexibility = rotationMinuteFlexibility;
  }
  const rotationRateStability = params.get("rateStability");
  if (rotationRateStability) {
    if (ROTATION_RATE_STABILITY_VALUES.has(rotationRateStability)) scenario.rotationRateStability = rotationRateStability;
    else warnings.push("Ignored an invalid rotation rate-stability setting from the shared link.");
  }
  const rotationPositionProfile = params.get("roleProfile");
  if (rotationPositionProfile) {
    if (ROTATION_POSITION_PROFILE_VALUES.has(rotationPositionProfile)) {
      scenario.rotationPositionProfile = rotationPositionProfile;
    } else {
      warnings.push("Ignored an invalid rotation position profile from the shared link.");
    }
  }
  const positionFlexibility = params.get("positionFlex");
  if (positionFlexibility) {
    if (POSITION_FLEXIBILITY_VALUES.has(positionFlexibility)) {
      scenario.positionFlexibility = positionFlexibility;
    } else {
      warnings.push("Ignored an invalid position-flexibility policy from the shared link.");
    }
  }
  const rotationPositionMinuteRequirements = {};
  for (const entry of String(params.get("roleMinutes") || "").split(",")) {
    const [code, rawValue] = entry.split(":");
    const field = ({ g: "G", f: "F", c: "C" })[code];
    const value = finiteNumber(rawValue, { minimum: 0, maximum: 240, integer: true });
    if (!entry) continue;
    if (!field || value === undefined) warnings.push("Ignored an invalid on-court role-minute setting from the shared link.");
    else rotationPositionMinuteRequirements[field] = value;
  }
  if (Object.keys(rotationPositionMinuteRequirements).length > 0) {
    const complete = ["G", "F", "C"].every((position) => Number.isInteger(rotationPositionMinuteRequirements[position]));
    const total = Object.values(rotationPositionMinuteRequirements).reduce((sum, value) => sum + value, 0);
    const profileKey = ["G", "F", "C"].map((position) => rotationPositionMinuteRequirements[position] ?? "").join(":");
    if (complete && total === 240 && ROTATION_ROLE_PROFILE_VALUES.has(profileKey)) {
      scenario.rotationPositionMinuteRequirements = rotationPositionMinuteRequirements;
    } else {
      warnings.push("Ignored on-court role minutes that do not match a supported rotation profile.");
    }
  }
  scenario.lockedIds = commaSeparatedIds(params.get("lock"), warnings, "locked");
  scenario.excludedIds = commaSeparatedIds(params.get("exclude"), warnings, "excluded");
  return { scenario, warnings };
}
