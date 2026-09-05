import crypto from 'node:crypto';

export const RAPM_MODEL_VERSION = 'weighted_ridge_rapm_v1';
export const RAPM_OFFENSE_DEFENSE_MODEL_VERSION = 'weighted_ridge_offense_defense_rapm_v2';
// This is intentionally a calibration-report version, not a new player-RAPM
// formulation. It lets downstream consumers distinguish a model with a
// reproducible held-out test from one that merely converged in sample.
export const RAPM_OFFENSE_DEFENSE_CALIBRATION_VERSION = 'game_fold_directional_ablation_v1';
export const RAPM_CHRONOLOGICAL_CALIBRATION_VERSION = 'chronological_latest_season_tune_test_v1';
export const DEFAULT_RAPM_LAMBDA_CANDIDATES = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
export const DEFAULT_RAPM_DISPLAY_POSSESSION_THRESHOLDS = Object.freeze([200, 500, 1000]);
const OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT = 2;
// Avoid labeling a floating-point rounding artifact as predictive improvement.
// This is a numerical tolerance (one part per billion of MSE), not a hidden
// quality threshold; the actual held-out improvement remains fully reported.
const CALIBRATION_MSE_NUMERIC_EPSILON = 1e-9;

function asFiniteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a finite number.`);
  return parsed;
}

function asNonNegativeInteger(value, name) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function normalizedGameId(value, index) {
  const gameId = String(value ?? '').trim();
  if (!gameId) throw new TypeError(`stint ${index} gameId cannot be blank.`);
  return gameId;
}

function normalizedPlayerIds(value, name) {
  if (!Array.isArray(value) || value.length !== 5) {
    throw new TypeError(`${name} must contain exactly five provider player IDs.`);
  }
  const ids = value.map((playerId) => String(playerId ?? '').trim());
  if (ids.some((playerId) => !playerId)) {
    throw new TypeError(`${name} cannot contain empty player IDs.`);
  }
  const sorted = [...ids].sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== 5) {
    throw new TypeError(`${name} cannot contain duplicate player IDs.`);
  }
  return sorted;
}

function compareObservation(left, right) {
  return [
    left.seasonStartYear ?? '',
    left.scheduledAt ?? '',
    left.gameId,
    String(left.stintOrdinal).padStart(12, '0'),
    left.homePlayerIds.join(','),
    left.awayPlayerIds.join(','),
    left.homePoints,
    left.awayPoints,
    left.homeOffensePoints,
    left.awayOffensePoints,
    left.homeOffensivePossessions,
    left.awayOffensivePossessions,
    left.sampleWeight,
  ].join('|').localeCompare([
    right.seasonStartYear ?? '',
    right.scheduledAt ?? '',
    right.gameId,
    String(right.stintOrdinal).padStart(12, '0'),
    right.homePlayerIds.join(','),
    right.awayPlayerIds.join(','),
    right.homePoints,
    right.awayPoints,
    right.homeOffensePoints,
    right.awayOffensePoints,
    right.homeOffensivePossessions,
    right.awayOffensivePossessions,
    right.sampleWeight,
  ].join('|'));
}

function normalizedStint(stint, index) {
  if (!stint || typeof stint !== 'object') throw new TypeError(`stint ${index} must be an object.`);
  const homePlayerIds = normalizedPlayerIds(stint.homePlayerIds ?? stint.homeLineupPlayerIds, `stint ${index} homePlayerIds`);
  const awayPlayerIds = normalizedPlayerIds(stint.awayPlayerIds ?? stint.awayLineupPlayerIds, `stint ${index} awayPlayerIds`);
  const allPlayers = [...homePlayerIds, ...awayPlayerIds];
  if (new Set(allPlayers).size !== 10) {
    throw new TypeError(`stint ${index} cannot put a provider player on both teams.`);
  }
  const homePoints = asNonNegativeInteger(stint.homePoints, `stint ${index} homePoints`);
  const awayPoints = asNonNegativeInteger(stint.awayPoints, `stint ${index} awayPoints`);
  const homeOffensePoints = asNonNegativeInteger(
    stint.homeOffensePoints ?? homePoints,
    `stint ${index} homeOffensePoints`
  );
  const awayOffensePoints = asNonNegativeInteger(
    stint.awayOffensePoints ?? awayPoints,
    `stint ${index} awayOffensePoints`
  );
  if (homeOffensePoints > homePoints || awayOffensePoints > awayPoints) {
    throw new RangeError(`stint ${index} possession-side offense points cannot exceed total scoreboard points.`);
  }
  const homeOffensivePossessions = asNonNegativeInteger(
    stint.homeOffensivePossessions ?? stint.homeOffPossessions,
    `stint ${index} homeOffensivePossessions`
  );
  const awayOffensivePossessions = asNonNegativeInteger(
    stint.awayOffensivePossessions ?? stint.awayOffPossessions,
    `stint ${index} awayOffensivePossessions`
  );
  const exposure = (homeOffensivePossessions + awayOffensivePossessions) / 2;
  if (!(exposure > 0)) throw new RangeError(`stint ${index} must have positive paired possession exposure.`);
  const sampleWeight = asFiniteNumber(stint.sampleWeight ?? 1, `stint ${index} sampleWeight`);
  if (!(sampleWeight > 0)) throw new RangeError(`stint ${index} sampleWeight must be greater than zero.`);
  const seasonStartYear = stint.seasonStartYear === null || stint.seasonStartYear === undefined
    ? null
    : Number(stint.seasonStartYear);
  if (seasonStartYear !== null && (!Number.isInteger(seasonStartYear) || seasonStartYear < 1947)) {
    throw new TypeError(`stint ${index} seasonStartYear must be a valid NBA season start year.`);
  }
  const scheduledAt = stint.scheduledAt === null || stint.scheduledAt === undefined
    ? null
    : String(stint.scheduledAt).trim();
  if (scheduledAt !== null && (!scheduledAt || !Number.isFinite(Date.parse(scheduledAt)))) {
    throw new TypeError(`stint ${index} scheduledAt must be a valid date-time string.`);
  }
  return {
    gameId: normalizedGameId(stint.gameId, index),
    stintOrdinal: Number.isInteger(stint.stintOrdinal) ? stint.stintOrdinal : index,
    seasonStartYear,
    scheduledAt,
    homePlayerIds,
    awayPlayerIds,
    homePoints,
    awayPoints,
    homeOffensePoints,
    awayOffensePoints,
    homeOffensivePossessions,
    awayOffensivePossessions,
    pairedPossessions: exposure,
    sampleWeight,
    weight: exposure * sampleWeight,
    response: (homePoints - awayPoints) / exposure,
  };
}

/**
 * Converts only already-validated, paired five-on-five stint rows into an
 * order-independent RAPM design. Invalid rows are excluded with an audit
 * reason instead of being imputed.
 */
export function buildRapmObservations(stints) {
  if (!Array.isArray(stints)) throw new TypeError('stints must be an array.');
  const observations = [];
  const excluded = [];
  for (let index = 0; index < stints.length; index += 1) {
    const stint = stints[index];
    if (stint?.eligible === false) {
      excluded.push({ index, gameId: String(stint.gameId ?? ''), reason: 'ineligible_source_stint' });
      continue;
    }
    try {
      observations.push(normalizedStint(stint, index));
    } catch (error) {
      excluded.push({ index, gameId: String(stint?.gameId ?? ''), reason: error.message });
    }
  }
  observations.sort(compareObservation);
  return { observations, excluded };
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function choleskySolve(matrix, vector) {
  const size = matrix.length;
  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let sum = matrix[row][column];
      for (let prior = 0; prior < column; prior += 1) sum -= lower[row][prior] * lower[column][prior];
      if (row === column) {
        if (!(sum > 1e-12)) {
          throw new RangeError('RAPM normal equation is not positive definite; use a positive ridge lambda.');
        }
        lower[row][column] = Math.sqrt(sum);
      } else {
        lower[row][column] = sum / lower[column][column];
      }
    }
  }
  const forward = Array(size).fill(0);
  for (let row = 0; row < size; row += 1) {
    let sum = vector[row];
    for (let column = 0; column < row; column += 1) sum -= lower[row][column] * forward[column];
    forward[row] = sum / lower[row][row];
  }
  const result = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = forward[row];
    for (let column = row + 1; column < size; column += 1) sum -= lower[column][row] * result[column];
    result[row] = sum / lower[row][row];
  }
  return result;
}

function observationPlayerIds(observations) {
  return [...new Set(observations.flatMap((observation) => [
    ...observation.homePlayerIds,
    ...observation.awayPlayerIds,
  ]))].sort((left, right) => left.localeCompare(right));
}

function normalizedLambdaCandidates(candidateLambdas) {
  if (!Array.isArray(candidateLambdas) || candidateLambdas.length === 0) {
    throw new TypeError('candidateLambdas must be a non-empty array.');
  }
  const normalized = candidateLambdas.map((value, index) => {
    const candidate = asFiniteNumber(value, `candidateLambdas[${index}]`);
    if (!(candidate > 0)) throw new RangeError(`candidateLambdas[${index}] must be greater than zero.`);
    return candidate;
  });
  return [...new Set(normalized)].sort((left, right) => left - right);
}

function normalizedFoldCount(foldCount) {
  const parsed = Number(foldCount);
  if (!Number.isInteger(parsed) || parsed < 2) {
    throw new TypeError('foldCount must be an integer greater than or equal to two.');
  }
  return parsed;
}

function normalizedDisplayThresholds(thresholds) {
  if (!Array.isArray(thresholds) || thresholds.length !== 3) {
    throw new TypeError('displayPossessionThresholds must contain exactly three thresholds.');
  }
  const normalized = thresholds.map((value, index) => {
    const threshold = asNonNegativeInteger(value, `displayPossessionThresholds[${index}]`);
    if (threshold === 0) throw new RangeError(`displayPossessionThresholds[${index}] must be greater than zero.`);
    return threshold;
  });
  if (!(normalized[0] < normalized[1] && normalized[1] < normalized[2])) {
    throw new RangeError('displayPossessionThresholds must be strictly increasing.');
  }
  return normalized;
}

function sampleSizeFields(exposure, totalExposure, lambda, thresholds) {
  let sampleSizeTier = 'established';
  if (exposure < thresholds[0]) sampleSizeTier = 'insufficient';
  else if (exposure < thresholds[1]) sampleSizeTier = 'limited';
  else if (exposure < thresholds[2]) sampleSizeTier = 'moderate';
  return {
    displayEligible: exposure >= thresholds[0],
    displayMinimumPairedPossessions: thresholds[0],
    sampleSizeTier,
    ridgeReliabilityProxy: exposure / (exposure + lambda),
    exposureShareOfAvailablePossessions: totalExposure > 0 ? exposure / totalExposure : null,
  };
}

function dotProduct(left, right) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += left[index] * right[index];
  return total;
}

/**
 * Matrix-free preconditioned conjugate-gradient solve for sparse weighted
 * ridge designs. It is used only by the additive tuning and offense/defense
 * APIs; the established net fit keeps its original Cholesky path.
 */
function solveSparseWeightedRidge(rows, dimension, lambda, {
  tolerance = 1e-10,
  maxIterations = Math.max(250, dimension * 4),
  unregularizedColumnCount = 1,
} = {}) {
  if (!rows.length) throw new RangeError('A ridge fit requires at least one observation.');
  if (!Number.isInteger(unregularizedColumnCount)
    || unregularizedColumnCount < 1
    || unregularizedColumnCount > dimension) {
    throw new RangeError('unregularizedColumnCount must be an integer between one and the design dimension.');
  }
  const normalVector = Array(dimension).fill(0);
  const diagonal = Array(dimension).fill(0);
  for (const row of rows) {
    for (const [index, value] of row.features) {
      normalVector[index] += row.weight * value * row.response;
      diagonal[index] += row.weight * value * value;
    }
  }
  for (let index = unregularizedColumnCount; index < dimension; index += 1) diagonal[index] += lambda;
  if (diagonal.some((value) => !(value > 0))) {
    throw new RangeError('Sparse ridge normal equation has an empty, unregularized dimension.');
  }

  const multiplyNormalMatrix = (vector) => {
    const result = Array(dimension).fill(0);
    for (const row of rows) {
      let prediction = 0;
      for (const [index, value] of row.features) prediction += value * vector[index];
      const weightedPrediction = row.weight * prediction;
      for (const [index, value] of row.features) result[index] += value * weightedPrediction;
    }
    for (let index = unregularizedColumnCount; index < dimension; index += 1) result[index] += lambda * vector[index];
    return result;
  };

  const coefficients = Array(dimension).fill(0);
  let residual = [...normalVector];
  let preconditionedResidual = residual.map((value, index) => value / diagonal[index]);
  let direction = [...preconditionedResidual];
  let residualDotPreconditioned = dotProduct(residual, preconditionedResidual);
  const targetResidualNorm = tolerance * Math.max(1, Math.sqrt(dotProduct(normalVector, normalVector)));
  let residualNorm = Math.sqrt(dotProduct(residual, residual));
  let iterationCount = 0;

  while (residualNorm > targetResidualNorm && iterationCount < maxIterations) {
    const normalDirection = multiplyNormalMatrix(direction);
    const curvature = dotProduct(direction, normalDirection);
    if (!(curvature > 0)) throw new RangeError('Sparse ridge solver encountered non-positive curvature.');
    const step = residualDotPreconditioned / curvature;
    for (let index = 0; index < dimension; index += 1) {
      coefficients[index] += step * direction[index];
      residual[index] -= step * normalDirection[index];
    }
    residualNorm = Math.sqrt(dotProduct(residual, residual));
    iterationCount += 1;
    if (residualNorm <= targetResidualNorm) break;
    preconditionedResidual = residual.map((value, index) => value / diagonal[index]);
    const nextResidualDotPreconditioned = dotProduct(residual, preconditionedResidual);
    const directionScale = nextResidualDotPreconditioned / residualDotPreconditioned;
    for (let index = 0; index < dimension; index += 1) {
      direction[index] = preconditionedResidual[index] + directionScale * direction[index];
    }
    residualDotPreconditioned = nextResidualDotPreconditioned;
  }

  return {
    coefficients,
    converged: residualNorm <= targetResidualNorm,
    iterationCount,
    residualNorm,
    targetResidualNorm,
  };
}

function netDesignRows(observations, playerIds) {
  const playerIndex = new Map(playerIds.map((playerId, index) => [playerId, index + 1]));
  return observations.map((observation) => ({
    gameId: observation.gameId,
    rawWeight: observation.pairedPossessions,
    weight: observation.weight,
    response: observation.response,
    features: [
      [0, 1],
      ...observation.homePlayerIds.map((playerId) => [playerIndex.get(playerId), 1]),
      ...observation.awayPlayerIds.map((playerId) => [playerIndex.get(playerId), -1]),
    ],
  }));
}

function offenseDefenseDesignRows(observations, playerIds) {
  const playerOffset = new Map(playerIds.map((playerId, index) => [playerId, index]));
  const offenseStart = OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT;
  const defenseStart = playerIds.length + offenseStart;
  const rows = [];
  const skippedDirections = [];
  const addDirection = (observation, side, points, possessions, offensePlayerIds, defensePlayerIds) => {
    if (possessions === 0) {
      skippedDirections.push({
        gameId: observation.gameId,
        stintOrdinal: observation.stintOrdinal,
        side,
        points,
        reason: points > 0 ? 'points_without_offensive_possession' : 'zero_offensive_possessions',
      });
      return;
    }
    rows.push({
      gameId: observation.gameId,
      side,
      rawWeight: possessions,
      weight: possessions * observation.sampleWeight,
      response: points / possessions,
      // Preserve the two lineup sides explicitly for calibration. The sparse
      // feature list remains the fitting source of truth, while these bounded
      // five-player arrays make offense/defense ablations auditable without
      // reverse-engineering column offsets from a held-out fold.
      offensePlayerIds,
      defensePlayerIds,
      features: [
        [0, 1],
        [1, side === 'home' ? 1 : -1],
        ...offensePlayerIds.map((playerId) => [playerOffset.get(playerId) + offenseStart, 1]),
        ...defensePlayerIds.map((playerId) => [defenseStart + playerOffset.get(playerId), -1]),
      ],
    });
  };
  for (const observation of observations) {
    addDirection(
      observation,
      'home',
      observation.homeOffensePoints,
      observation.homeOffensivePossessions,
      observation.homePlayerIds,
      observation.awayPlayerIds
    );
    addDirection(
      observation,
      'away',
      observation.awayOffensePoints,
      observation.awayOffensivePossessions,
      observation.awayPlayerIds,
      observation.homePlayerIds
    );
  }
  return { rows, skippedDirections };
}

function assertSignedHomeCourtRows(rows, context) {
  const hasHomeDirection = rows.some((row) => row.side === 'home');
  const hasAwayDirection = rows.some((row) => row.side === 'away');
  if (!hasHomeDirection || !hasAwayDirection) {
    throw new RangeError(
      `${context} requires at least one positive-possession home direction and one positive-possession away direction to identify the signed home-court effect.`
    );
  }
}

/**
 * Assign complete games to deterministic round-robin folds. Keeping all of a
 * game's stints together prevents the model from learning a lineup from one
 * possession and "predicting" another possession from the very same game.
 */
function buildDeterministicGameFoldPlan(rows, foldCount) {
  const requestedFoldCount = normalizedFoldCount(foldCount);
  const gameIds = [...new Set(rows.map((row) => row.gameId))]
    .sort((left, right) => left.localeCompare(right));
  if (gameIds.length < 2) throw new RangeError('Calibration requires at least two distinct games.');
  const actualFoldCount = Math.min(requestedFoldCount, gameIds.length);
  const foldByGameId = new Map(gameIds.map((gameId, index) => [gameId, index % actualFoldCount]));
  const folds = Array.from({ length: actualFoldCount }, (_, foldIndex) => ({
    foldIndex,
    gameIds: gameIds.filter((gameId) => foldByGameId.get(gameId) === foldIndex),
  }));
  return {
    requestedFoldCount,
    actualFoldCount,
    gameIds,
    foldByGameId,
    folds,
  };
}

function emptyPredictionMetrics() {
  return {
    weightedSquaredError: 0,
    weightedAbsoluteError: 0,
    weightedPredictedMinusObserved: 0,
    weight: 0,
    directionalObservationCount: 0,
  };
}

function addPredictionMetrics(metrics, row, prediction) {
  if (!Number.isFinite(prediction)) throw new RangeError('Calibration produced a non-finite held-out prediction.');
  const error = row.response - prediction;
  metrics.weightedSquaredError += row.weight * error * error;
  metrics.weightedAbsoluteError += row.weight * Math.abs(error);
  metrics.weightedPredictedMinusObserved += row.weight * (prediction - row.response);
  metrics.weight += row.weight;
  metrics.directionalObservationCount += 1;
}

function finalizedPredictionMetrics(metrics) {
  if (!(metrics.weight > 0)) throw new RangeError('Calibration has no held-out offensive possessions.');
  const weightedMse = metrics.weightedSquaredError / metrics.weight;
  return {
    weightedMse,
    weightedRmsePer100: 100 * Math.sqrt(weightedMse),
    weightedMaePer100: 100 * (metrics.weightedAbsoluteError / metrics.weight),
    weightedBiasPredictedMinusObservedPer100: 100 * (metrics.weightedPredictedMinusObserved / metrics.weight),
    heldOutPossessions: metrics.weight,
    directionalObservationCount: metrics.directionalObservationCount,
  };
}

function mseImprovement(reference, candidate) {
  if (!(reference?.weightedMse > 0) || !Number.isFinite(candidate?.weightedMse)) return null;
  return (reference.weightedMse - candidate.weightedMse) / reference.weightedMse;
}

/**
 * Fit only the fixed neutral-venue and signed-home-court terms on a training
 * fold. This is the appropriate low-information comparison for the full RAPM
 * model: it knows the scoring environment and location, but nothing about the
 * ten players on the floor.
 */
function fitVenueOnlyBaseline(rows, { tolerance, maxIterations } = {}) {
  assertSignedHomeCourtRows(rows, 'Venue baseline');
  const venueRows = rows.map((row) => ({
    gameId: row.gameId,
    side: row.side,
    weight: row.weight,
    response: row.response,
    features: [[0, 1], [1, row.side === 'home' ? 1 : -1]],
  }));
  const solved = solveSparseWeightedRidge(venueRows, OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT, 0, {
    tolerance,
    maxIterations,
    unregularizedColumnCount: OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT,
  });
  if (!solved.converged) throw new RangeError('Venue-only calibration baseline did not converge.');
  return {
    baselinePerPossession: solved.coefficients[0],
    homeCourtEffectPerPossession: solved.coefficients[1],
    solver: solved,
  };
}

function observationToStint(observation) {
  return {
    gameId: observation.gameId,
    stintOrdinal: observation.stintOrdinal,
    seasonStartYear: observation.seasonStartYear,
    scheduledAt: observation.scheduledAt,
    sampleWeight: observation.sampleWeight,
    homePlayerIds: observation.homePlayerIds,
    awayPlayerIds: observation.awayPlayerIds,
    homePoints: observation.homePoints,
    awayPoints: observation.awayPoints,
    homeOffensePoints: observation.homeOffensePoints,
    awayOffensePoints: observation.awayOffensePoints,
    homeOffensivePossessions: observation.homeOffensivePossessions,
    awayOffensivePossessions: observation.awayOffensivePossessions,
  };
}

function heldOutPlayerEffects(row, playersById) {
  let offensePerPossession = 0;
  let defensePerPossession = 0;
  const unseenPlayerIds = new Set();
  for (const playerId of row.offensePlayerIds) {
    const player = playersById.get(playerId);
    if (!player) {
      // Zero is the explicit ridge prior for an unseen player, not a claim
      // that the player is average. We record its possession share below so
      // calibration cannot hide a large out-of-fold identity gap.
      unseenPlayerIds.add(playerId);
      continue;
    }
    offensePerPossession += Number(player.offensiveRapmPer100) / 100;
  }
  for (const playerId of row.defensePlayerIds) {
    const player = playersById.get(playerId);
    if (!player) {
      unseenPlayerIds.add(playerId);
      continue;
    }
    defensePerPossession += Number(player.defensiveRapmPer100) / 100;
  }
  return { offensePerPossession, defensePerPossession, unseenPlayerIds };
}

/**
 * Evaluate a fixed-lambda offense/defense RAPM model on held-out *games*.
 *
 * The full model is compared with (1) a venue-only scoring baseline and (2)
 * directional ablations that remove only the offense or defense player terms.
 * The latter two comparisons are the honest way to ask whether each component
 * adds predictive information conditional on the other component; individual
 * offense and defense coefficients do not have a directly observable
 * counterfactual target on a single possession.
 */
export function evaluateOffenseDefenseRapmCalibration(stints, {
  lambda = 100,
  foldCount = 5,
  solverTolerance = 1e-10,
  solverMaxIterations = null,
} = {}) {
  if (lambda === 'auto') {
    throw new TypeError('Calibration requires the already-selected numeric lambda so held-out scores do not silently reuse tuning data.');
  }
  const ridgeLambda = asFiniteNumber(lambda, 'lambda');
  if (!(ridgeLambda > 0)) throw new RangeError('lambda must be greater than zero.');
  const tolerance = asFiniteNumber(solverTolerance, 'solverTolerance');
  if (!(tolerance > 0)) throw new RangeError('solverTolerance must be greater than zero.');
  let maxIterations;
  if (solverMaxIterations !== null && solverMaxIterations !== undefined) {
    maxIterations = Number(solverMaxIterations);
    if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
      throw new TypeError('solverMaxIterations must be a positive integer when provided.');
    }
  }

  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for calibration.');
  const playerIds = observationPlayerIds(observations);
  const { rows, skippedDirections } = offenseDefenseDesignRows(observations, playerIds);
  if (!rows.length) throw new RangeError('No positive offensive-possession observations are available for calibration.');
  assertSignedHomeCourtRows(rows, 'Offense/defense calibration');
  const foldPlan = buildDeterministicGameFoldPlan(rows, foldCount);
  const fullModelMetrics = emptyPredictionMetrics();
  const venueBaselineMetrics = emptyPredictionMetrics();
  const withoutOffensePlayerEffectsMetrics = emptyPredictionMetrics();
  const withoutDefensePlayerEffectsMetrics = emptyPredictionMetrics();
  let unseenPlayerDirectionPossessions = 0;
  let unseenPlayerDirectionCount = 0;

  for (let foldIndex = 0; foldIndex < foldPlan.actualFoldCount; foldIndex += 1) {
    const trainingObservations = observations.filter(
      (observation) => foldPlan.foldByGameId.get(observation.gameId) !== foldIndex,
    );
    const heldOutObservations = observations.filter(
      (observation) => foldPlan.foldByGameId.get(observation.gameId) === foldIndex,
    );
    const trainingPlayerIds = observationPlayerIds(trainingObservations);
    const { rows: trainingRows } = offenseDefenseDesignRows(trainingObservations, trainingPlayerIds);
    assertSignedHomeCourtRows(trainingRows, `Calibration training fold ${foldIndex}`);
    const heldOutRows = offenseDefenseDesignRows(heldOutObservations, playerIds).rows;
    const fitted = fitWeightedRidgeOffenseDefenseRapm(
      trainingObservations.map(observationToStint),
      {
        lambda: ridgeLambda,
        solverTolerance: tolerance,
        solverMaxIterations: maxIterations ?? null,
      },
    );
    const venueBaseline = fitVenueOnlyBaseline(trainingRows, {
      tolerance,
      maxIterations: maxIterations ?? undefined,
    });
    const playersById = new Map(fitted.players.map((player) => [player.providerPlayerId, player]));
    for (const row of heldOutRows) {
      const venueSign = row.side === 'home' ? 1 : -1;
      const fittedVenuePrediction = (fitted.baselineOffensiveRatingPer100
        + (venueSign * fitted.homeCourtEffectPer100)) / 100;
      const baselinePrediction = venueBaseline.baselinePerPossession
        + (venueSign * venueBaseline.homeCourtEffectPerPossession);
      const effects = heldOutPlayerEffects(row, playersById);
      const fullPrediction = fittedVenuePrediction
        + effects.offensePerPossession
        - effects.defensePerPossession;
      const withoutOffensePlayerEffectsPrediction = fittedVenuePrediction - effects.defensePerPossession;
      const withoutDefensePlayerEffectsPrediction = fittedVenuePrediction + effects.offensePerPossession;
      addPredictionMetrics(fullModelMetrics, row, fullPrediction);
      addPredictionMetrics(venueBaselineMetrics, row, baselinePrediction);
      addPredictionMetrics(withoutOffensePlayerEffectsMetrics, row, withoutOffensePlayerEffectsPrediction);
      addPredictionMetrics(withoutDefensePlayerEffectsMetrics, row, withoutDefensePlayerEffectsPrediction);
      if (effects.unseenPlayerIds.size > 0) {
        unseenPlayerDirectionPossessions += row.weight;
        unseenPlayerDirectionCount += 1;
      }
    }
  }

  const fullModel = finalizedPredictionMetrics(fullModelMetrics);
  const venueBaseline = finalizedPredictionMetrics(venueBaselineMetrics);
  const withoutOffensePlayerEffects = finalizedPredictionMetrics(withoutOffensePlayerEffectsMetrics);
  const withoutDefensePlayerEffects = finalizedPredictionMetrics(withoutDefensePlayerEffectsMetrics);
  const fullModelMseImprovementVsVenueBaseline = mseImprovement(venueBaseline, fullModel);
  const offenseComponentMseImprovementVsWithoutOffense = mseImprovement(withoutOffensePlayerEffects, fullModel);
  const defenseComponentMseImprovementVsWithoutDefense = mseImprovement(withoutDefensePlayerEffects, fullModel);
  // `>= 0` is intentional for the two ablations: an exactly neutral component
  // does not make a previously validated full model worse. The full model must
  // still beat the low-information venue baseline by a strictly positive amount.
  const fullModelImprovesBaseline = fullModelMseImprovementVsVenueBaseline !== null
    && fullModelMseImprovementVsVenueBaseline > CALIBRATION_MSE_NUMERIC_EPSILON;
  const offenseComponentDoesNotDegrade = offenseComponentMseImprovementVsWithoutOffense !== null
    && offenseComponentMseImprovementVsWithoutOffense >= -CALIBRATION_MSE_NUMERIC_EPSILON;
  const defenseComponentDoesNotDegrade = defenseComponentMseImprovementVsWithoutDefense !== null
    && defenseComponentMseImprovementVsWithoutDefense >= -CALIBRATION_MSE_NUMERIC_EPSILON;
  const allComponentsImproved = fullModelImprovesBaseline
    && offenseComponentDoesNotDegrade
    && defenseComponentDoesNotDegrade;

  return {
    version: RAPM_OFFENSE_DEFENSE_CALIBRATION_VERSION,
    status: allComponentsImproved ? 'validated' : 'not_validated',
    method: 'deterministic_sorted_game_round_robin_fixed_lambda_weighted_out_of_fold_v1',
    fixedLambda: ridgeLambda,
    requestedFoldCount: foldPlan.requestedFoldCount,
    foldCount: foldPlan.actualFoldCount,
    gameCount: foldPlan.gameIds.length,
    directionalObservationCount: rows.length,
    heldOutPossessions: fullModel.heldOutPossessions,
    fullModel,
    venueBaseline,
    withoutOffensePlayerEffects,
    withoutDefensePlayerEffects,
    fullModelMseImprovementVsVenueBaseline,
    offenseComponentMseImprovementVsWithoutOffense,
    defenseComponentMseImprovementVsWithoutDefense,
    fullModelImprovesBaseline,
    offenseComponentDoesNotDegrade,
    defenseComponentDoesNotDegrade,
    allComponentsImproved,
    unseenPlayerDirectionPossessions,
    unseenPlayerDirectionCount,
    unseenPlayerPossessionShare: fullModel.heldOutPossessions > 0
      ? unseenPlayerDirectionPossessions / fullModel.heldOutPossessions
      : null,
    inputSha256: sha256Json({
      version: RAPM_OFFENSE_DEFENSE_CALIBRATION_VERSION,
      lambda: ridgeLambda,
      requestedFoldCount: foldPlan.requestedFoldCount,
      folds: foldPlan.folds,
      rows: rows.map((row) => ({
        gameId: row.gameId,
        side: row.side,
        weight: row.weight,
        response: row.response,
        offensePlayerIds: row.offensePlayerIds,
        defensePlayerIds: row.defensePlayerIds,
      })),
    }),
    caveat: 'Fixed-lambda, held-out game folds evaluate predictive scoring error, not causal player attribution. Players absent from a training fold use the explicit zero-effect ridge prior; their held-out possession share is reported.',
    excludedStintCount: excluded.length,
    skippedDirectionalObservationCount: skippedDirections.length,
  };
}

function normalizedPriorSeasonWeightCandidates(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('priorSeasonWeightCandidates must be a non-empty array.');
  }
  const normalized = values.map((value, index) => {
    const candidate = asFiniteNumber(value, `priorSeasonWeightCandidates[${index}]`);
    if (candidate < 0 || candidate > 1) {
      throw new RangeError(`priorSeasonWeightCandidates[${index}] must be between zero and one.`);
    }
    return candidate;
  });
  return [...new Set(normalized)].sort((left, right) => left - right);
}

function normalizedChronologicalFraction(value, name) {
  const fraction = asFiniteNumber(value, name);
  if (!(fraction > 0 && fraction < 0.5)) {
    throw new RangeError(`${name} must be greater than zero and less than 0.5.`);
  }
  return fraction;
}

function chronologicalGamePlan(observations, latestSeasonStartYear, tuningGameFraction, testGameFraction) {
  const gameMetadata = new Map();
  for (const observation of observations) {
    if (!Number.isInteger(observation.seasonStartYear)) {
      throw new TypeError('Chronological calibration requires seasonStartYear on every stint.');
    }
    if (!observation.scheduledAt) {
      throw new TypeError('Chronological calibration requires scheduledAt on every stint.');
    }
    if (observation.seasonStartYear > latestSeasonStartYear) {
      throw new RangeError('Chronological calibration input contains a season after latestSeasonStartYear.');
    }
    const scheduledAt = new Date(observation.scheduledAt).toISOString();
    const existing = gameMetadata.get(observation.gameId);
    if (existing && (existing.seasonStartYear !== observation.seasonStartYear || existing.scheduledAt !== scheduledAt)) {
      throw new RangeError(`Game ${observation.gameId} has inconsistent chronological metadata.`);
    }
    gameMetadata.set(observation.gameId, {
      gameId: observation.gameId,
      seasonStartYear: observation.seasonStartYear,
      scheduledAt,
    });
  }
  const priorGames = [...gameMetadata.values()]
    .filter((game) => game.seasonStartYear < latestSeasonStartYear)
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.gameId.localeCompare(right.gameId));
  if (!priorGames.length) throw new RangeError('Chronological multiseason calibration requires at least one prior-season game.');
  const latestGames = [...gameMetadata.values()]
    .filter((game) => game.seasonStartYear === latestSeasonStartYear)
    .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt) || left.gameId.localeCompare(right.gameId));
  if (latestGames.length < 3) {
    throw new RangeError('Chronological calibration requires at least three latest-season games.');
  }
  const tuningGameCount = Math.max(1, Math.floor(latestGames.length * tuningGameFraction));
  const testGameCount = Math.max(1, Math.floor(latestGames.length * testGameFraction));
  const trainingGameCount = latestGames.length - tuningGameCount - testGameCount;
  if (trainingGameCount < 1) {
    throw new RangeError('Chronological calibration fractions leave no latest-season training games.');
  }
  const latestTrainingGames = latestGames.slice(0, trainingGameCount);
  const tuningGames = latestGames.slice(trainingGameCount, trainingGameCount + tuningGameCount);
  const testGames = latestGames.slice(trainingGameCount + tuningGameCount);
  return {
    gameMetadata,
    priorGames,
    latestGames,
    latestTrainingGames,
    tuningGames,
    testGames,
    baseTrainingGameIds: new Set([...priorGames, ...latestTrainingGames].map((game) => game.gameId)),
    refitTrainingGameIds: new Set([...priorGames, ...latestTrainingGames, ...tuningGames].map((game) => game.gameId)),
    tuningGameIds: new Set(tuningGames.map((game) => game.gameId)),
    testGameIds: new Set(testGames.map((game) => game.gameId)),
  };
}

function observationsForGames(observations, gameIds) {
  return observations.filter((observation) => gameIds.has(observation.gameId));
}

function applyPriorSeasonDecay(observations, latestSeasonStartYear, priorSeasonWeight) {
  const weighted = [];
  for (const observation of observations) {
    const age = latestSeasonStartYear - observation.seasonStartYear;
    const sampleWeight = age === 0 ? 1 : priorSeasonWeight ** age;
    if (!(sampleWeight > 0)) continue;
    weighted.push({
      ...observation,
      sampleWeight,
      weight: observation.pairedPossessions * sampleWeight,
    });
  }
  return weighted;
}

function fitChronologicalCandidate(observations, model, lambda, { tolerance, maxIterations }) {
  if (!observations.length) throw new RangeError('Chronological candidate has no training observations.');
  const playerIds = observationPlayerIds(observations);
  let rows;
  let dimension;
  let unregularizedColumnCount;
  if (model === 'net') {
    rows = netDesignRows(observations, playerIds);
    dimension = playerIds.length + 1;
    unregularizedColumnCount = 1;
  } else {
    rows = offenseDefenseDesignRows(observations, playerIds).rows;
    assertSignedHomeCourtRows(rows, 'Chronological offense/defense training');
    dimension = playerIds.length * 2 + OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT;
    unregularizedColumnCount = OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT;
  }
  const solved = solveSparseWeightedRidge(rows, dimension, lambda, {
    tolerance,
    maxIterations,
    unregularizedColumnCount,
  });
  if (!solved.converged) {
    throw new RangeError(`Chronological ${model} candidate did not converge after ${solved.iterationCount} iterations.`);
  }
  let baseline;
  if (model === 'net') {
    const totalWeight = rows.reduce((total, row) => total + row.weight, 0);
    baseline = {
      interceptPerPossession: rows.reduce(
        (total, row) => total + row.weight * row.response,
        0,
      ) / totalWeight,
    };
  } else {
    baseline = fitVenueOnlyBaseline(rows, { tolerance, maxIterations });
  }
  return {
    model,
    playerIds,
    playerIndex: new Map(playerIds.map((playerId, index) => [playerId, index])),
    coefficients: solved.coefficients,
    baseline,
    solver: {
      converged: solved.converged,
      iterationCount: solved.iterationCount,
      residualNorm: solved.residualNorm,
      targetResidualNorm: solved.targetResidualNorm,
    },
  };
}

function evaluateChronologicalCandidate(fitted, heldOutObservations) {
  const fullMetrics = emptyPredictionMetrics();
  const baselineMetrics = emptyPredictionMetrics();
  let unseenPlayerPossessions = 0;
  let unseenObservationCount = 0;
  const recordUnseen = (playerIds, weight) => {
    if (playerIds.some((playerId) => !fitted.playerIndex.has(playerId))) {
      unseenPlayerPossessions += weight;
      unseenObservationCount += 1;
    }
  };
  if (fitted.model === 'net') {
    for (const observation of heldOutObservations) {
      let prediction = fitted.coefficients[0];
      for (const playerId of observation.homePlayerIds) {
        const offset = fitted.playerIndex.get(playerId);
        if (offset !== undefined) prediction += fitted.coefficients[offset + 1];
      }
      for (const playerId of observation.awayPlayerIds) {
        const offset = fitted.playerIndex.get(playerId);
        if (offset !== undefined) prediction -= fitted.coefficients[offset + 1];
      }
      const row = { response: observation.response, weight: observation.pairedPossessions };
      addPredictionMetrics(fullMetrics, row, prediction);
      addPredictionMetrics(baselineMetrics, row, fitted.baseline.interceptPerPossession);
      recordUnseen([...observation.homePlayerIds, ...observation.awayPlayerIds], row.weight);
    }
  } else {
    const heldOutRows = offenseDefenseDesignRows(
      heldOutObservations.map((observation) => ({ ...observation, sampleWeight: 1 })),
      observationPlayerIds(heldOutObservations),
    ).rows;
    const offenseStart = OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT;
    const defenseStart = fitted.playerIds.length + offenseStart;
    for (const row of heldOutRows) {
      const venueSign = row.side === 'home' ? 1 : -1;
      let prediction = fitted.coefficients[0] + venueSign * fitted.coefficients[1];
      for (const playerId of row.offensePlayerIds) {
        const offset = fitted.playerIndex.get(playerId);
        if (offset !== undefined) prediction += fitted.coefficients[offenseStart + offset];
      }
      for (const playerId of row.defensePlayerIds) {
        const offset = fitted.playerIndex.get(playerId);
        if (offset !== undefined) prediction -= fitted.coefficients[defenseStart + offset];
      }
      const baselinePrediction = fitted.baseline.baselinePerPossession
        + venueSign * fitted.baseline.homeCourtEffectPerPossession;
      addPredictionMetrics(fullMetrics, row, prediction);
      addPredictionMetrics(baselineMetrics, row, baselinePrediction);
      recordUnseen([...row.offensePlayerIds, ...row.defensePlayerIds], row.weight);
    }
  }
  const fullModel = finalizedPredictionMetrics(fullMetrics);
  const fixedEffectsBaseline = finalizedPredictionMetrics(baselineMetrics);
  const improvement = mseImprovement(fixedEffectsBaseline, fullModel);
  return {
    status: improvement !== null && improvement > CALIBRATION_MSE_NUMERIC_EPSILON
      ? 'validated'
      : 'not_validated',
    fullModel,
    fixedEffectsBaseline,
    fullModelMseImprovementVsFixedEffectsBaseline: improvement,
    fullModelImprovesBaseline: improvement !== null && improvement > CALIBRATION_MSE_NUMERIC_EPSILON,
    unseenPlayerPossessions,
    unseenObservationCount,
    unseenPlayerPossessionShare: fullModel.heldOutPossessions > 0
      ? unseenPlayerPossessions / fullModel.heldOutPossessions
      : null,
  };
}

function chronologicalSplitSummary(games) {
  if (!games.length) return { gameCount: 0, firstScheduledAt: null, lastScheduledAt: null };
  return {
    gameCount: games.length,
    firstScheduledAt: games[0].scheduledAt,
    lastScheduledAt: games[games.length - 1].scheduledAt,
  };
}

/**
 * Select a prior-season decay weight and ridge penalty without leaking future
 * latest-season games into tuning. Earlier seasons and the first chronological
 * block of the latest season train every candidate; the next block selects the
 * hyperparameters, and the final block is touched once for an honest test.
 */
export function selectChronologicalRapmHyperparameters(stints, {
  model = 'net',
  latestSeasonStartYear,
  priorSeasonWeightCandidates = [0, 0.25, 0.5, 0.75, 1],
  lambdaCandidates = DEFAULT_RAPM_LAMBDA_CANDIDATES,
  tuningGameFraction = 0.2,
  testGameFraction = 0.2,
  solverTolerance = 1e-10,
  solverMaxIterations = null,
} = {}) {
  if (!['net', 'offenseDefense'].includes(model)) {
    throw new TypeError('model must be net or offenseDefense.');
  }
  const latestSeason = Number(latestSeasonStartYear);
  if (!Number.isInteger(latestSeason) || latestSeason < 1947) {
    throw new TypeError('latestSeasonStartYear must be a valid NBA season start year.');
  }
  const weights = normalizedPriorSeasonWeightCandidates(priorSeasonWeightCandidates);
  const lambdas = normalizedLambdaCandidates(lambdaCandidates);
  const tuningFraction = normalizedChronologicalFraction(tuningGameFraction, 'tuningGameFraction');
  const testFraction = normalizedChronologicalFraction(testGameFraction, 'testGameFraction');
  if (tuningFraction + testFraction >= 1) {
    throw new RangeError('tuningGameFraction plus testGameFraction must be less than one.');
  }
  const tolerance = asFiniteNumber(solverTolerance, 'solverTolerance');
  if (!(tolerance > 0)) throw new RangeError('solverTolerance must be greater than zero.');
  let maxIterations;
  if (solverMaxIterations !== null && solverMaxIterations !== undefined) {
    maxIterations = Number(solverMaxIterations);
    if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
      throw new TypeError('solverMaxIterations must be a positive integer when provided.');
    }
  }

  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for chronological calibration.');
  const plan = chronologicalGamePlan(observations, latestSeason, tuningFraction, testFraction);
  const baseTraining = observationsForGames(observations, plan.baseTrainingGameIds);
  const tuning = observationsForGames(observations, plan.tuningGameIds);
  const refitTraining = observationsForGames(observations, plan.refitTrainingGameIds);
  const test = observationsForGames(observations, plan.testGameIds);
  const candidates = [];

  for (const priorSeasonWeight of weights) {
    const weightedTraining = applyPriorSeasonDecay(baseTraining, latestSeason, priorSeasonWeight);
    for (const lambda of lambdas) {
      try {
        const fitted = fitChronologicalCandidate(weightedTraining, model, lambda, { tolerance, maxIterations });
        const evaluation = evaluateChronologicalCandidate(fitted, tuning);
        candidates.push({
          priorSeasonWeight,
          lambda,
          fitStatus: 'scored',
          trainingObservationCount: weightedTraining.length,
          trainingPlayerCount: fitted.playerIds.length,
          solver: fitted.solver,
          ...evaluation,
        });
      } catch (error) {
        candidates.push({
          priorSeasonWeight,
          lambda,
          fitStatus: 'failed',
          error: String(error?.message ?? error),
        });
      }
    }
  }
  const scored = candidates.filter((candidate) => candidate.fitStatus === 'scored');
  if (!scored.length) {
    const failureSummary = [...new Set(candidates.map((candidate) => candidate.error))]
      .slice(0, 3)
      .join(' | ');
    throw new RangeError(`Every chronological ${model} candidate failed: ${failureSummary}`);
  }
  scored.sort((left, right) => (
    left.fullModel.weightedMse - right.fullModel.weightedMse
      || left.priorSeasonWeight - right.priorSeasonWeight
      || left.lambda - right.lambda
  ));
  const winner = scored[0];
  const weightedRefitTraining = applyPriorSeasonDecay(
    refitTraining,
    latestSeason,
    winner.priorSeasonWeight,
  );
  const refit = fitChronologicalCandidate(weightedRefitTraining, model, winner.lambda, {
    tolerance,
    maxIterations,
  });
  const testEvaluation = evaluateChronologicalCandidate(refit, test);
  const split = {
    priorSeasonsTraining: chronologicalSplitSummary(plan.priorGames),
    latestSeasonTraining: chronologicalSplitSummary(plan.latestTrainingGames),
    latestSeasonTuning: chronologicalSplitSummary(plan.tuningGames),
    latestSeasonTest: chronologicalSplitSummary(plan.testGames),
  };
  return {
    version: RAPM_CHRONOLOGICAL_CALIBRATION_VERSION,
    model,
    latestSeasonStartYear: latestSeason,
    method: 'prior_seasons_plus_chronological_latest_season_train_tune_test_v1',
    priorSeasonWeightDefinition: 'latest season weight is 1; each season-age step is multiplied by the selected prior-season weight; zero excludes all prior seasons from the RAPM fit',
    tuningGameFraction: tuningFraction,
    testGameFraction: testFraction,
    split,
    selectedPriorSeasonWeight: winner.priorSeasonWeight,
    selectedLambda: winner.lambda,
    selectedPriorWeightAtBoundary: winner.priorSeasonWeight === weights[0]
      || winner.priorSeasonWeight === weights[weights.length - 1],
    selectedLambdaAtBoundary: winner.lambda === lambdas[0]
      || winner.lambda === lambdas[lambdas.length - 1],
    tuningSelection: winner,
    candidates,
    test: testEvaluation,
    excludedStintCount: excluded.length,
    inputSha256: sha256Json({
      version: RAPM_CHRONOLOGICAL_CALIBRATION_VERSION,
      model,
      latestSeasonStartYear: latestSeason,
      weights,
      lambdas,
      split,
      observations: observations.map(observationToStint),
    }),
    caveat: 'The final test block is untouched during hyperparameter selection, but this remains predictive validation of lineup scoring rather than causal proof of individual player effects.',
  };
}

function selectLambdaFromGameFolds(rows, dimension, {
  candidateLambdas = DEFAULT_RAPM_LAMBDA_CANDIDATES,
  foldCount = 5,
  designColumnIds = [],
  unregularizedColumnCount = 1,
  requireSignedHomeCourtRows = false,
} = {}) {
  if (requireSignedHomeCourtRows) assertSignedHomeCourtRows(rows, 'Lambda selection');
  const candidates = normalizedLambdaCandidates(candidateLambdas);
  const foldPlan = buildDeterministicGameFoldPlan(rows, foldCount);
  const {
    requestedFoldCount,
    actualFoldCount,
    gameIds,
    foldByGameId,
    folds,
  } = foldPlan;

  const scores = candidates.map((lambda) => {
    let weightedSquaredError = 0;
    let heldOutWeight = 0;
    const foldScores = [];
    for (let foldIndex = 0; foldIndex < actualFoldCount; foldIndex += 1) {
      const trainingRows = rows.filter((row) => foldByGameId.get(row.gameId) !== foldIndex);
      const heldOutRows = rows.filter((row) => foldByGameId.get(row.gameId) === foldIndex);
      if (requireSignedHomeCourtRows) {
        assertSignedHomeCourtRows(trainingRows, `Lambda selection training fold ${foldIndex}`);
      }
      const solved = solveSparseWeightedRidge(trainingRows, dimension, lambda, { unregularizedColumnCount });
      if (!solved.converged) {
        throw new RangeError(`Lambda selection ridge solve did not converge for lambda ${lambda}, fold ${foldIndex}.`);
      }
      let foldSquaredError = 0;
      let foldWeight = 0;
      for (const row of heldOutRows) {
        let prediction = 0;
        for (const [index, value] of row.features) prediction += value * solved.coefficients[index];
        const error = row.response - prediction;
        foldSquaredError += row.weight * error * error;
        foldWeight += row.weight;
      }
      weightedSquaredError += foldSquaredError;
      heldOutWeight += foldWeight;
      foldScores.push({
        foldIndex,
        heldOutGameCount: folds[foldIndex].gameIds.length,
        heldOutWeight: foldWeight,
        weightedMse: foldSquaredError / foldWeight,
        weightedRmsePer100: 100 * Math.sqrt(foldSquaredError / foldWeight),
      });
    }
    const weightedMse = weightedSquaredError / heldOutWeight;
    return {
      lambda,
      weightedMse,
      weightedRmsePer100: 100 * Math.sqrt(weightedMse),
      heldOutWeight,
      foldScores,
    };
  });
  scores.sort((left, right) => left.weightedMse - right.weightedMse || left.lambda - right.lambda);
  const selectedLambda = scores[0].lambda;
  const candidateMinimum = Math.min(...candidates);
  const candidateMaximum = Math.max(...candidates);
  const selectedBoundary = selectedLambda === candidateMinimum
    ? 'minimum'
    : selectedLambda === candidateMaximum ? 'maximum' : null;
  return {
    method: 'deterministic_sorted_game_round_robin_weighted_mse_v1',
    selectedLambda,
    candidateRange: { minimum: candidateMinimum, maximum: candidateMaximum },
    selectedAtBoundary: selectedBoundary !== null,
    selectedBoundary,
    boundaryCaveat: selectedBoundary
      ? 'The best candidate lies at the search-grid boundary; consider expanding the grid before treating the regularization choice as stable.'
      : null,
    requestedFoldCount,
    foldCount: actualFoldCount,
    gameCount: gameIds.length,
    observationCount: rows.length,
    folds,
    candidates: scores,
    inputSha256: sha256Json({
      candidates,
      requestedFoldCount,
      folds,
      designColumnIds,
      unregularizedColumnCount,
      requireSignedHomeCourtRows,
      rows: rows.map((row) => ({
        gameId: row.gameId,
        weight: row.weight,
        response: row.response,
        features: row.features,
      })),
    }),
  };
}

export function selectWeightedRidgeRapmLambda(stints, options = {}) {
  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for RAPM.');
  const playerIds = observationPlayerIds(observations);
  return {
    ...selectLambdaFromGameFolds(netDesignRows(observations, playerIds), playerIds.length + 1, {
      ...options,
      designColumnIds: ['intercept', ...playerIds.map((playerId) => `net:${playerId}`)],
    }),
    excludedStintCount: excluded.length,
    excluded,
  };
}

export function selectWeightedRidgeOffenseDefenseLambda(stints, options = {}) {
  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for RAPM.');
  const playerIds = observationPlayerIds(observations);
  const { rows, skippedDirections } = offenseDefenseDesignRows(observations, playerIds);
  return {
    ...selectLambdaFromGameFolds(rows, playerIds.length * 2 + OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT, {
      ...options,
      unregularizedColumnCount: OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT,
      requireSignedHomeCourtRows: true,
      designColumnIds: [
        'intercept',
        'signed_home_court_effect',
        ...playerIds.map((playerId) => `offense:${playerId}`),
        ...playerIds.map((playerId) => `defense:${playerId}`),
      ],
    }),
    excludedStintCount: excluded.length,
    excluded,
    skippedDirectionalObservationCount: skippedDirections.length,
    skippedDirections,
  };
}

/**
 * Fits a possession-weighted ridge model. Coefficients are points per 100
 * paired possessions; the intercept is intentionally not regularized.
 */
export function fitWeightedRidgeRapm(stints, {
  lambda = 100,
  lambdaCandidates = DEFAULT_RAPM_LAMBDA_CANDIDATES,
  lambdaFoldCount = 5,
  displayPossessionThresholds = DEFAULT_RAPM_DISPLAY_POSSESSION_THRESHOLDS,
  modelVersion = RAPM_MODEL_VERSION,
  seasonEndYear = null,
  seasonPhase = 'regular',
} = {}) {
  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for RAPM.');
  const playerIds = observationPlayerIds(observations);
  let lambdaSelection = null;
  let ridgeLambda;
  if (lambda === 'auto') {
    lambdaSelection = selectLambdaFromGameFolds(
      netDesignRows(observations, playerIds),
      playerIds.length + 1,
      {
        candidateLambdas: lambdaCandidates,
        foldCount: lambdaFoldCount,
        designColumnIds: ['intercept', ...playerIds.map((playerId) => `net:${playerId}`)],
      }
    );
    ridgeLambda = lambdaSelection.selectedLambda;
  } else {
    ridgeLambda = asFiniteNumber(lambda, 'lambda');
    if (!(ridgeLambda > 0)) throw new RangeError('lambda must be greater than zero.');
  }
  const displayThresholds = normalizedDisplayThresholds(displayPossessionThresholds);
  const playerIndex = new Map(playerIds.map((playerId, index) => [playerId, index + 1]));
  const dimension = playerIds.length + 1;
  const normalMatrix = Array.from({ length: dimension }, () => Array(dimension).fill(0));
  const normalVector = Array(dimension).fill(0);

  for (const observation of observations) {
    const features = [[0, 1]];
    for (const playerId of observation.homePlayerIds) features.push([playerIndex.get(playerId), 1]);
    for (const playerId of observation.awayPlayerIds) features.push([playerIndex.get(playerId), -1]);
    for (const [row, rowValue] of features) {
      normalVector[row] += observation.weight * rowValue * observation.response;
      for (const [column, columnValue] of features) {
        normalMatrix[row][column] += observation.weight * rowValue * columnValue;
      }
    }
  }
  for (let index = 1; index < dimension; index += 1) normalMatrix[index][index] += ridgeLambda;
  const coefficients = choleskySolve(normalMatrix, normalVector);
  const input = observations.map((observation) => ({
    gameId: observation.gameId,
    stintOrdinal: observation.stintOrdinal,
    seasonStartYear: observation.seasonStartYear,
    scheduledAt: observation.scheduledAt,
    sampleWeight: observation.sampleWeight,
    homePlayerIds: observation.homePlayerIds,
    awayPlayerIds: observation.awayPlayerIds,
    homePoints: observation.homePoints,
    awayPoints: observation.awayPoints,
    homeOffensePoints: observation.homeOffensePoints,
    awayOffensePoints: observation.awayOffensePoints,
    homeOffensivePossessions: observation.homeOffensivePossessions,
    awayOffensivePossessions: observation.awayOffensivePossessions,
  }));

  const playerContext = new Map(playerIds.map((playerId) => [playerId, {
    pairedPossessions: 0,
    effectivePairedPossessions: 0,
    observationCount: 0,
    teammateCoefficientTotal: 0,
    opponentCoefficientTotal: 0,
  }]));
  const totalPairedPossessions = observations.reduce(
    (total, observation) => total + observation.pairedPossessions,
    0,
  );
  const totalEffectivePairedPossessions = observations.reduce(
    (total, observation) => total + observation.weight,
    0,
  );
  for (const observation of observations) {
    const homeCoefficients = observation.homePlayerIds.map((playerId) => coefficients[playerIndex.get(playerId)]);
    const awayCoefficients = observation.awayPlayerIds.map((playerId) => coefficients[playerIndex.get(playerId)]);
    for (const [sidePlayerIds, teammateCoefficients, opponentCoefficients] of [
      [observation.homePlayerIds, homeCoefficients, awayCoefficients],
      [observation.awayPlayerIds, awayCoefficients, homeCoefficients],
    ]) {
      for (let playerOffset = 0; playerOffset < sidePlayerIds.length; playerOffset += 1) {
        const context = playerContext.get(sidePlayerIds[playerOffset]);
        const teammateMean = teammateCoefficients
          .filter((_, index) => index !== playerOffset)
          .reduce((total, coefficient) => total + coefficient, 0) / 4;
        const opponentMean = opponentCoefficients
          .reduce((total, coefficient) => total + coefficient, 0) / 5;
        context.pairedPossessions += observation.pairedPossessions;
        context.effectivePairedPossessions += observation.weight;
        context.observationCount += 1;
        context.teammateCoefficientTotal += teammateMean * observation.weight;
        context.opponentCoefficientTotal += opponentMean * observation.weight;
      }
    }
  }

  return {
    modelVersion: String(modelVersion),
    seasonEndYear,
    seasonPhase: String(seasonPhase),
    lambda: ridgeLambda,
    lambdaSelection,
    observationCount: observations.length,
    gameCount: new Set(observations.map((observation) => observation.gameId)).size,
    totalPairedPossessions,
    totalEffectivePairedPossessions,
    excludedStintCount: excluded.length,
    excluded,
    reliability: {
      method: 'effective_paired_possessions_over_effective_paired_possessions_plus_lambda_proxy',
      caveat: 'This is a recency-weighted exposure-and-ridge stability proxy, not a confidence interval or causal certainty score. Raw possessions are retained separately.',
      displayPossessionThresholds: displayThresholds,
      sampleSizeTiers: ['insufficient', 'limited', 'moderate', 'established'],
    },
    contextSemantics: {
      averageTeammateNetRapmPer100: 'Possession-weighted mean fitted net RAPM of the other four players sharing the court.',
      averageOpponentNetRapmPer100: 'Possession-weighted mean fitted net RAPM of the five opposing players; this is exposure context, not a second adjustment to add or subtract.',
    },
    formulation: 'home_team_net_points_per_paired_possession = home_court_net_effect + sum(home_player_net_effects) - sum(away_player_net_effects)',
    homeCourtSignConvention: 'positive_increases_home_net_rating_relative_to_away',
    inputSha256: sha256Json({ modelVersion, ridgeLambda, seasonEndYear, seasonPhase, observations: input }),
    homeCourtNetRatingEffectPer100: coefficients[0] * 100,
    // Backward-compatible alias for earlier package consumers. Because every
    // row is oriented home minus away, the intercept is the model's net
    // home-court term rather than a neutral scoring baseline.
    interceptPer100: coefficients[0] * 100,
    players: playerIds.map((playerId, index) => {
      const context = playerContext.get(playerId);
      const averageTeammateNetRapmPer100 = context.effectivePairedPossessions > 0
        ? 100 * context.teammateCoefficientTotal / context.effectivePairedPossessions
        : null;
      const averageOpponentNetRapmPer100 = context.effectivePairedPossessions > 0
        ? 100 * context.opponentCoefficientTotal / context.effectivePairedPossessions
        : null;
      return {
        providerPlayerId: playerId,
        rapmPer100: coefficients[index + 1] * 100,
        pairedPossessions: context.pairedPossessions,
        effectivePairedPossessions: context.effectivePairedPossessions,
        observationCount: context.observationCount,
        averageTeammateNetRapmPer100,
        averageOpponentNetRapmPer100,
        // Backward-compatible aliases. These are contextual averages, not
        // additional adjustment terms.
        teammateRapmContextPer100: averageTeammateNetRapmPer100,
        opponentRapmContextPer100: averageOpponentNetRapmPer100,
        ...sampleSizeFields(
          context.effectivePairedPossessions,
          totalEffectivePairedPossessions,
          ridgeLambda,
          displayThresholds
        ),
      };
    }),
  };
}

/**
 * Fits two scoring-rate observations per paired stint:
 *
 *   points / offensive possession = neutral_venue_baseline
 *     + signed_home_court_effect (home +1, away -1)
 *     + sum(offensive player effects) - sum(defensive player effects)
 *
 * Positive defensive coefficients therefore mean fewer opponent points. The
 * offense/defense decomposition has location ambiguities without constraints;
 * the neutral-venue baseline and signed home-court effect remain unregularized
 * so fixed venue scoring is not assigned to players. Positive ridge penalties
 * make the player effects unique and center both sets around those fixed terms.
 */
export function fitWeightedRidgeOffenseDefenseRapm(stints, {
  lambda = 100,
  lambdaCandidates = DEFAULT_RAPM_LAMBDA_CANDIDATES,
  lambdaFoldCount = 5,
  displayPossessionThresholds = DEFAULT_RAPM_DISPLAY_POSSESSION_THRESHOLDS,
  modelVersion = RAPM_OFFENSE_DEFENSE_MODEL_VERSION,
  seasonEndYear = null,
  seasonPhase = 'regular',
  solverTolerance = 1e-10,
  solverMaxIterations = null,
} = {}) {
  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for RAPM.');
  const playerIds = observationPlayerIds(observations);
  const { rows, skippedDirections } = offenseDefenseDesignRows(observations, playerIds);
  if (!rows.length) throw new RangeError('No positive offensive-possession observations are available for offense/defense RAPM.');
  assertSignedHomeCourtRows(rows, 'Offense/defense RAPM');

  let lambdaSelection = null;
  let ridgeLambda;
  if (lambda === 'auto') {
    lambdaSelection = selectLambdaFromGameFolds(
      rows,
      playerIds.length * 2 + OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT,
      {
        candidateLambdas: lambdaCandidates,
        foldCount: lambdaFoldCount,
        unregularizedColumnCount: OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT,
        requireSignedHomeCourtRows: true,
        designColumnIds: [
          'intercept',
          'signed_home_court_effect',
          ...playerIds.map((playerId) => `offense:${playerId}`),
          ...playerIds.map((playerId) => `defense:${playerId}`),
        ],
      }
    );
    ridgeLambda = lambdaSelection.selectedLambda;
  } else {
    ridgeLambda = asFiniteNumber(lambda, 'lambda');
    if (!(ridgeLambda > 0)) throw new RangeError('lambda must be greater than zero.');
  }
  const displayThresholds = normalizedDisplayThresholds(displayPossessionThresholds);
  const tolerance = asFiniteNumber(solverTolerance, 'solverTolerance');
  if (!(tolerance > 0)) throw new RangeError('solverTolerance must be greater than zero.');
  let maxIterations;
  if (solverMaxIterations !== null && solverMaxIterations !== undefined) {
    maxIterations = Number(solverMaxIterations);
    if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
      throw new TypeError('solverMaxIterations must be a positive integer when provided.');
    }
  }

  const dimension = playerIds.length * 2 + OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT;
  const solved = solveSparseWeightedRidge(rows, dimension, ridgeLambda, {
    tolerance,
    maxIterations,
    unregularizedColumnCount: OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT,
  });
  if (!solved.converged) {
    throw new RangeError(`Offense/defense RAPM ridge solve did not converge after ${solved.iterationCount} iterations.`);
  }

  const playerOffset = new Map(playerIds.map((playerId, index) => [playerId, index]));
  const offenseStart = OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT;
  const defenseStart = playerIds.length + offenseStart;
  const playerExposure = new Map(playerIds.map((playerId) => [playerId, {
    offensivePossessions: 0,
    defensivePossessions: 0,
    effectiveOffensivePossessions: 0,
    effectiveDefensivePossessions: 0,
    offensiveObservationCount: 0,
    defensiveObservationCount: 0,
    homeOffensivePossessions: 0,
    homeDefensivePossessions: 0,
    awayOffensivePossessions: 0,
    awayDefensivePossessions: 0,
  }]));
  for (const observation of observations) {
    for (const playerId of observation.homePlayerIds) {
      const exposure = playerExposure.get(playerId);
      exposure.offensivePossessions += observation.homeOffensivePossessions;
      exposure.defensivePossessions += observation.awayOffensivePossessions;
      exposure.effectiveOffensivePossessions += observation.homeOffensivePossessions * observation.sampleWeight;
      exposure.effectiveDefensivePossessions += observation.awayOffensivePossessions * observation.sampleWeight;
      exposure.homeOffensivePossessions += observation.homeOffensivePossessions;
      exposure.homeDefensivePossessions += observation.awayOffensivePossessions;
      if (observation.homeOffensivePossessions > 0) exposure.offensiveObservationCount += 1;
      if (observation.awayOffensivePossessions > 0) exposure.defensiveObservationCount += 1;
    }
    for (const playerId of observation.awayPlayerIds) {
      const exposure = playerExposure.get(playerId);
      exposure.offensivePossessions += observation.awayOffensivePossessions;
      exposure.defensivePossessions += observation.homeOffensivePossessions;
      exposure.effectiveOffensivePossessions += observation.awayOffensivePossessions * observation.sampleWeight;
      exposure.effectiveDefensivePossessions += observation.homeOffensivePossessions * observation.sampleWeight;
      exposure.awayOffensivePossessions += observation.awayOffensivePossessions;
      exposure.awayDefensivePossessions += observation.homeOffensivePossessions;
      if (observation.awayOffensivePossessions > 0) exposure.offensiveObservationCount += 1;
      if (observation.homeOffensivePossessions > 0) exposure.defensiveObservationCount += 1;
    }
  }
  const totalPairedPossessions = observations
    .reduce((total, observation) => total + observation.pairedPossessions, 0);
  const totalEffectivePairedPossessions = observations
    .reduce((total, observation) => total + observation.weight, 0);
  const totalOffensivePossessions = rows.reduce((total, row) => total + row.rawWeight, 0);
  const totalEffectiveOffensivePossessions = rows.reduce((total, row) => total + row.weight, 0);
  const input = observations.map((observation) => ({
    gameId: observation.gameId,
    stintOrdinal: observation.stintOrdinal,
    seasonStartYear: observation.seasonStartYear,
    scheduledAt: observation.scheduledAt,
    sampleWeight: observation.sampleWeight,
    homePlayerIds: observation.homePlayerIds,
    awayPlayerIds: observation.awayPlayerIds,
    homePoints: observation.homePoints,
    awayPoints: observation.awayPoints,
    homeOffensePoints: observation.homeOffensePoints,
    awayOffensePoints: observation.awayOffensePoints,
    homeOffensivePossessions: observation.homeOffensivePossessions,
    awayOffensivePossessions: observation.awayOffensivePossessions,
  }));
  const venueExposureRows = playerIds.map((playerId) => {
    const exposure = playerExposure.get(playerId);
    const homePossessionSides = exposure.homeOffensivePossessions + exposure.homeDefensivePossessions;
    const awayPossessionSides = exposure.awayOffensivePossessions + exposure.awayDefensivePossessions;
    const totalPossessionSides = homePossessionSides + awayPossessionSides;
    return {
      providerPlayerId: playerId,
      homePossessionSides,
      awayPossessionSides,
      signedVenueExposureBalance: totalPossessionSides > 0
        ? (homePossessionSides - awayPossessionSides) / totalPossessionSides
        : null,
    };
  });
  const finiteVenueBalances = venueExposureRows
    .map((row) => Math.abs(row.signedVenueExposureBalance))
    .filter(Number.isFinite);
  const venueExposureDiagnostics = {
    method: 'player_home_vs_away_possession_side_balance_v1',
    playerCount: venueExposureRows.length,
    oneSidedPlayerCount: venueExposureRows.filter((row) => Math.abs(row.signedVenueExposureBalance) === 1).length,
    playersAboveAbsoluteBalance025: venueExposureRows.filter((row) => Math.abs(row.signedVenueExposureBalance) > 0.25).length,
    maximumAbsoluteBalance: finiteVenueBalances.length ? Math.max(...finiteVenueBalances) : null,
    meanAbsoluteBalance: finiteVenueBalances.length
      ? finiteVenueBalances.reduce((total, value) => total + value, 0) / finiteVenueBalances.length
      : null,
    caveat: 'The fixed home-court term is schedule adjusted but not causally isolated when individual player exposure is venue imbalanced. Use these diagnostics to judge venue-roster confounding.',
  };

  return {
    modelVersion: String(modelVersion),
    seasonEndYear,
    seasonPhase: String(seasonPhase),
    lambda: ridgeLambda,
    lambdaSelection,
    formulation: 'team_points_per_offensive_possession = neutral_venue_baseline + signed_home_court_effect(home:+1,away:-1) + sum(offense_effects) - sum(defense_effects)',
    defensiveSignConvention: 'positive_is_better_and_reduces_predicted_opponent_scoring',
    identification: 'The neutral-venue baseline and signed home-court effect are unregularized fixed terms. Positive ridge penalties regularize all player effects, yielding a unique penalized player solution only when both venue signs are observed; otherwise fitting fails closed. Venue exposure diagnostics disclose remaining schedule-roster confounding risk rather than claiming causal isolation.',
    venueExposureDiagnostics,
    directionalObservationCount: rows.length,
    pairedStintObservationCount: observations.length,
    gameCount: new Set(observations.map((observation) => observation.gameId)).size,
    totalOffensivePossessions,
    totalEffectiveOffensivePossessions,
    totalPairedPossessions,
    totalEffectivePairedPossessions,
    excludedStintCount: excluded.length,
    excluded,
    skippedDirectionalObservationCount: skippedDirections.length,
    skippedDirections,
    reliability: {
      method: 'effective_component_possessions_over_effective_component_possessions_plus_lambda_proxy',
      caveat: 'These are recency-weighted exposure-and-ridge stability proxies, not confidence intervals or causal certainty scores. Raw possessions are retained separately.',
      displayPossessionThresholds: displayThresholds,
      sampleSizeTiers: ['insufficient', 'limited', 'moderate', 'established'],
    },
    solver: {
      method: 'matrix_free_preconditioned_conjugate_gradient',
      converged: solved.converged,
      iterationCount: solved.iterationCount,
      residualNorm: solved.residualNorm,
      targetResidualNorm: solved.targetResidualNorm,
    },
    inputSha256: sha256Json({
      modelVersion,
      formulation: 'offense_plus_defense_signed_home_court_v2',
      ridgeLambda,
      seasonEndYear,
      seasonPhase,
      observations: input,
    }),
    baselineOffensiveRatingPer100: solved.coefficients[0] * 100,
    homeCourtEffectPer100: solved.coefficients[1] * 100,
    homeCourtSignConvention: 'positive_increases_home_offensive_rate_and_decreases_away_offensive_rate',
    homeCourtNetRatingEffectPer100: solved.coefficients[1] * 200,
    players: playerIds.map((playerId) => {
      const offset = playerOffset.get(playerId);
      const exposure = playerExposure.get(playerId);
      const offensiveRapmPer100 = solved.coefficients[offset + offenseStart] * 100;
      const defensiveRapmPer100 = solved.coefficients[defenseStart + offset] * 100;
      const pairedPossessions = (exposure.offensivePossessions + exposure.defensivePossessions) / 2;
      const effectivePairedPossessions = (
        exposure.effectiveOffensivePossessions + exposure.effectiveDefensivePossessions
      ) / 2;
      const venueExposure = venueExposureRows[offset];
      return {
        providerPlayerId: playerId,
        offensiveRapmPer100,
        defensiveRapmPer100,
        combinedRapmPer100: offensiveRapmPer100 + defensiveRapmPer100,
        offensivePossessions: exposure.offensivePossessions,
        defensivePossessions: exposure.defensivePossessions,
        effectiveOffensivePossessions: exposure.effectiveOffensivePossessions,
        effectiveDefensivePossessions: exposure.effectiveDefensivePossessions,
        pairedPossessions,
        effectivePairedPossessions,
        offensiveObservationCount: exposure.offensiveObservationCount,
        defensiveObservationCount: exposure.defensiveObservationCount,
        venueExposure,
        offensiveRidgeReliabilityProxy: exposure.effectiveOffensivePossessions
          / (exposure.effectiveOffensivePossessions + ridgeLambda),
        defensiveRidgeReliabilityProxy: exposure.effectiveDefensivePossessions
          / (exposure.effectiveDefensivePossessions + ridgeLambda),
        ...sampleSizeFields(
          effectivePairedPossessions,
          totalEffectivePairedPossessions,
          ridgeLambda,
          displayThresholds
        ),
      };
    }),
  };
}
