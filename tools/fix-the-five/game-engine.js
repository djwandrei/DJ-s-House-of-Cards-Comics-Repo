/**
 * Deterministic, browser-safe rules for the Fix the Five and Draft Night
 * historical games. This layer deliberately has no DOM, network, storage, or
 * private analytics dependency. It evaluates only the reviewed player pool
 * and candidate board published with a game run.
 */

export const FIX_THE_FIVE_SCHEMA_VERSION = 1;
export const FIX_THE_FIVE_SCORING_VERSION = 'fix-the-five-v1';
export const DRAFT_NIGHT_SCORING_VERSION = 'draft-night-v1';

export const GAME_ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'primaryCreator', label: 'Lead playmaker' }),
  Object.freeze({ id: 'floorSpacer', label: 'Floor spacer' }),
  Object.freeze({ id: 'connector', label: 'Low-turnover connector' }),
  Object.freeze({ id: 'efficientFinisher', label: 'Efficient finisher' }),
  Object.freeze({ id: 'pointOfAttack', label: 'Ball-pressure proxy' }),
  Object.freeze({ id: 'rimProtector', label: 'Rim protector' }),
  Object.freeze({ id: 'rebounder', label: 'Rebounder' }),
]);

const ROLE_IDS = Object.freeze(GAME_ROLE_DEFINITIONS.map((role) => role.id));
const ROLE_BY_ID = new Map(GAME_ROLE_DEFINITIONS.map((role) => [role.id, role]));
const OBJECTIVE_METRICS = Object.freeze([
  'points',
  'efgPct',
  'threePct',
  'rebounds',
  'assists',
  'steals',
  'blocks',
  'ballSecurity',
]);
const POSITION_KEYS = Object.freeze(['G', 'F', 'C']);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeId(value) {
  return String(value || '').trim();
}

function compareId(left, right) {
  return String(left).localeCompare(String(right));
}

function per36(player, field) {
  const minutes = number(player?.minutes);
  return minutes > 0 ? (number(player?.[field]) / minutes) * 36 : 0;
}

function weighted(...pairs) {
  const totalWeight = pairs.reduce((total, [, weight]) => total + weight, 0);
  if (!(totalWeight > 0)) return 0;
  return pairs.reduce((total, [value, weight]) => total + number(value) * weight, 0) / totalWeight;
}

function percentileMap(entries, { lowerIsBetter = false } = {}) {
  const sorted = entries.slice().sort((left, right) => (
    left.value - right.value || compareId(left.id, right.id)
  ));
  const percentiles = new Map();
  if (sorted.length === 1) return new Map([[sorted[0].id, 1]]);

  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1].value === sorted[index].value) end += 1;
    const rank = (index + end) / 2;
    const percentile = sorted.length > 1 ? rank / (sorted.length - 1) : 1;
    for (let cursor = index; cursor <= end; cursor += 1) {
      percentiles.set(sorted[cursor].id, lowerIsBetter ? 1 - percentile : percentile);
    }
    index = end + 1;
  }
  return percentiles;
}

function assertRoster(roster) {
  if (!Array.isArray(roster) || roster.length < 5) {
    throw new Error('A challenge needs at least five reviewed historical player rows.');
  }
  const ids = roster.map((player) => normalizeId(player?.id));
  if (ids.some((id) => !id)) throw new Error('Every historical player row needs a stable ID.');
  if (new Set(ids).size !== ids.length) throw new Error('Historical player rows must have unique IDs.');
}

function playerById(roster) {
  return new Map(roster.map((player) => [normalizeId(player.id), player]));
}

function positionList(player) {
  return [...new Set((Array.isArray(player?.positions) ? player.positions : [])
    .map((position) => String(position || '').trim().toUpperCase())
    .filter((position) => POSITION_KEYS.includes(position)))];
}

/**
 * Test a lineup against the published source-listed position requirements.
 * A multi-position player can fill only one required slot, so this is a small
 * bipartite matching problem rather than a loose count of position labels.
 */
