import { sampleEvidence, validStudioScope } from './studio-analysis.js?v=20260906a';
import { scoutContextDescriptor } from './context-contract.js?v=20260907a';

export const GAME_LAB_POLICY = Object.freeze({ version: 'scout-possession-scenario-v1', seasons: Object.freeze([2020, 2021, 2022, 2023, 2024, 2025]),
  minSidePossessions: 200, minPossessions: 60, maxPossessions: 140, minTrials: 100, maxTrials: 5000, maxOvertimes: 6 });
const count = value => Number.isSafeInteger(value) && value >= 0;
const round = value => Math.round(value * 10000) / 10000;
const validSeed = value => typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,80}$/.test(value);

function seedNumber(seed) {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}
function randomStream(seed) {
  let value = seedNumber(seed);
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let bits = value;
    bits = Math.imul(bits ^ (bits >>> 15), bits | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  };
}

export function createScenarioRandom(seed) {
  if (!validSeed(seed)) throw new Error('Use a valid repeatable seed.');
  return randomStream(seed);
}

export function dailyMatchup(teams, snapshot, date) {
  if (!Array.isArray(teams) || teams.length < 2 || teams.length > 30
    || teams.some(team => !validStudioScope({ snapshot, team: team?.id }))
    || new Set(teams.map(team => team.id)).size !== teams.length) throw new Error('Load the Scout team list first.');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
    || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Choose a valid challenge date.');
  const ordered = [...teams].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const seed = `game-v1-${date}-${snapshot}`, random = randomStream(seed);
  const first = Math.floor(random() * ordered.length);
  let second = Math.floor(random() * (ordered.length - 1)); if (second >= first) second++;
  return { a: ordered[first].id, b: ordered[second].id,
    season: GAME_LAB_POLICY.seasons[Math.floor(random() * GAME_LAB_POLICY.seasons.length)], seed, date, modelVersion: GAME_LAB_POLICY.version };
}

export function possessionDistribution(raw, expectedPossessions) {
  const unavailable = reason => ({ status: 'unavailable', reason, outcomes: [], mean: null });
  if (!raw || !count(raw.possessions) || raw.possessions !== expectedPossessions
    || raw.possessions < GAME_LAB_POLICY.minSidePossessions || !count(raw.points)) {
    return unavailable('This side needs at least 200 verified possessions with recorded point totals.');
  }
  const keys = ['empty', 'one', 'two', 'three', 'fourPlus'];
  if (keys.some(key => !count(raw.counts?.[key]))
    || keys.reduce((sum, key) => sum + raw.counts[key], 0) !== raw.possessions) {
    return unavailable('The possession outcome counts do not reconcile to the sample.');
  }
  const tailCount = raw.counts.fourPlus;
  const tailPoints = raw.points - raw.counts.one - 2 * raw.counts.two - 3 * raw.counts.three;
  if (tailPoints < 4 * tailCount || (!tailCount && tailPoints !== 0) || tailPoints > 20 * tailCount) {
    return unavailable('The point total does not reconcile to the bounded possession outcomes.');
  }
  const weights = new Map(keys.slice(0, 4).map((key, points) => [points, raw.counts[key] / raw.possessions]));
  // Scout stores one 4+ bucket. Two neighboring integer totals preserve its
  // observed mean without claiming that its unavailable tail shape is known.
  const tailMean = tailCount ? tailPoints / tailCount : null;
  if (tailCount) {
    const lower = Math.floor(tailMean), fraction = tailMean - lower, mass = tailCount / raw.possessions;
    weights.set(lower, mass * (1 - fraction));
    if (fraction > 0) weights.set(lower + 1, mass * fraction);
  }
  return { status: 'ready', possessions: raw.possessions, points: raw.points, mean: raw.points / raw.possessions,
    outcomes: [...weights].filter(([, probability]) => probability > 0).map(([points, probability]) => ({ points, probability })),
    tailCount, tailMean, reason: 'Observed possession counts with an explicit approximation for the 4+ point bucket.' };
}

