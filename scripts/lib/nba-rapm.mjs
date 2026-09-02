import crypto from 'node:crypto';

export const RAPM_MODEL_VERSION = 'weighted_ridge_rapm_v1';
export const RAPM_OFFENSE_DEFENSE_MODEL_VERSION = 'weighted_ridge_offense_defense_rapm_v2';
export const DEFAULT_RAPM_LAMBDA_CANDIDATES = Object.freeze([1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
export const DEFAULT_RAPM_DISPLAY_POSSESSION_THRESHOLDS = Object.freeze([200, 500, 1000]);
const OFFENSE_DEFENSE_UNREGULARIZED_COLUMN_COUNT = 2;

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
  ].join('|').localeCompare([
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
  return {
    gameId: normalizedGameId(stint.gameId, index),
    stintOrdinal: Number.isInteger(stint.stintOrdinal) ? stint.stintOrdinal : index,
    homePlayerIds,
    awayPlayerIds,
    homePoints,
    awayPoints,
    homeOffensePoints,
    awayOffensePoints,
    homeOffensivePossessions,
    awayOffensivePossessions,
    weight: exposure,
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
      weight: possessions,
      response: points / possessions,
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

function selectLambdaFromGameFolds(rows, dimension, {
  candidateLambdas = DEFAULT_RAPM_LAMBDA_CANDIDATES,
  foldCount = 5,
  designColumnIds = [],
  unregularizedColumnCount = 1,
  requireSignedHomeCourtRows = false,
} = {}) {
  if (requireSignedHomeCourtRows) assertSignedHomeCourtRows(rows, 'Lambda selection');
  const candidates = normalizedLambdaCandidates(candidateLambdas);
  const requestedFoldCount = normalizedFoldCount(foldCount);
  const gameIds = [...new Set(rows.map((row) => row.gameId))]
    .sort((left, right) => left.localeCompare(right));
  if (gameIds.length < 2) throw new RangeError('Lambda selection requires at least two distinct games.');
  const actualFoldCount = Math.min(requestedFoldCount, gameIds.length);
  const foldByGameId = new Map(gameIds.map((gameId, index) => [gameId, index % actualFoldCount]));
  const folds = Array.from({ length: actualFoldCount }, (_, foldIndex) => ({
    foldIndex,
    gameIds: gameIds.filter((gameId) => foldByGameId.get(gameId) === foldIndex),
  }));

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
    observationCount: 0,
    teammateCoefficientTotal: 0,
    opponentCoefficientTotal: 0,
  }]));
  const totalPairedPossessions = observations.reduce((total, observation) => total + observation.weight, 0);
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
        context.pairedPossessions += observation.weight;
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
    excludedStintCount: excluded.length,
    excluded,
    reliability: {
      method: 'paired_possessions_over_paired_possessions_plus_lambda_proxy',
      caveat: 'This is an exposure-and-ridge stability proxy, not a confidence interval or causal certainty score.',
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
      const averageTeammateNetRapmPer100 = context.pairedPossessions > 0
        ? 100 * context.teammateCoefficientTotal / context.pairedPossessions
        : null;
      const averageOpponentNetRapmPer100 = context.pairedPossessions > 0
        ? 100 * context.opponentCoefficientTotal / context.pairedPossessions
        : null;
      return {
        providerPlayerId: playerId,
        rapmPer100: coefficients[index + 1] * 100,
        pairedPossessions: context.pairedPossessions,
        observationCount: context.observationCount,
        averageTeammateNetRapmPer100,
        averageOpponentNetRapmPer100,
        // Backward-compatible aliases. These are contextual averages, not
        // additional adjustment terms.
        teammateRapmContextPer100: averageTeammateNetRapmPer100,
        opponentRapmContextPer100: averageOpponentNetRapmPer100,
        ...sampleSizeFields(
          context.pairedPossessions,
          totalPairedPossessions,
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
      exposure.homeOffensivePossessions += observation.homeOffensivePossessions;
      exposure.homeDefensivePossessions += observation.awayOffensivePossessions;
      if (observation.homeOffensivePossessions > 0) exposure.offensiveObservationCount += 1;
      if (observation.awayOffensivePossessions > 0) exposure.defensiveObservationCount += 1;
    }
    for (const playerId of observation.awayPlayerIds) {
      const exposure = playerExposure.get(playerId);
      exposure.offensivePossessions += observation.awayOffensivePossessions;
      exposure.defensivePossessions += observation.homeOffensivePossessions;
      exposure.awayOffensivePossessions += observation.awayOffensivePossessions;
      exposure.awayDefensivePossessions += observation.homeOffensivePossessions;
      if (observation.awayOffensivePossessions > 0) exposure.offensiveObservationCount += 1;
      if (observation.homeOffensivePossessions > 0) exposure.defensiveObservationCount += 1;
    }
  }
  const totalPairedPossessions = observations
    .reduce((total, observation) => total + observation.weight, 0);
  const totalOffensivePossessions = rows.reduce((total, row) => total + row.weight, 0);
  const input = observations.map((observation) => ({
    gameId: observation.gameId,
    stintOrdinal: observation.stintOrdinal,
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
    totalPairedPossessions,
    excludedStintCount: excluded.length,
    excluded,
    skippedDirectionalObservationCount: skippedDirections.length,
    skippedDirections,
    reliability: {
      method: 'component_possessions_over_component_possessions_plus_lambda_proxy',
      caveat: 'These are exposure-and-ridge stability proxies, not confidence intervals or causal certainty scores.',
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
      const venueExposure = venueExposureRows[offset];
      return {
        providerPlayerId: playerId,
        offensiveRapmPer100,
        defensiveRapmPer100,
        combinedRapmPer100: offensiveRapmPer100 + defensiveRapmPer100,
        offensivePossessions: exposure.offensivePossessions,
        defensivePossessions: exposure.defensivePossessions,
        pairedPossessions,
        offensiveObservationCount: exposure.offensiveObservationCount,
        defensiveObservationCount: exposure.defensiveObservationCount,
        venueExposure,
        offensiveRidgeReliabilityProxy: exposure.offensivePossessions
          / (exposure.offensivePossessions + ridgeLambda),
        defensiveRidgeReliabilityProxy: exposure.defensivePossessions
          / (exposure.defensivePossessions + ridgeLambda),
        ...sampleSizeFields(
          pairedPossessions,
          totalPairedPossessions,
          ridgeLambda,
          displayThresholds
        ),
      };
    }),
  };
}