export function hasLegalPositionAssignment(players = [], minimums = {}) {
  const slots = POSITION_KEYS.flatMap((position) => {
    const count = Math.max(0, Math.floor(number(minimums?.[position])));
    return Array.from({ length: count }, () => position);
  });
  if (slots.length > players.length) return false;
  const eligible = players.map(positionList);

  function assign(slotIndex, usedPlayers) {
    if (slotIndex >= slots.length) return true;
    const slot = slots[slotIndex];
    for (let playerIndex = 0; playerIndex < eligible.length; playerIndex += 1) {
      if (usedPlayers.has(playerIndex) || !eligible[playerIndex].includes(slot)) continue;
      usedPlayers.add(playerIndex);
      if (assign(slotIndex + 1, usedPlayers)) return true;
      usedPlayers.delete(playerIndex);
    }
    return false;
  }

  return assign(0, new Set());
}

/**
 * Build a compact role model from source-visible, per-game historical values.
 * It intentionally labels ball pressure as a box-score proxy and does not
 * infer movement shooting, matchup assignments, or possession-level defense.
 */
export function buildGameRoleModel(roster = []) {
  assertRoster(roster);
  const percentile = {
    points: percentileMap(roster.map((player) => ({ id: player.id, value: per36(player, 'points') }))),
    rebounds: percentileMap(roster.map((player) => ({ id: player.id, value: per36(player, 'rebounds') }))),
    assists: percentileMap(roster.map((player) => ({ id: player.id, value: per36(player, 'assists') }))),
    steals: percentileMap(roster.map((player) => ({ id: player.id, value: per36(player, 'steals') }))),
    blocks: percentileMap(roster.map((player) => ({ id: player.id, value: per36(player, 'blocks') }))),
    turnovers: percentileMap(roster.map((player) => ({ id: player.id, value: per36(player, 'turnovers') })), { lowerIsBetter: true }),
    efgPct: percentileMap(roster.map((player) => ({ id: player.id, value: number(player?.efgPct) }))),
    threePct: percentileMap(roster.map((player) => ({ id: player.id, value: number(player?.threePct) }))),
  };

  const signalsById = new Map();
  for (const player of roster) {
    const id = normalizeId(player.id);
    const values = {
      primaryCreator: weighted(
        [percentile.assists.get(id), 0.62],
        [percentile.points.get(id), 0.22],
        [percentile.turnovers.get(id), 0.16],
      ),
      floorSpacer: weighted(
        [percentile.threePct.get(id), 0.65],
        [percentile.efgPct.get(id), 0.25],
        [percentile.points.get(id), 0.10],
      ),
      connector: weighted(
        [percentile.assists.get(id), 0.58],
        [percentile.turnovers.get(id), 0.42],
      ),
      efficientFinisher: weighted(
        [percentile.efgPct.get(id), 0.50],
        [percentile.points.get(id), 0.32],
        [percentile.rebounds.get(id), 0.18],
      ),
      pointOfAttack: weighted(
        [percentile.steals.get(id), 0.72],
        [percentile.turnovers.get(id), 0.28],
      ),
      rimProtector: weighted(
        [percentile.blocks.get(id), 0.70],
        [percentile.rebounds.get(id), 0.30],
      ),
      rebounder: percentile.rebounds.get(id) || 0,
    };
    signalsById.set(id, values);
  }

  return Object.freeze({
    version: FIX_THE_FIVE_SCORING_VERSION,
    playerCount: roster.length,
    percentile,
    signalsById,
  });
}

function objectiveWeightsFor(weights = {}) {
  const normalized = Object.fromEntries(OBJECTIVE_METRICS.map((metric) => [
    metric,
    Math.max(0, number(weights?.[metric])),
  ]));
  const total = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    return Object.fromEntries(Object.entries(normalized).map(([metric, value]) => [metric, value / total]));
  }
  return Object.fromEntries(OBJECTIVE_METRICS.map((metric) => [metric, 1 / OBJECTIVE_METRICS.length]));
}

