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

export const METRICS = Object.freeze({ points: 'minutes', assists: 'minutes', rebounds: 'minutes', steals: 'minutes', blocks: 'minutes', ballSecurity: 'minutes', efgPct: 'fga', threePct: 'tpa' });
const blank = () => ({ minutes: 0, games: 0, fga: 0, tpa: 0, points: 0, assists: 0, rebounds: 0, steals: 0, blocks: 0, ballSecurity: 0, efgPct: 0, threePct: 0 });

export function gameRows(archive) {
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
        const three = event.eventType?.includes('threepoint') || Number(stat.points) === 3;
        row.fga++;
        if (three) row.tpa++;
        if (stat.made) { row.points += three ? 3 : 2; row.efgPct += three ? 1.5 : 1; if (three) row.threePct++; }
      } else if (stat.type === 'freethrow') {
        if (typeof stat.made !== 'boolean') return [];
        if (stat.made) row.points++;
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
  const players = new Map(), league = blank();
  for (const game of games) for (const row of game.rows) {
    const player = players.get(row.id) || blank();
    for (const field of Object.keys(league)) { player[field] += row[field]; league[field] += row[field]; }
    players.set(row.id, player);
  }
  return { players, league };
}

export function evaluate(games, fit, metric, parameters, expandedOnly = false) {
  const denominator = METRICS[metric];
  const baseline = fit.league[metric] / fit.league[denominator];
  let squared = 0, absolute = 0, weight = 0, rows = 0;
  for (const game of games) for (const row of game.rows) {
    const p = fit.players.get(row.id);
    if (!p || !(p[denominator] > 0) || !(row[denominator] > 0) || p.games < 5) continue;
    const sourceMinutes = p.minutes / p.games;
    if (expandedOnly && !(row.minutes >= sourceMinutes + 8 && sourceMinutes < 24)) continue;
    const prediction = workloadRate({ value: p[metric] / p[denominator], baseline, sample: p[denominator], ...parameters, sourceMinutes, targetMinutes: row.minutes, lowerIsBetter: metric === 'ballSecurity' });
    const error = prediction - row[metric] / row[denominator];
    squared += row[denominator] * error * error;
    absolute += row[denominator] * Math.abs(error);
    weight += row[denominator]; rows++;
  }
  return { mse: weight ? squared / weight : null, mae: weight ? absolute / weight : null, exposure: weight, playerGames: rows };
}

export function runBenchmark(games) {
  const ordered = [...games].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (ordered.length < 100) throw new Error('At least 100 complete games are required.');
  const train = ordered.slice(0, Math.floor(ordered.length * .6));
  const tune = ordered.slice(train.length, Math.floor(ordered.length * .8));
  const test = ordered.slice(train.length + tune.length);
  const trainFit = fitProfiles(train), finalFit = fitProfiles([...train, ...tune]);
  const metrics = {};
  for (const [metric, denominator] of Object.entries(METRICS)) {
    const priors = denominator === 'minutes' ? [0, 100, 250, 500, 750, 1500] : [0, 20, 50, 100, 180, 350];
    const candidates = priors.flatMap(prior => [0, .25, .5, 1, 2].map(strength => ({ prior, strength })));
    const scored = candidates.map(parameters => ({ parameters, evaluation: evaluate(tune, trainFit, metric, parameters) }));
    scored.sort((a, b) => a.evaluation.mse - b.evaluation.mse || a.parameters.strength - b.parameters.strength || a.parameters.prior - b.parameters.prior);
    const chosen = scored[0].parameters;
    const raw = evaluate(test, finalFit, metric, { prior: 0, strength: 0 });
    const projected = evaluate(test, finalFit, metric, chosen);
    const shrinkOnly = evaluate(test, finalFit, metric, { ...chosen, strength: 0 });
    metrics[metric] = { parameters: chosen, tuning: scored[0].evaluation, test: projected, raw, shrinkOnly,
      improvementVsRaw: 1 - projected.mse / raw.mse,
      expandedRole: { projected: evaluate(test, finalFit, metric, chosen, true), raw: evaluate(test, finalFit, metric, { prior: 0, strength: 0 }, true) } };
  }
  return { version: 'chronological-workload-v1', evaluation: 'conditional production at supplied minutes; not predicted minutes or causal fatigue',
    split: { trainGames: train.length, tuningGames: tune.length, testGames: test.length, trainingEnds: train.at(-1).date, tuningEnds: tune.at(-1).date, testStarts: test[0].date, testEnds: test.at(-1).date },
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
    // Publish only scalar fitted assumptions and aggregated error metrics.
    // Retain the untouched holdout results even when they are disappointing.
    const runtime = { version: report.version, seasonEndYear: report.seasonEndYear, phase: report.phase, sourceGameIdsSha256: report.sourceGameIdsSha256, split: report.split,
      metrics: Object.fromEntries(Object.entries(report.metrics).map(([metric, row]) => [metric, { ...row.parameters, testImprovementVsRaw: row.improvementVsRaw }])) };
    fs.writeFileSync('prototypes/basketball-lineup-optimizer/workload-calibration.js', '// Generated by benchmark-lineup-workload.mjs. No player rows or private source data.\nexport const WORKLOAD_CALIBRATION = Object.freeze(' + JSON.stringify(runtime, null, 2) + ');\n');
  }
  console.log(JSON.stringify({ games: games.length, rejected, split: report.split, metrics: Object.fromEntries(Object.entries(report.metrics).map(([k, v]) => [k, { ...v.parameters, improvement: v.improvementVsRaw }])) }, null, 2));
}
