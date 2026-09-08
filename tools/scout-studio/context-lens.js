import { sampleEvidence, validateAnalysisRoster } from './studio-analysis.js?v=20260906a';
import { scoutContextDescriptor } from './context-contract.js?v=20260907a';

// Context views are deliberately descriptive. They reuse the package's
// published sample gate and never turn a split into a forecast, causal effect,
// or latent skill score.
export const CONTEXT_LENS_POLICY = Object.freeze({ maxRows: 64, maxGroups: 12 });
const CONTEXT_NOTE = 'Context rows use the same observed possession sample contract as the all-sample value. Differences from All are descriptive splits, not causal effects or forecasts. Missing and below-gate rows remain unavailable.';
const PLAYER_CONTEXT_NOTE = 'On/off context rows are descriptive same-game partitions. Different teammates, opponents, roles and situations can contribute; no causal player effect is inferred.';

const GRADES = new Set(['no_sample', 'insufficient', 'low', 'medium', 'high']);
const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
export const contextDescriptor = scoutContextDescriptor;

function unavailableSample() {
  return { status: 'unavailable', games: null, offensePossessions: null, defensePossessions: null,
    minimumCombinedPossessions: null, offensiveRating: null, defensiveRating: null, netRating: null, interval: null };
}

function normalizeRows(input, label) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input) || input.length > CONTEXT_LENS_POLICY.maxRows) {
    throw new Error(`${label} context rows exceed the bounded contract.`);
  }
  const seen = new Set();
  const rows = input.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label} context row is invalid.`);
    const descriptor = contextDescriptor(row.key);
    if (!descriptor) throw new Error(`${label} contains an unsupported context key.`);
    if (seen.has(descriptor.key)) throw new Error(`${label} repeats a context key.`);
    seen.add(descriptor.key);
    const source = row.sample && typeof row.sample === 'object' && !Array.isArray(row.sample) ? row.sample : row;
    const sample = sampleEvidence(source);
    const reliabilityScore = typeof row.reliabilityScore === 'number' && Number.isFinite(row.reliabilityScore)
      && row.reliabilityScore >= 0 && row.reliabilityScore <= 1 ? round(row.reliabilityScore) : null;
    return { ...descriptor, ...sample,
      reliabilityGrade: GRADES.has(row.reliabilityGrade) ? row.reliabilityGrade : null, reliabilityScore };
  });
  rows.sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
  return rows;
}

function difference(first, second) {
  if (first?.status !== 'observed' || second?.status !== 'observed') {
    return { offensiveRating: null, defensiveRating: null, netRating: null };
  }
  return { offensiveRating: round(first.offensiveRating - second.offensiveRating),
    defensiveRating: round(first.defensiveRating - second.defensiveRating),
    netRating: round(first.netRating - second.netRating) };
}

export function analyzeContextRows(contexts, { label = 'Sample' } = {}) {
  const rows = normalizeRows(contexts, label);
  const baseline = rows.find(row => row.key === 'all') || null;
  const groups = [...new Set(rows.map(row => row.group))];
  if (groups.length > CONTEXT_LENS_POLICY.maxGroups) throw new Error(`${label} context groups exceed the bounded contract.`);
  const status = !rows.length ? 'unavailable' : !baseline ? 'missing_baseline'
    : baseline.status !== 'observed' ? 'baseline_unavailable'
      : rows.some(row => row.status === 'observed') ? 'ready' : 'no_observed_rows';
  return { status, rows: rows.map(row => ({ ...row, differenceFromAll: row.key === 'all' ? null : difference(row, baseline) })),
    baseline, groups, note: CONTEXT_NOTE };
}

export function analyzePlayerContextLens(roster, id, payload) {
  validateAnalysisRoster(roster);
  const player = roster.players.find(candidate => candidate.id === id);
  if (!player) throw new Error('Choose a player from this team and snapshot.');
  if (!payload || payload.snapshot !== roster.snapshot || payload.team !== roster.team || payload.player !== id) {
    throw new Error('Player context evidence does not match the selected team, snapshot, and player.');
  }
  const on = normalizeRows(payload.on, 'On-court');
  const off = normalizeRows(payload.off, 'Off-court');
  const byKey = (rows) => new Map(rows.map(row => [row.key, row]));
  const onByKey = byKey(on), offByKey = byKey(off);
  const keys = [...new Set([...onByKey.keys(), ...offByKey.keys()])];
  if (keys.length > CONTEXT_LENS_POLICY.maxRows) throw new Error('Player context evidence exceeds the bounded contract.');
  keys.sort((left, right) => (contextDescriptor(left).order - contextDescriptor(right).order) || left.localeCompare(right));
  const rows = keys.map(key => {
    const descriptor = contextDescriptor(key);
    const onSample = onByKey.get(key) || { ...descriptor, ...unavailableSample(), reliabilityGrade: null, reliabilityScore: null };
    const offSample = offByKey.get(key) || { ...descriptor, ...unavailableSample(), reliabilityGrade: null, reliabilityScore: null };
    return { ...descriptor, on: onSample, off: offSample, difference: difference(onSample, offSample) };
  });
  const groups = [...new Set(rows.map(row => row.group))];
  if (groups.length > CONTEXT_LENS_POLICY.maxGroups) throw new Error('Player context groups exceed the bounded contract.');
  const status = !rows.length ? 'unavailable' : rows.some(row => row.on.status === 'observed' || row.off.status === 'observed') ? 'ready' : 'no_observed_rows';
  return { status, player: { id, name: player.name },
    onMinutes: typeof payload.onMinutes === 'number' && Number.isFinite(payload.onMinutes) && payload.onMinutes >= 0 ? payload.onMinutes : null,
    offMinutes: typeof payload.offMinutes === 'number' && Number.isFinite(payload.offMinutes) && payload.offMinutes >= 0 ? payload.offMinutes : null,
    rows, groups, note: PLAYER_CONTEXT_NOTE };
}

export function analyzeGroupContextLens(contexts) {
  return analyzeContextRows(contexts, { label: 'Group' });
}