export function teamGameEvidence(payload, season) {
  if (!validStudioScope(payload) || !GAME_LAB_POLICY.seasons.includes(season)
    || !Array.isArray(payload.contexts) || payload.contexts.length > 64) throw new Error('Choose a supported team, snapshot and game season.');
  const keys = new Set();
  for (const row of payload.contexts) {
    if (!scoutContextDescriptor(row?.key) || keys.has(row.key)) throw new Error('Team context evidence is unsupported or duplicated.');
    keys.add(row.key);
  }
  const row = payload.contexts.find(row => row.key === `season:${season}`);
  const sample = sampleEvidence(row);
  const offense = possessionDistribution(row?.outcomes?.offense, sample.offensePossessions);
  const defense = possessionDistribution(row?.outcomes?.defense, sample.defensePossessions);
  const ready = sample.status === 'observed' && offense.status === 'ready' && defense.status === 'ready'
    && Math.abs(offense.mean * 100 - sample.offensiveRating) <= 0.011
    && Math.abs(defense.mean * 100 - sample.defensiveRating) <= 0.011;
  return { snapshot: payload.snapshot, team: payload.team, season, sample, offense, defense,
    status: ready ? 'ready' : 'unavailable', reason: ready ? 'Recorded scoring and points-allowed samples reconcile.'
      : !row ? 'No observed possessions are available for this team and season.'
        : offense.status !== 'ready' ? offense.reason : defense.status !== 'ready' ? defense.reason
          : 'Observed ratings and possession outcomes do not clear the same sample checks.' };
}

function mix(first, second, weight) {
  const masses = new Map();
  for (const [source, share] of [[first, weight], [second, 1 - weight]]) {
    source.outcomes.forEach(({ points, probability }) => masses.set(points, (masses.get(points) || 0) + probability * share));
  }
  let cumulative = 0;
  const outcomes = [...masses].sort((a, b) => a[0] - b[0]).filter(([, mass]) => mass > 0)
    .map(([points, probability]) => ({ points, probability, cumulative: cumulative += probability }));
  outcomes.at(-1).cumulative = 1;
  return { mean: weight * first.mean + (1 - weight) * second.mean, outcomes };
}
function draw(distribution, random) {
  const value = random();
  return distribution.outcomes.find(outcome => value < outcome.cumulative).points;
}
function playGame(first, second, possessions, random, keepTimeline = false) {
  let a = 0, b = 0, overtimes = 0;
  const timeline = [];
  for (let index = 1; index <= possessions; index++) {
    a += draw(first, random); b += draw(second, random);
    if (keepTimeline && [1, 2, 3, 4].some(quarter => index === Math.round(quarter * possessions / 4))) {
      timeline.push({ period: `Q${timeline.length + 1}`, a, b });
    }
  }
  while (a === b && overtimes < GAME_LAB_POLICY.maxOvertimes) {
    overtimes++;
    for (let index = 0; index < Math.max(1, Math.round(possessions * 5 / 48)); index++) {
      a += draw(first, random); b += draw(second, random);
    }
    if (keepTimeline) timeline.push({ period: `OT${overtimes}`, a, b });
  }
  return { a, b, margin: a - b, winner: a > b ? 'a' : b > a ? 'b' : 'unresolved', overtimes, timeline };
}

// Reusable validated matchup for bounded season experiments. Compile once per
// pairing, then draw games without reparsing contexts or changing the model.
export function createGameSampler({ a, b, season, possessions = 100, attackWeight = 0.5 }) {
  if (!Number.isInteger(possessions) || possessions < 60 || possessions > 140
    || !Number.isFinite(attackWeight) || attackWeight < 0 || attackWeight > 1) throw new Error('Invalid game assumptions.');
  if (a?.snapshot !== b?.snapshot || a?.team === b?.team) throw new Error('Use different teams from one Scout snapshot.');
  const first = teamGameEvidence(a, season), second = teamGameEvidence(b, season);
  if (first.status !== 'ready' || second.status !== 'ready') throw new Error(first.status !== 'ready' ? first.reason : second.reason);
  const offense = mix(first.offense, second.defense, attackWeight), defense = mix(second.offense, first.defense, attackWeight);
  return Object.freeze({
    play(random) {
      if (typeof random !== 'function') throw new Error('A seeded random stream is required.');
      return playGame(offense, defense, possessions, random);
    },
  });
}
function quantiles(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return Object.fromEntries([10, 50, 90].map(percent => [percent, ordered[Math.max(0, Math.ceil(ordered.length * percent / 100) - 1)]]));
}
const MARGIN_BINS = Object.freeze([
  ['B by 20+', -Infinity, -20], ['B by 10–19', -19, -10], ['B by 1–9', -9, -1],
  ['Unresolved tie', 0, 0], ['A by 1–9', 1, 9], ['A by 10–19', 10, 19], ['A by 20+', 20, Infinity],
]);