function rolePriorityWeights(weights = {}) {
  const metricWeights = objectiveWeightsFor(weights);
  const raw = {
    primaryCreator: 0.35 + metricWeights.assists + metricWeights.ballSecurity * 0.60 + metricWeights.points * 0.20,
    floorSpacer: 0.35 + metricWeights.threePct + metricWeights.efgPct * 0.35,
    connector: 0.30 + metricWeights.assists * 0.55 + metricWeights.ballSecurity * 0.75,
    efficientFinisher: 0.35 + metricWeights.efgPct * 0.70 + metricWeights.points * 0.55,
    pointOfAttack: 0.35 + metricWeights.steals,
    rimProtector: 0.35 + metricWeights.blocks * 0.70 + metricWeights.rebounds * 0.25,
    rebounder: 0.35 + metricWeights.rebounds,
  };
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(Object.entries(raw).map(([role, value]) => [role, value / total]));
}

/** Return source-bounded Lineup DNA coverage for a five-player selection. */
export function describeLineupDna(players = [], roleModel, objectiveWeights = {}) {
  if (!Array.isArray(players) || players.length !== 5) {
    throw new Error('Lineup DNA needs exactly five selected players.');
  }
  const priorities = rolePriorityWeights(objectiveWeights);
  const coverage = {};
  for (const role of ROLE_IDS) {
    const signals = players
      .map((player) => number(roleModel?.signalsById?.get(normalizeId(player.id))?.[role]))
      .sort((left, right) => right - left);
    coverage[role] = Math.min(1, (signals[0] || 0) * 0.78 + (signals[1] || 0) * 0.22);
  }
  const roleRows = ROLE_IDS.map((id) => ({
    id,
    label: ROLE_BY_ID.get(id)?.label || id,
    coverage: coverage[id],
    priority: priorities[id],
  }));
  const fitIndex = roleRows.reduce((total, role) => total + role.coverage * role.priority * 100, 0);
  const strengths = roleRows.slice().sort((left, right) => right.coverage - left.coverage || compareId(left.id, right.id)).slice(0, 3);
  const needs = roleRows.slice().sort((left, right) => left.coverage - right.coverage || compareId(left.id, right.id)).slice(0, 3);
  return Object.freeze({
    fitIndex,
    coverage,
    priorities,
    strengths,
    needs,
    evidence: 'Historical per-game box-score snapshot. Ball pressure is a steals-and-ball-security proxy; this does not establish matchup assignments or team defense.',
  });
}

function directObjectiveScore(players = [], roleModel, objectiveWeights = {}) {
  const weights = objectiveWeightsFor(objectiveWeights);
  return players.reduce((sum, player) => {
    const id = normalizeId(player.id);
    const values = {
      points: roleModel.percentile.points.get(id) || 0,
      efgPct: roleModel.percentile.efgPct.get(id) || 0,
      threePct: roleModel.percentile.threePct.get(id) || 0,
      rebounds: roleModel.percentile.rebounds.get(id) || 0,
      assists: roleModel.percentile.assists.get(id) || 0,
      steals: roleModel.percentile.steals.get(id) || 0,
      blocks: roleModel.percentile.blocks.get(id) || 0,
      ballSecurity: roleModel.percentile.turnovers.get(id) || 0,
    };
    return sum + Object.entries(weights).reduce((playerScore, [metric, weight]) => (
      playerScore + values[metric] * weight * 100
    ), 0);
  }, 0) / players.length;
}

function idsToPlayers(ids = [], rosterById) {
  const players = ids.map((id) => rosterById.get(normalizeId(id)));
  if (players.some((player) => !player)) {
    throw new Error('A reviewed challenge references a player outside its published historical roster.');
  }
  return players;
}

function uniqueIds(ids = []) {
  const normalized = ids.map(normalizeId);
  return normalized.length === new Set(normalized).size;
}

function coverageDelta(before, after) {
  return ROLE_IDS.map((id) => ({
    id,
    label: ROLE_BY_ID.get(id)?.label || id,
    before: before.coverage[id],
    after: after.coverage[id],
    change: after.coverage[id] - before.coverage[id],
  })).sort((left, right) => right.change - left.change || compareId(left.id, right.id));
}

