import crypto from 'node:crypto';

export const RAPM_MODEL_VERSION = 'weighted_ridge_rapm_v1';

function asFiniteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a finite number.`);
  return parsed;
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
    left.homeOffensivePossessions,
    left.awayOffensivePossessions,
  ].join('|').localeCompare([
    right.gameId,
    String(right.stintOrdinal).padStart(12, '0'),
    right.homePlayerIds.join(','),
    right.awayPlayerIds.join(','),
    right.homePoints,
    right.awayPoints,
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
  const homePoints = asFiniteNumber(stint.homePoints, `stint ${index} homePoints`);
  const awayPoints = asFiniteNumber(stint.awayPoints, `stint ${index} awayPoints`);
  const homeOffensivePossessions = asFiniteNumber(
    stint.homeOffensivePossessions ?? stint.homeOffPossessions,
    `stint ${index} homeOffensivePossessions`
  );
  const awayOffensivePossessions = asFiniteNumber(
    stint.awayOffensivePossessions ?? stint.awayOffPossessions,
    `stint ${index} awayOffensivePossessions`
  );
  const exposure = (homeOffensivePossessions + awayOffensivePossessions) / 2;
  if (!(exposure > 0)) throw new RangeError(`stint ${index} must have positive paired possession exposure.`);
  return {
    gameId: String(stint.gameId ?? '').trim() || `unknown-game-${index}`,
    stintOrdinal: Number.isInteger(stint.stintOrdinal) ? stint.stintOrdinal : index,
    homePlayerIds,
    awayPlayerIds,
    homePoints,
    awayPoints,
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

/**
 * Fits a possession-weighted ridge model. Coefficients are points per 100
 * paired possessions; the intercept is intentionally not regularized.
 */
export function fitWeightedRidgeRapm(stints, {
  lambda = 100,
  modelVersion = RAPM_MODEL_VERSION,
  seasonEndYear = null,
  seasonPhase = 'regular',
} = {}) {
  const ridgeLambda = asFiniteNumber(lambda, 'lambda');
  if (!(ridgeLambda > 0)) throw new RangeError('lambda must be greater than zero.');
  const { observations, excluded } = buildRapmObservations(stints);
  if (!observations.length) throw new RangeError('No valid paired five-on-five stints are available for RAPM.');

  const playerIds = [...new Set(observations.flatMap((observation) => [
    ...observation.homePlayerIds,
    ...observation.awayPlayerIds,
  ]))].sort((left, right) => left.localeCompare(right));
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
    homeOffensivePossessions: observation.homeOffensivePossessions,
    awayOffensivePossessions: observation.awayOffensivePossessions,
  }));

  const playerContext = new Map(playerIds.map((playerId) => [playerId, {
    pairedPossessions: 0,
    observationCount: 0,
    teammateCoefficientTotal: 0,
    opponentCoefficientTotal: 0,
  }]));
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
    observationCount: observations.length,
    gameCount: new Set(observations.map((observation) => observation.gameId)).size,
    excludedStintCount: excluded.length,
    excluded,
    inputSha256: sha256Json({ modelVersion, ridgeLambda, seasonEndYear, seasonPhase, observations: input }),
    interceptPer100: coefficients[0] * 100,
    players: playerIds.map((playerId, index) => {
      const context = playerContext.get(playerId);
      return {
        providerPlayerId: playerId,
        rapmPer100: coefficients[index + 1] * 100,
        pairedPossessions: context.pairedPossessions,
        observationCount: context.observationCount,
        teammateRapmContextPer100: context.pairedPossessions > 0
          ? 100 * context.teammateCoefficientTotal / context.pairedPossessions
          : null,
        opponentRapmContextPer100: context.pairedPossessions > 0
          ? 100 * context.opponentCoefficientTotal / context.pairedPossessions
          : null,
      };
    }),
  };
}