export async function simulateMatchup({ a, b, season, seed, possessions = 100, trials = 1000, attackWeight = 0.5, format = 'game' },
  { yieldEveryBatch = async () => {}, signal, onProgress = () => {} } = {}) {
  if (!validSeed(seed) || !Number.isInteger(possessions) || possessions < GAME_LAB_POLICY.minPossessions || possessions > GAME_LAB_POLICY.maxPossessions
    || !Number.isInteger(trials) || trials < GAME_LAB_POLICY.minTrials || trials > GAME_LAB_POLICY.maxTrials
    || !Number.isFinite(attackWeight) || attackWeight < 0 || attackWeight > 1 || !['game', 'best_of_7'].includes(format)) {
    throw new Error('Use 60–140 possessions, 100–5,000 trials, an offense weight from 0 to 1, and a valid seed.');
  }
  if (a?.snapshot !== b?.snapshot || a?.team === b?.team) throw new Error('Use two different teams from the same Scout snapshot.');
  const first = teamGameEvidence(a, season), second = teamGameEvidence(b, season);
  if (first.status !== 'ready' || second.status !== 'ready') throw new Error(first.status !== 'ready' ? `Team A: ${first.reason}` : `Team B: ${second.reason}`);
  const scoringA = mix(first.offense, second.defense, attackWeight), scoringB = mix(second.offense, first.defense, attackWeight);
  const random = randomStream(seed), wins = { a: 0, b: 0, unresolved: 0 }, lengths = { 4: 0, 5: 0, 6: 0, 7: 0 };
  const margins = [], scoresA = [], scoresB = [];
  let example = null, sumA = 0, sumB = 0, overtimeGames = 0, gamesPlayed = 0;
  for (let trial = 0; trial < trials; trial++) {
    if (signal?.aborted) throw new DOMException('Simulation cancelled.', 'AbortError');
    const seriesWins = { a: 0, b: 0 }, series = [];
    let winner = 'unresolved';
    for (let game = 0; game < (format === 'game' ? 1 : 7); game++) {
      const result = playGame(scoringA, scoringB, possessions, random, trial === 0 && game === 0);
      gamesPlayed++; if (result.overtimes) overtimeGames++;
      if (trial === 0) series.push(result);
      if (game === 0) { scoresA.push(result.a); scoresB.push(result.b); margins.push(result.margin); sumA += result.a; sumB += result.b; }
      if (format === 'game') { winner = result.winner; break; }
      if (result.winner === 'unresolved') break;
      seriesWins[result.winner]++;
      if (seriesWins[result.winner] === 4) { winner = result.winner; lengths[game + 1]++; break; }
    }
    wins[winner]++;
    if (trial === 0) example = { winner, seriesWins, games: series };
    if ((trial + 1) % 100 === 0) { onProgress((trial + 1) / trials); await yieldEveryBatch(); }
  }
  if (signal?.aborted) throw new DOMException('Simulation cancelled.', 'AbortError');
  return { status: 'complete', modelVersion: GAME_LAB_POLICY.version, snapshot: a.snapshot, teams: [a.team, b.team], season, seed,
    settings: { possessions, trials, attackWeight, format, maxOvertimes: GAME_LAB_POLICY.maxOvertimes },
    evidence: { a: first, b: second }, expectedRegulationScore: { a: round(scoringA.mean * possessions), b: round(scoringB.mean * possessions) },
    wins, shares: Object.fromEntries(Object.entries(wins).map(([key, value]) => [key, value / trials])),
    monteCarloStandardErrorA: Math.sqrt((wins.a / trials) * (1 - wins.a / trials) / trials),
    firstGame: { averageA: round(sumA / trials), averageB: round(sumB / trials), scoreA: quantiles(scoresA), scoreB: quantiles(scoresB), margin: quantiles(margins),
      histogram: MARGIN_BINS.map(([label, lower, upper]) => ({ label, count: margins.filter(value => value >= lower && value <= upper).length })) },
    seriesLengths: lengths, overtimeGames, gamesPlayed, example,
    note: 'These frequencies are conditional on the chosen empirical blend and independent possessions. Monte Carlo error measures repetition noise only. Opponent adjustment, roster changes, fatigue, injuries, coaching, travel and parameter uncertainty are not fitted here.' };
}
