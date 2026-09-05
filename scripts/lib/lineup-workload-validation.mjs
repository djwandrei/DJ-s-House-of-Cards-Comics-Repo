/** Offline validation helpers. No player rows are exported to public assets. */
function timestamp(value, label) {
  // Require an explicit timezone and a real calendar date: Date.parse alone
  // accepts ambiguous dates and silently rolls February 30 into March.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(`${label}: explicit ISO timestamp required.`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) throw new Error(`${label}: invalid calendar date.`);
  return parsed;
}

export function validateGames(games) {
  if (!Array.isArray(games)) throw new Error('Games must be an array.');
  const ids = new Set();
  for (const game of games) {
    if (typeof game?.id !== 'string' || !game.id.trim() || game.id !== game.id.trim() || ids.has(game.id)) throw new Error('Missing or duplicate game identity.');
    ids.add(game.id);
    const date = timestamp(game.date, `Game ${game.id}`);
    if (!Array.isArray(game.rows)) throw new Error(`Game ${game.id}: rows must be an array.`);
    const players = new Set();
    for (const row of game.rows) {
      // Grain is exactly one player appearance per game, irrespective of team.
      // Silently deduplicating here could retain a conflicting target value.
      if (typeof row?.id !== 'string' || !row.id.trim() || row.id !== row.id.trim() || players.has(row.id)) throw new Error(`Game ${game.id}: missing or duplicate player row.`);
      players.add(row.id);
      if (row.gameId !== undefined && row.gameId !== game.id) throw new Error(`Game ${game.id}: row game identity mismatch.`);
      if (row.date !== undefined && timestamp(row.date, `Row ${row.id}`) !== date) throw new Error(`Game ${game.id}: row date mismatch.`);
      if (row.games !== undefined && row.games !== 1) throw new Error(`Game ${game.id}: row must represent one appearance.`);
    }
  }
}

export function chronologicalSplit(games) {
  validateGames(games);
  const ordered = [...games].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  if (ordered.length < 100) throw new Error('At least 100 complete games are required.');
  const day = game => new Date(game.date).toISOString().slice(0, 10);
  const boundaries = [];
  for (let i = 1; i < ordered.length; i++) if (day(ordered[i]) !== day(ordered[i - 1])) boundaries.push(i);
  // Keep the entire UTC calendar day together, even when start times differ.
  // A close 60/20/20 split is less important than withholding a clean future.
  if (boundaries.length < 2) throw new Error('At least three distinct UTC game dates are required.');
  const nearest = (choices, target) => [...choices].sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0];
  const first = nearest(boundaries.slice(0, -1), ordered.length * .6);
  const second = nearest(boundaries.filter(i => i > first), ordered.length * .8);
  return { ordered, train: ordered.slice(0, first), tune: ordered.slice(first, second), test: ordered.slice(second) };
}

export function relativeImprovement(projected, reference) {
  return Number.isFinite(projected) && Number.isFinite(reference) && reference > 0 ? 1 - projected / reference : null;
}

function randomSequence(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(sorted, fraction) {
  const index = (sorted.length - 1) * fraction, lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
}

export function pairedGameBootstrap(projected, reference, { iterations = 1000, seed = 20260905, confidence = .95 } = {}) {
  if (!Number.isInteger(iterations) || iterations < 0 || !Number.isInteger(seed) || !(confidence > 0 && confidence < 1)) throw new Error('Invalid bootstrap settings.');
  const a = projected.gameLosses, b = reference.gameLosses;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) throw new Error('Paired bootstrap requires matching game clusters.');
  const ids = new Set();
  for (let i = 0; i < a.length; i++) {
    if (ids.has(a[i].gameId) || a[i].gameId !== b[i].gameId || a[i].exposure !== b[i].exposure || a[i].playerGames !== b[i].playerGames) throw new Error('Paired bootstrap population mismatch.');
    ids.add(a[i].gameId);
    if (![a[i].squared, b[i].squared, a[i].exposure, a[i].playerGames].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid game loss.');
  }
  const eligibleGames = a.filter(g => g.exposure > 0).length;
  const estimate = relativeImprovement(projected.mse, reference.mse);
  const result = { method: 'paired-game-cluster-percentile', confidence, iterations, seed, eligibleGames, estimate, lower: null, upper: null, validReplicates: 0,
    interpretation: 'Conditional on fitted parameters and this held-out population; not player prediction intervals, causal effects, or uncertainty from model fitting. Games are resampled independently; serial/team dependence is not modeled.' };
  if (estimate === null) return { ...result, status: reference.exposure === 0 ? 'no-eligible-exposure' : 'zero-or-missing-reference-error' };
  if (eligibleGames < 2) return { ...result, status: 'insufficient-game-clusters' };
  if (!iterations) return { ...result, status: 'not-requested' };
  const random = randomSequence(seed), samples = [];
  // The same game is drawn for BOTH models. All appearances from that game
  // stay together, so correlated teammates are not treated as independent.
  // Each draw keeps its true opportunity weight; this is not a mean of rates.
  for (let repeat = 0; repeat < iterations; repeat++) {
    let projectedLoss = 0, referenceLoss = 0;
    for (let draw = 0; draw < a.length; draw++) {
      const i = Math.floor(random() * a.length);
      projectedLoss += a[i].squared; referenceLoss += b[i].squared;
    }
    const improvement = relativeImprovement(projectedLoss, referenceLoss);
    if (improvement !== null) samples.push(improvement);
  }
  samples.sort((x, y) => x - y);
  if (samples.length !== iterations) return { ...result, validReplicates: samples.length, status: 'undefined-bootstrap-replicates' };
  const tail = (1 - confidence) / 2;
  return { ...result, validReplicates: samples.length, lower: quantile(samples, tail), upper: quantile(samples, 1 - tail), status: 'available' };
}