function assertChallengeShape(challenge, rosterById) {
  if (!challenge || typeof challenge !== 'object') throw new Error('A challenge must be an object.');
  if (Number(challenge.schemaVersion) !== FIX_THE_FIVE_SCHEMA_VERSION) {
    throw new Error(`Challenge ${challenge?.id || '(unknown)'} has an unsupported schema version.`);
  }
  if (!/^[a-z0-9-]+$/.test(normalizeId(challenge.id))) throw new Error('Every challenge needs a stable lowercase ID.');
  if (!Array.isArray(challenge.lineupIds) || challenge.lineupIds.length !== 5 || !uniqueIds(challenge.lineupIds)) {
    throw new Error(`${challenge.id} needs five distinct starting-lineup player IDs.`);
  }
  if (!normalizeId(challenge.removeId) || !challenge.lineupIds.includes(challenge.removeId)) {
    throw new Error(`${challenge.id} must remove one player from its displayed five.`);
  }
  if (!Array.isArray(challenge.candidateIds) || challenge.candidateIds.length < 3 || !uniqueIds(challenge.candidateIds)) {
    throw new Error(`${challenge.id} needs at least three distinct candidate IDs.`);
  }
  if (challenge.candidateIds.some((id) => challenge.lineupIds.includes(id))) {
    throw new Error(`${challenge.id} cannot offer a player already in the displayed five.`);
  }
  if (!uniqueIds([...challenge.lineupIds, ...challenge.candidateIds])) {
    throw new Error(`${challenge.id} contains duplicate player IDs.`);
  }
  idsToPlayers([...challenge.lineupIds, ...challenge.candidateIds], rosterById);
}

/**
 * Evaluate each published candidate against a fixed historical five.
 * "Best" means the top reviewed legal candidate on this exact board—not a
 * prediction, a win probability, or an observed historical lineup outcome.
 */
export function evaluateFixTheFiveChallenge(challenge, roster = []) {
  assertRoster(roster);
  const rosterById = playerById(roster);
  assertChallengeShape(challenge, rosterById);
  const roleModel = buildGameRoleModel(roster);
  const lineup = idsToPlayers(challenge.lineupIds, rosterById);
  const remaining = lineup.filter((player) => player.id !== challenge.removeId);
  const baselineDna = describeLineupDna(lineup, roleModel, challenge.objectiveWeights);
  const baselineDirect = directObjectiveScore(lineup, roleModel, challenge.objectiveWeights);
  const minimums = challenge.positionMinimums || { G: 1, F: 1, C: 1 };

  const candidateResults = challenge.candidateIds.map((candidateId) => {
    const candidate = rosterById.get(candidateId);
    const selected = [...remaining, candidate];
    const legal = hasLegalPositionAssignment(selected, minimums);
    const dna = describeLineupDna(selected, roleModel, challenge.objectiveWeights);
    const directObjective = directObjectiveScore(selected, roleModel, challenge.objectiveWeights);
    const composite = directObjective * 0.62 + dna.fitIndex * 0.38;
    return {
      candidateId,
      candidate,
      selected,
      legal,
      dna,
      directObjective,
      composite,
      coverageDelta: coverageDelta(baselineDna, dna),
    };
  }).filter((result) => result.legal);

  if (candidateResults.length < 2) {
    throw new Error(`${challenge.id} needs at least two legal published candidates.`);
  }
  const ranked = candidateResults.slice().sort((left, right) => (
    right.composite - left.composite
    || right.dna.fitIndex - left.dna.fitIndex
    || compareId(left.candidateId, right.candidateId)
  ));
  const best = ranked[0];
  const evaluated = ranked.map((result, index) => {
    const distanceToBest = best.composite > 0 ? clamp(result.composite / best.composite) : 1;
    const roleGain = result.dna.fitIndex - baselineDna.fitIndex;
    // DNA coverage is already 38% of the transparent candidate composite.
    // Scaling that composite to the best legal answer keeps a reference-best
    // choice at 100 while still making a role regression visibly costly.
    const roleImprovement = roleGain;
    const roundScore = Math.round(distanceToBest * 100);
    return Object.freeze({
      ...result,
      rank: index + 1,
      distanceToBest,
      roleImprovement,
      roundScore,
      isBest: result.candidateId === best.candidateId,
    });
  });
  const byCandidateId = Object.freeze(Object.fromEntries(evaluated.map((result) => [result.candidateId, result])));

  return Object.freeze({
    scoringVersion: FIX_THE_FIVE_SCORING_VERSION,
    challenge,
    lineup,
    removed: rosterById.get(challenge.removeId),
    baseline: Object.freeze({ dna: baselineDna, directObjective: baselineDirect }),
    candidates: evaluated,
    best: byCandidateId[best.candidateId],
    byCandidateId,
    evidence: 'Every candidate is compared within this reviewed historical roster and published candidate board. The score ranks a transparent role-and-stat fit, not a real-game result or future forecast.',
  });
}

