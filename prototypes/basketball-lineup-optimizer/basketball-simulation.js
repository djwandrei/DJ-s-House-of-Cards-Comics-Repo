/**
 * Deterministic Monte Carlo engine for future game and series products.
 *
 * The engine does not invent team projections. Callers must supply matchup
 * scoring rates, pace, variance, and a labeled model context. Every result
 * returns those assumptions and distinguishes model uncertainty from Monte
 * Carlo sampling error.
 */

export const BASKETBALL_SIMULATION_VERSION = "basketball-simulation-v1";

function finite(value, label) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    throw new TypeError(`${label} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be a finite number.`);
  return parsed;
}

function positive(value, label) {
  const parsed = finite(value, label);
  if (!(parsed > 0)) throw new RangeError(`${label} must be greater than zero.`);
  return parsed;
}

function nonNegative(value, label) {
  const parsed = finite(value, label);
  if (parsed < 0) throw new RangeError(`${label} must be non-negative.`);
  return parsed;
}

function integer(value, label, minimum, maximum) {
  const parsed = finite(value, label);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${label} must be a whole number from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function hashSeed(value) {
  const text = String(value ?? "lineup-lab");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomGenerator(seed) {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(random) {
  let first = 0;
  let second = 0;
  while (first <= Number.EPSILON) first = random();
  while (second <= Number.EPSILON) second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function distribution(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return {
    mean: round(mean, 3),
    standardDeviation: round(Math.sqrt(variance), 3),
    p10: round(quantile(sorted, 0.1), 2),
    p25: round(quantile(sorted, 0.25), 2),
    median: round(quantile(sorted, 0.5), 2),
    p75: round(quantile(sorted, 0.75), 2),
    p90: round(quantile(sorted, 0.9), 2),
  };
}

function wilsonInterval(successes, trials, z = 1.959963984540054) {
  const proportion = successes / trials;
  const denominator = 1 + ((z ** 2) / trials);
  const center = (proportion + ((z ** 2) / (2 * trials))) / denominator;
  const margin = (z / denominator) * Math.sqrt(
    (proportion * (1 - proportion) / trials) + ((z ** 2) / (4 * (trials ** 2))),
  );
  return { low: round(Math.max(0, center - margin), 4), high: round(Math.min(1, center + margin), 4) };
}

function normalizeModelContext(context) {
  const mode = String(context?.mode || "").trim().toLowerCase();
  if (!new Set(["validated", "exploratory"]).has(mode)) {
    throw new TypeError("modelContext.mode must be validated or exploratory.");
  }
  const modelVersion = String(context?.modelVersion || "").trim();
  if (!modelVersion) throw new TypeError("modelContext.modelVersion is required.");
  return {
    mode,
    modelVersion,
    calibrationScope: context?.calibrationScope ? String(context.calibrationScope) : null,
    source: context?.source ? String(context.source) : null,
    caveats: Array.isArray(context?.caveats) ? context.caveats.map(String) : [],
  };
}

function normalizeTeam(team, label) {
  const id = String(team?.id ?? "").trim();
  if (!id) throw new TypeError(`${label}.id is required.`);
  return {
    id,
    label: String(team?.label || team?.name || id),
    expectedPointsPer100: positive(team?.expectedPointsPer100, `${label}.expectedPointsPer100`),
  };
}

function normalizeGameInput(input, options = {}) {
  const home = normalizeTeam(input?.home, "home");
  const away = normalizeTeam(input?.away, "away");
  if (home.id === away.id) throw new TypeError("Home and away team IDs must differ.");
  const possessionsMean = positive(input?.possessions?.mean, "possessions.mean");
  const possessionsStandardDeviation = nonNegative(
    input?.possessions?.standardDeviation,
    "possessions.standardDeviation",
  );
  const scoreStandardDeviation = nonNegative(input?.scoreStandardDeviation, "scoreStandardDeviation");
  const scoreCorrelation = finite(input?.scoreCorrelation ?? 0, "scoreCorrelation");
  if (scoreCorrelation < -0.95 || scoreCorrelation > 0.95) {
    throw new RangeError("scoreCorrelation must be from -0.95 through 0.95.");
  }
  const possessionMinimum = positive(input?.possessions?.minimum ?? 40, "possessions.minimum");
  const possessionMaximum = positive(input?.possessions?.maximum ?? 130, "possessions.maximum");
  if (possessionMinimum >= possessionMaximum) throw new RangeError("Possession minimum must be below maximum.");
  if (possessionsMean < possessionMinimum || possessionsMean > possessionMaximum) {
    throw new RangeError("possessions.mean must be within the supplied possession minimum and maximum.");
  }
  const iterations = integer(options.iterations ?? input?.iterations ?? 10000, "iterations", 100, 100000);
  const seed = String(options.seed ?? input?.seed ?? "lineup-lab-simulation");
  return {
    home,
    away,
    possessions: {
      mean: possessionsMean,
      standardDeviation: possessionsStandardDeviation,
      minimum: possessionMinimum,
      maximum: possessionMaximum,
    },
    scoreStandardDeviation,
    scoreCorrelation,
    homeCourtPointsPer100: finite(input?.neutralSite === true ? 0 : input?.homeCourtPointsPer100 ?? 0, "homeCourtPointsPer100"),
    neutralSite: input?.neutralSite === true,
    modelContext: normalizeModelContext(input?.modelContext),
    iterations,
    seed,
  };
}

function drawGame(config, random) {
  const possessions = clamp(
    config.possessions.mean + normal(random) * config.possessions.standardDeviation,
    config.possessions.minimum,
    config.possessions.maximum,
  );
  const homeCourtHalf = config.homeCourtPointsPer100 / 2;
  const expectedHome = (config.home.expectedPointsPer100 + homeCourtHalf) * possessions / 100;
  const expectedAway = (config.away.expectedPointsPer100 - homeCourtHalf) * possessions / 100;
  const homeNoise = normal(random);
  const independentAwayNoise = normal(random);
  const awayNoise = config.scoreCorrelation * homeNoise
    + Math.sqrt(1 - (config.scoreCorrelation ** 2)) * independentAwayNoise;
  const deviation = config.scoreStandardDeviation * Math.sqrt(possessions / 100);
  let homeScore = Math.max(0, Math.round(expectedHome + deviation * homeNoise));
  let awayScore = Math.max(0, Math.round(expectedAway + deviation * awayNoise));
  let overtime = false;
  if (homeScore === awayScore) {
    overtime = true;
    const overtimeMargin = normal(random);
    if (overtimeMargin > 0 || (overtimeMargin === 0 && random() >= 0.5)) homeScore += Math.max(1, Math.round(Math.abs(overtimeMargin) * 3));
    else awayScore += Math.max(1, Math.round(Math.abs(overtimeMargin) * 3));
  }
  return { possessions, homeScore, awayScore, overtime };
}

function probabilityResult(wins, iterations) {
  const probability = wins / iterations;
  return {
    probability: round(probability, 4),
    monteCarloStandardError: round(Math.sqrt(probability * (1 - probability) / iterations), 5),
    confidenceInterval95: wilsonInterval(wins, iterations),
  };
}

function assumptions(config) {
  return {
    home: { ...config.home },
    away: { ...config.away },
    possessions: { ...config.possessions },
    scoreStandardDeviation: config.scoreStandardDeviation,
    scoreCorrelation: config.scoreCorrelation,
    homeCourtPointsPer100: config.homeCourtPointsPer100,
    neutralSite: config.neutralSite,
    modelContext: { ...config.modelContext },
  };
}

/** Simulate a single matchup distribution with reproducible seeded draws. */
export function simulateGame(input, options = {}) {
  const config = normalizeGameInput(input, options);
  const random = randomGenerator(config.seed);
  const homeScores = [];
  const awayScores = [];
  const margins = [];
  const possessions = [];
  let homeWins = 0;
  let overtimeGames = 0;
  for (let iteration = 0; iteration < config.iterations; iteration += 1) {
    const result = drawGame(config, random);
    homeScores.push(result.homeScore);
    awayScores.push(result.awayScore);
    margins.push(result.homeScore - result.awayScore);
    possessions.push(result.possessions);
    if (result.homeScore > result.awayScore) homeWins += 1;
    if (result.overtime) overtimeGames += 1;
  }
  return {
    version: BASKETBALL_SIMULATION_VERSION,
    kind: "game",
    seed: config.seed,
    iterations: config.iterations,
    assumptions: assumptions(config),
    results: {
      home: { id: config.home.id, ...probabilityResult(homeWins, config.iterations), score: distribution(homeScores) },
      away: { id: config.away.id, ...probabilityResult(config.iterations - homeWins, config.iterations), score: distribution(awayScores) },
      margin: distribution(margins),
      possessions: distribution(possessions),
      overtimeProbability: round(overtimeGames / config.iterations, 4),
    },
    interpretation: config.modelContext.mode === "validated"
      ? "Simulation sampling around caller-supplied validated matchup expectations."
      : "Exploratory what-if simulation; results are not validated forecasts.",
    caveats: [
      "The 95% interval measures Monte Carlo sampling error around these assumptions, not full model uncertainty.",
      "Rotations, injuries, fatigue, travel, foul trouble, coaching, and matchup effects must be incorporated into the supplied expectations before simulation.",
      ...config.modelContext.caveats,
    ],
  };
}

/**
 * Simulate a best-of series. `schedule` lists the home team for each possible
 * game using team A/B IDs; the simulation stops once `winsRequired` is reached.
 */
export function simulateSeries(input, options = {}) {
  const teamA = normalizeTeam(input?.teamA, "teamA");
  const teamB = normalizeTeam(input?.teamB, "teamB");
  if (teamA.id === teamB.id) throw new TypeError("Series team IDs must differ.");
  const winsRequired = integer(input?.winsRequired ?? 4, "winsRequired", 1, 8);
  const maximumGames = winsRequired * 2 - 1;
  const schedule = Array.isArray(input?.schedule) ? input.schedule.map(String) : [];
  if (schedule.length !== maximumGames || schedule.some((id) => id !== teamA.id && id !== teamB.id)) {
    throw new TypeError(`schedule must contain exactly ${maximumGames} home-team IDs drawn from teamA.id and teamB.id.`);
  }
  const baseInput = {
    possessions: input?.possessions,
    scoreStandardDeviation: input?.scoreStandardDeviation,
    scoreCorrelation: input?.scoreCorrelation,
    homeCourtPointsPer100: input?.homeCourtPointsPer100,
    modelContext: input?.modelContext,
  };
  const firstHomeIsA = schedule[0] === teamA.id;
  const template = normalizeGameInput({
    ...baseInput,
    home: firstHomeIsA ? teamA : teamB,
    away: firstHomeIsA ? teamB : teamA,
  }, options);
  const random = randomGenerator(template.seed);
  let teamAWinsSeries = 0;
  const lengthCounts = Object.fromEntries(Array.from({ length: maximumGames - winsRequired + 1 }, (_, index) => [winsRequired + index, 0]));
  const outcomeCounts = {};
  for (let iteration = 0; iteration < template.iterations; iteration += 1) {
    let winsA = 0;
    let winsB = 0;
    let games = 0;
    for (const homeId of schedule) {
      if (winsA >= winsRequired || winsB >= winsRequired) break;
      const homeIsA = homeId === teamA.id;
      const config = {
        ...template,
        home: homeIsA ? teamA : teamB,
        away: homeIsA ? teamB : teamA,
        neutralSite: false,
      };
      const result = drawGame(config, random);
      const homeWon = result.homeScore > result.awayScore;
      const teamAWon = homeIsA ? homeWon : !homeWon;
      if (teamAWon) winsA += 1;
      else winsB += 1;
      games += 1;
    }
    if (winsA > winsB) teamAWinsSeries += 1;
    lengthCounts[games] += 1;
    const key = `${winsA}-${winsB}`;
    outcomeCounts[key] = (outcomeCounts[key] || 0) + 1;
  }
  const teamAResult = probabilityResult(teamAWinsSeries, template.iterations);
  const teamBResult = probabilityResult(template.iterations - teamAWinsSeries, template.iterations);
  return {
    version: BASKETBALL_SIMULATION_VERSION,
    kind: "series",
    seed: template.seed,
    iterations: template.iterations,
    winsRequired,
    schedule,
    assumptions: {
      teamA: { ...teamA },
      teamB: { ...teamB },
      possessions: { ...template.possessions },
      scoreStandardDeviation: template.scoreStandardDeviation,
      scoreCorrelation: template.scoreCorrelation,
      homeCourtPointsPer100: template.homeCourtPointsPer100,
      modelContext: { ...template.modelContext },
    },
    results: {
      teamA: { id: teamA.id, ...teamAResult },
      teamB: { id: teamB.id, ...teamBResult },
      lengthProbabilities: Object.fromEntries(Object.entries(lengthCounts).map(([games, count]) => [games, round(count / template.iterations, 4)])),
      outcomeProbabilities: Object.fromEntries(Object.entries(outcomeCounts).sort().map(([outcome, count]) => [outcome, round(count / template.iterations, 4)])),
    },
    interpretation: template.modelContext.mode === "validated"
      ? "Series simulation sampling around caller-supplied validated matchup expectations."
      : "Exploratory what-if series; results are not validated forecasts.",
    caveats: [
      "Each game's supplied scoring expectations are held constant except for home court; game-to-game injuries, fatigue, and tactical adaptation are not invented.",
      "The 95% interval measures Monte Carlo sampling error, not full model uncertainty.",
      ...template.modelContext.caveats,
    ],
  };
}
