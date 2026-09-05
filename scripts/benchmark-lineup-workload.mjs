/**
 * Offline, reproducible rate backtest; raw licensed game files never leave disk.
 * Split whole games chronologically into train/tune/test. Choose parameters on
 * tuning games ONLY; refit player means on train+tune, then evaluate once on
 * untouched test games. Observed test minutes define the requested exposure,
 * not a target minute plan. This is predictive evidence, never a causal claim.
 *
 * node scripts/benchmark-lineup-workload.mjs --archive <data/2025> --out <report>
 * Add --write-runtime to generate the reviewed scalar-only runtime parameters.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { workloadRate } from '../prototypes/basketball-lineup-optimizer/workload-model.js';
import { chronologicalSplit, validateGames, pairedGameBootstrap, relativeImprovement } from './lib/lineup-workload-validation.mjs';

export const METRICS = Object.freeze({ points: 'minutes', assists: 'minutes', rebounds: 'minutes', steals: 'minutes', blocks: 'minutes', ballSecurity: 'minutes', efgPct: 'fga', threePct: 'tpa' });
const blank = () => ({ minutes: 0, games: 0, fga: 0, tpa: 0, fta: 0, ftm: 0, points: 0, assists: 0, rebounds: 0, steals: 0, blocks: 0, ballSecurity: 0, efgPct: 0, threePct: 0 });
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = value => nonnegative(value) && value > 0;
const evidence = () => Object.fromEntries(Object.keys(METRICS).map(metric => [metric, { numerator: 0, exposure: 0, games: 0 }]));

// These descriptive slices are fixed before looking at held-out outcomes.
// They diagnose a model; they do NOT cap players' minutes in the optimizer.
export const SUBGROUPS = Object.freeze({
  lowSample: { definition: '5-19 valid training appearances for this metric', matches: (p, e) => e.games < 20 },
  establishedSample: { definition: '20+ valid training appearances for this metric', matches: (p, e) => e.games >= 20 },
  lowMinutes: { definition: 'Training observed MPG below 16', matches: p => p.minutes / p.games < 16 },
  rotationMinutes: { definition: 'Training observed MPG from 16 to below 28', matches: p => p.minutes / p.games >= 16 && p.minutes / p.games < 28 },
  highMinutes: { definition: 'Training observed MPG at least 28', matches: p => p.minutes / p.games >= 28 },
});

export function gameRows(archive) {
  // A Map would silently keep only the last duplicate player. Reject the
  // entire ambiguous game before constructing benchmark ground truth.
  const active = archive.players.filter(p => p.minutesPlayed > 0);
  if (new Set(active.map(p => p.id)).size !== active.length || active.some(p => typeof p.id !== 'string' || !p.id)) return [];
  const rows = new Map(archive.players.filter(p => p.minutesPlayed > 0).map(p => [p.id, { ...blank(), id: p.id, team: p.providerTeamId, minutes: p.minutesPlayed, games: 1 }]));
  const seen = new Set();
  for (const event of archive.events || []) {
    if (event.isRescinded || seen.has(event.id)) continue;
    seen.add(event.id);
    for (const stat of event.statistics || []) {
      const row = rows.get(stat.player?.id);
      if (!row) continue;
      if (stat.type === 'fieldgoal') {
        if (typeof stat.made !== 'boolean') return [];
        const three = typeof stat.three_point_shot === 'boolean' ? stat.three_point_shot : event.eventType?.includes('threepoint') || Number(stat.points) === 3;
        row.fga++;
        if (three) row.tpa++;
        if (stat.made) { row.points += three ? 3 : 2; row.efgPct += three ? 1.5 : 1; if (three) row.threePct++; }
      } else if (stat.type === 'freethrow') {
        if (typeof stat.made !== 'boolean') return [];
        // Keep attempts as evidence for future offensive-load work. They do
        // not become a fitted usage variable or reveal future shot allocation.
        row.fta++;
        if (stat.made) { row.points++; row.ftm++; }
      } else if (['assist', 'rebound', 'steal', 'block', 'turnover'].includes(stat.type)) {
        row[({ assist: 'assists', rebound: 'rebounds', steal: 'steals', block: 'blocks', turnover: 'ballSecurity' })[stat.type]]++;
      }
    }
  }
  // Incomplete or inconsistent event scoring is unsuitable ground truth.
  for (const [team, points] of [[archive.game.homeProviderTeamId, archive.game.homePoints], [archive.game.awayProviderTeamId, archive.game.awayPoints]]) {
    if ([...rows.values()].filter(r => r.team === team).reduce((n, r) => n + r.points, 0) !== points) return [];
  }
  return [...rows.values()].map(row => ({ ...row, gameId: archive.game.providerGameId, date: archive.game.scheduledAt }));
}

export function fitProfiles(games) {
  validateGames(games);
  const players = new Map(), league = blank();
  const metricEvidence = { players: new Map(), league: evidence() };
  for (const game of games) for (const row of game.rows) {
    const player = players.get(row.id) || blank();
    // Do not turn null into zero or add a missing metric's minutes to its
    // denominator. Every metric gets its own paired numerator/exposure bank.
    if (!positive(row.minutes)) continue;
    for (const field of Object.keys(league)) {
      const value = field === 'games' ? 1 : row[field];
      if (nonnegative(value)) { player[field] += value; league[field] += value; }
    }
    const sample = metricEvidence.players.get(row.id) || evidence();
    for (const [metric, denominator] of Object.entries(METRICS)) {
      if (!nonnegative(row[metric]) || !positive(row[denominator])) continue;
      for (const bank of [sample, metricEvidence.league]) {
        bank[metric].numerator += row[metric]; bank[metric].exposure += row[denominator]; bank[metric].games++;
      }
    }
    metricEvidence.players.set(row.id, sample);
    players.set(row.id, player);
  }
  return { players, league, metricEvidence, sourceGameIds: new Set(games.map(game => game.id)),
    trainingThroughUtcDay: games.length ? games.map(game => new Date(game.date).toISOString().slice(0, 10)).sort().at(-1) : null };
}

export function evaluate(games, fit, metric, parameters, expandedOnly = false) {
  validateGames(games);
  // Protect direct callers as well as runBenchmark's split. Reusing an
  // appearance, or evaluating on a day already used to fit means, leaks data.
  if (games.some(game => fit.sourceGameIds.has(game.id) || (fit.trainingThroughUtcDay && new Date(game.date).toISOString().slice(0, 10) <= fit.trainingThroughUtcDay))) throw new Error('Held-out games must be strictly after all training UTC dates and absent from training identities.');
  const denominator = METRICS[metric];
  if (!denominator) throw new Error(`Unknown metric: ${metric}`);
  const options = typeof expandedOnly === 'object' && expandedOnly !== null ? expandedOnly : { expandedOnly };
  if (options.subgroup && !SUBGROUPS[options.subgroup]) throw new Error(`Unknown subgroup: ${options.subgroup}`);
  const league = fit.metricEvidence.league[metric];
  const baseline = positive(league.exposure) ? league.numerator / league.exposure : null;
  let squared = 0, absolute = 0, weight = 0, rows = 0;
  const exclusions = { missingLeagueBaseline: 0, unknownPlayer: 0, missingTrainingDenominator: 0, insufficientTrainingGames: 0, missingTargetDenominator: 0, missingTargetNumerator: 0, invalidMinutes: 0, outsideSubgroup: 0, invalidPrediction: 0 };
  const gameLosses = [];
  let considered = 0;
  for (const game of games) {
    const loss = { gameId: game.id, squared: 0, exposure: 0, playerGames: 0 };
    for (const row of game.rows) {
    considered++;
    if (baseline === null) { exclusions.missingLeagueBaseline++; continue; }
    const p = fit.players.get(row.id);
    if (!p) { exclusions.unknownPlayer++; continue; }
    const sample = fit.metricEvidence.players.get(row.id)[metric];
    if (!positive(sample.exposure)) { exclusions.missingTrainingDenominator++; continue; }
    if (sample.games < 5) { exclusions.insufficientTrainingGames++; continue; }
    if (!positive(row[denominator])) { exclusions.missingTargetDenominator++; continue; }
    if (!nonnegative(row[metric])) { exclusions.missingTargetNumerator++; continue; }
    if (!positive(row.minutes)) { exclusions.invalidMinutes++; continue; }
    const sourceMinutes = p.minutes / p.games;
    if ((options.expandedOnly && !(row.minutes >= sourceMinutes + 8 && sourceMinutes < 24)) || (options.subgroup && !SUBGROUPS[options.subgroup].matches(p, sample))) { exclusions.outsideSubgroup++; continue; }
    const prediction = workloadRate({ value: sample.numerator / sample.exposure, baseline, sample: sample.exposure, ...parameters, sourceMinutes, targetMinutes: row.minutes, lowerIsBetter: metric === 'ballSecurity' });
    if (!nonnegative(prediction)) { exclusions.invalidPrediction++; continue; }
    const error = prediction - row[metric] / row[denominator];
    squared += row[denominator] * error * error;
    absolute += row[denominator] * Math.abs(error);
    weight += row[denominator]; rows++;
    loss.squared += row[denominator] * error * error; loss.exposure += row[denominator]; loss.playerGames++;
    }
    gameLosses.push(loss);
  }
  const result = { mse: weight ? squared / weight : null, mae: weight ? absolute / weight : null, exposure: weight, playerGames: rows,
    eligibility: { consideredPlayerGames: considered, minimumTrainingAppearances: 5, exclusions } };
  // Per-game sufficient statistics are optional and stay in memory for paired
  // resampling. The persisted report contains only aggregated evaluations.
  if (options.includeGameLosses) result.gameLosses = gameLosses;
  return result;
}

export function runBenchmark(games, { bootstrapIterations = 1000, bootstrapSeed = 20260905 } = {}) {
  const { ordered, train, tune, test } = chronologicalSplit(games);
  const trainFit = fitProfiles(train), finalFit = fitProfiles([...train, ...tune]);
  const metrics = {};
  const compare = (metric, chosen, selection = {}) => {
    const options = { ...selection, includeGameLosses: true };
    const projected = evaluate(test, finalFit, metric, chosen, options);
    const raw = evaluate(test, finalFit, metric, { prior: 0, strength: 0 }, options);
    const shrinkOnly = evaluate(test, finalFit, metric, { ...chosen, strength: 0 }, options);
    const bootstrap = { iterations: bootstrapIterations, seed: bootstrapSeed };
    const uncertainty = { vsRaw: pairedGameBootstrap(projected, raw, bootstrap), vsShrinkOnly: pairedGameBootstrap(projected, shrinkOnly, bootstrap) };
    for (const row of [projected, raw, shrinkOnly]) delete row.gameLosses;
    return { projected, raw, shrinkOnly, improvementVsRaw: relativeImprovement(projected.mse, raw.mse), improvementVsShrinkOnly: relativeImprovement(projected.mse, shrinkOnly.mse), uncertainty };
  };
  for (const [metric, denominator] of Object.entries(METRICS)) {
    const priors = denominator === 'minutes' ? [0, 100, 250, 500, 750, 1500] : [0, 20, 50, 100, 180, 350];
    const candidates = priors.flatMap(prior => [0, .25, .5, 1, 2].map(strength => ({ prior, strength })));
    const scored = candidates.map(parameters => ({ parameters, evaluation: evaluate(tune, trainFit, metric, parameters) }));
    // Null MSE means no evaluation, never a perfect zero-error candidate.
    scored.sort((a, b) => (a.evaluation.mse ?? Infinity) - (b.evaluation.mse ?? Infinity) || a.parameters.strength - b.parameters.strength || a.parameters.prior - b.parameters.prior);
    if (scored[0].evaluation.mse === null) {
      metrics[metric] = { status: 'unavailable-no-eligible-tuning-rows', parameters: null, tuning: scored[0].evaluation, test: null, raw: null, shrinkOnly: null, improvementVsRaw: null, improvementVsShrinkOnly: null, expandedRole: null, subgroups: null, uncertainty: null };
      continue;
    }
    const chosen = scored[0].parameters;
    const { projected, ...comparison } = compare(metric, chosen);
    metrics[metric] = { status: projected.exposure ? 'evaluated' : 'unavailable-no-eligible-test-rows', parameters: chosen, tuning: scored[0].evaluation, test: projected, ...comparison,
      expandedRole: { definition: 'Descriptive, outcome-conditioned slice: supplied test MPG at least 8 above training MPG, with training MPG below 24; not a pre-outcome subgroup.', ...compare(metric, chosen, { expandedOnly: true }) },
      subgroups: Object.fromEntries(Object.entries(SUBGROUPS).map(([key, group]) => [key, { definition: group.definition, ...compare(metric, chosen, { subgroup: key }) }])) };
  }
  return { version: 'chronological-workload-v2', evaluation: 'conditional production at supplied minutes; not predicted minutes or causal fatigue',
    validation: { grain: 'one player appearance per game', metricWeighting: METRICS, subgroupEvidence: 'train+tune appearances only; independent of held-out outcomes except the explicitly labeled legacy expandedRole slice', bootstrap: 'paired whole-game percentile intervals conditional on fitted parameters; exploratory subgroup intervals are not multiplicity-adjusted', missingEvidence: 'excluded explicitly per metric; missing numerators never become zeros',
      sourceCoverage: 'Eligible archived games only; accumulated exposure is not a verified complete NBA season.',
      sourceReconciliation: 'The archive adapter reconciles reconstructed player scoring to final team scores. Independent official player/team boxscore totals are not retained in this archive, so all-metric reconciliation is unavailable. Team-only rebounds and turnovers are not assigned to players.' },
    split: { method: 'nearest-60-20-20-whole-UTC-calendar-days', timezone: 'UTC', trainGames: train.length, tuningGames: tune.length, testGames: test.length, trainingEnds: train.at(-1).date, tuningEnds: tune.at(-1).date, testStarts: test[0].date, testEnds: test.at(-1).date },
    sourceGameIdsSha256: crypto.createHash('sha256').update(ordered.map(g => g.id).join('\n')).digest('hex'), metrics };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => process.argv[process.argv.indexOf(flag) + 1];
  if (!process.argv.includes('--archive') || !process.argv.includes('--out')) throw new Error('--archive and --out are required.');
  const root = path.resolve(value('--archive'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  const games = []; let rejected = 0;
  for (const entry of Object.values(manifest.games)) {
    if (entry.status !== 'completed' || entry.primaryPhase !== 'regular' || !entry.eligibleForPublication) continue;
    const filename = path.resolve(root, entry.gameFile);
    if (!filename.startsWith(root + path.sep)) throw new Error('Archive traversal refused.');
    const game = JSON.parse(zlib.gunzipSync(fs.readFileSync(filename)));
    const rows = gameRows(game);
    if (!rows.length) { rejected++; continue; }
    games.push({ id: game.game.providerGameId, date: game.game.scheduledAt, rows });
  }
  const report = { ...runBenchmark(games), seasonEndYear: manifest.seasonEndYear, phase: 'regular', rejectedIncompleteGames: rejected };
  const out = path.resolve(value('--out')); fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  if (process.argv.includes('--write-runtime')) {
    if (Object.values(report.metrics).some(row => !row.parameters || row.test?.mse === null)) throw new Error('Incomplete metric validation cannot be published as runtime calibration.');
    // Publish only scalar fitted assumptions and aggregated error metrics.
    // Retain the untouched holdout results even when they are disappointing.
    const runtime = { version: report.version, seasonEndYear: report.seasonEndYear, phase: report.phase, sourceGameIdsSha256: report.sourceGameIdsSha256, split: report.split,
      metrics: Object.fromEntries(Object.entries(report.metrics).map(([metric, row]) => [metric, { ...row.parameters, testImprovementVsRaw: row.improvementVsRaw }])) };
    fs.writeFileSync('prototypes/basketball-lineup-optimizer/workload-calibration.js', '// Generated by benchmark-lineup-workload.mjs. No player rows or private source data.\nexport const WORKLOAD_CALIBRATION = Object.freeze(' + JSON.stringify(runtime, null, 2) + ');\n');
  }
  console.log(JSON.stringify({ games: games.length, rejected, split: report.split, metrics: Object.fromEntries(Object.entries(report.metrics).map(([k, v]) => [k, { ...v.parameters, improvement: v.improvementVsRaw }])) }, null, 2));
}