/** Validate a static fixture bank before its browser release. */
export function validateFixTheFiveFixtures(fixtures = [], roster = []) {
  if (!Array.isArray(fixtures) || fixtures.length < 10) {
    throw new Error('Fix the Five needs at least ten reviewed historical fixtures.');
  }
  const ids = fixtures.map((fixture) => normalizeId(fixture?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('Fix the Five fixture IDs must be present and unique.');
  }
  return fixtures.map((fixture) => {
    if (fixture.reviewStatus !== 'reviewed') {
      throw new Error(`${fixture.id} is not marked reviewed.`);
    }
    const evaluation = evaluateFixTheFiveChallenge(fixture, roster);
    if (normalizeId(fixture.answerId) !== evaluation.best.candidateId) {
      throw new Error(`${fixture.id} answerId does not match the current reviewed scoring contract.`);
    }
    return evaluation;
  });
}

function draftSelectionSignature(ids = []) {
  return ids.map(normalizeId).join('|');
}

function enumerateDraftSelections(rounds = [], cursor = 0, selected = [], result = []) {
  if (cursor >= rounds.length) {
    result.push(selected);
    return result;
  }
  rounds[cursor].candidateIds.forEach((candidateId) => {
    enumerateDraftSelections(rounds, cursor + 1, [...selected, candidateId], result);
  });
  return result;
}

function assertDraftNightDeckShape(deck, rosterById) {
  if (!deck || typeof deck !== 'object') throw new Error('A Draft Night deck must be an object.');
  if (Number(deck.schemaVersion) !== FIX_THE_FIVE_SCHEMA_VERSION) {
    throw new Error(`Draft Night deck ${deck?.id || '(unknown)'} has an unsupported schema version.`);
  }
  if (!/^[a-z0-9-]+$/.test(normalizeId(deck.id))) {
    throw new Error('Every Draft Night deck needs a stable lowercase ID.');
  }
  if (deck.reviewStatus !== 'reviewed') {
    throw new Error(`${deck.id} is not marked reviewed.`);
  }
  if (!Array.isArray(deck.rounds) || deck.rounds.length !== 5) {
    throw new Error(`${deck.id} needs exactly five published draft rounds.`);
  }
  const roundIds = deck.rounds.map((round) => normalizeId(round?.id));
  if (roundIds.some((id) => !id) || new Set(roundIds).size !== roundIds.length) {
    throw new Error(`${deck.id} has missing or duplicate round IDs.`);
  }
  const candidateIds = deck.rounds.flatMap((round) => round?.candidateIds || []);
  for (const round of deck.rounds) {
    if (!Array.isArray(round?.candidateIds) || round.candidateIds.length < 3 || !uniqueIds(round.candidateIds)) {
      throw new Error(`${deck.id}:${round?.id || '(unknown)'} needs at least three distinct candidates.`);
    }
  }
  if (!uniqueIds(candidateIds)) {
    throw new Error(`${deck.id} cannot offer the same player in more than one draft round.`);
  }
  idsToPlayers(candidateIds, rosterById);
}

/**
 * Evaluate every disclosed combination in a five-round Draft Night deck.
 * The deck is intentionally small (three choices per round) so a visitor's
 * score has a complete, inspectable published-board reference.
 */
export function evaluateDraftNightDeck(deck, roster = []) {
  assertRoster(roster);
  const rosterById = playerById(roster);
  assertDraftNightDeckShape(deck, rosterById);
  const roleModel = buildGameRoleModel(roster);
  const minimums = deck.positionMinimums || { G: 2, F: 2, C: 1 };
  const selectionIdsList = enumerateDraftSelections(deck.rounds);
  const outcomes = selectionIdsList.map((selectionIds) => {
    const selected = idsToPlayers(selectionIds, rosterById);
    const legal = hasLegalPositionAssignment(selected, minimums);
    const dna = describeLineupDna(selected, roleModel, deck.objectiveWeights);
    const directObjective = directObjectiveScore(selected, roleModel, deck.objectiveWeights);
    return {
      selectionIds: Object.freeze(selectionIds.slice()),
      signature: draftSelectionSignature(selectionIds),
      selected,
      legal,
      dna,
      directObjective,
      composite: directObjective * 0.62 + dna.fitIndex * 0.38,
    };
  });
  if (outcomes.some((outcome) => !outcome.legal)) {
    throw new Error(`${deck.id} includes a draft path that breaks its published court shape.`);
  }
  const ranked = outcomes.slice().sort((left, right) => (
    right.composite - left.composite
    || right.dna.fitIndex - left.dna.fitIndex
    || left.signature.localeCompare(right.signature)
  ));
  const best = ranked[0];
  const evaluated = ranked.map((outcome, index) => Object.freeze({
    ...outcome,
    rank: index + 1,
    roundScore: Math.round(best.composite > 0 ? clamp(outcome.composite / best.composite) * 100 : 100),
    isBest: outcome.signature === best.signature,
  }));
  const bySelectionSignature = Object.freeze(Object.fromEntries(evaluated.map((outcome) => [outcome.signature, outcome])));
  return Object.freeze({
    scoringVersion: DRAFT_NIGHT_SCORING_VERSION,
    deck,
    combinations: evaluated,
    best: bySelectionSignature[best.signature],
    bySelectionSignature,
    evidence: 'Every result is ranked against the fully published historical draft board. It reports a source-bounded stat-and-role fit, not a real lineup result or future forecast.',
  });
}

/** Validate the release bank and each published Draft Night combination. */
export function validateDraftNightDecks(decks = [], roster = []) {
  if (!Array.isArray(decks) || decks.length < 5) {
    throw new Error('Draft Night needs at least five reviewed historical decks.');
  }
  const ids = decks.map((deck) => normalizeId(deck?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('Draft Night deck IDs must be present and unique.');
  }
  return decks.map((deck) => evaluateDraftNightDeck(deck, roster));
}

/** Stable seed hash for daily challenges and replay/share URLs. */
export function hashSeed(value = '') {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = hashSeed(seed) || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(values = [], seed = '') {
  const result = values.slice();
  const random = seededRandom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function chicagoDailySeed(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Return five distinct fixture IDs in a reproducible daily order. */
export function buildChallengeRun(fixtures = [], seed = '', count = 5) {
  if (!Array.isArray(fixtures) || fixtures.length < count) {
    throw new Error(`A run needs at least ${count} reviewed fixtures.`);
  }
  return seededShuffle(fixtures, `fix-the-five:${seed}`).slice(0, count);
}

/** Choose one reviewed Draft Night deck for a stable daily or shared seed. */
export function buildDraftNightDeck(decks = [], seed = '') {
  if (!Array.isArray(decks) || decks.length < 1) {
    throw new Error('Draft Night needs at least one reviewed deck.');
  }
  return seededShuffle(decks, `draft-night:${seed}`)[0];
}

export function formatRolePercent(value) {
  return `${Math.round(clamp(number(value)) * 100)}%`;
}

export function formatSignedPoints(value) {
  const rounded = Number(Math.abs(number(value)).toFixed(1));
  const prefix = rounded === 0 ? '±' : value > 0 ? '+' : '−';
  return `${prefix}${rounded}`;
}
