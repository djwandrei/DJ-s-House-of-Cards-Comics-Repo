import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReadinessArgs, readReadinessMetadata, runReadinessAudit } from './audit-lineup-scout-readiness.mjs';
import { buildScoutImpactModel } from '../prototypes/basketball-lineup-optimizer/scout-impact.js';
import { loadOptimizerCore } from '../prototypes/basketball-lineup-optimizer/tests/load-optimizer-core.mjs';

// These are provider IDs from the user's motivating example, not name joins.
// All coefficients are read at runtime from the validated private package;
// no licensed package rows are copied into a public fixture or browser bundle.
const GOBERT_BERINGER = [
  '37fbc3a5-0d10-4e22-803b-baa2ea0cdb12',
  '24a0f5aa-209a-4d54-91db-bddecc37f87e',
];

export async function benchmarkScoutPackagePair(manifest, pairIds = GOBERT_BERINGER) {
  const model = manifest.rapm.offenseDefense;
  const nativeRows = new Map(model.players.map(row => [row.providerPlayerId, row]));
  assert.equal(nativeRows.size, model.players.length, 'Duplicate provider player IDs.');
  assert.equal(pairIds.length, 2);
  assert.equal(new Set(pairIds).size, 2);
  const pair = pairIds.map(id => {
    const row = nativeRows.get(id);
    assert.ok(row?.displayEligible === true, `Case player ${id} needs eligible package evidence.`);
    return row;
  });

  // Six explicitly synthetic, fixed-minute anchors isolate the centers'
  // marginal objective. Their positions and rates are test conditions, NOT
  // researched teammates, a recommended rotation, or a workload prediction.
  const anchors = Array.from({ length: 6 }, (_, index) => ({
    id: `synthetic-anchor-${index}`, name: `Synthetic anchor ${index + 1}`,
    positions: [index < 3 ? 'G' : 'F'],
  }));
  const players = [...anchors, ...pair.map(row => ({
    id: row.providerPlayerId, name: row.playerName, positions: ['C'],
  }))].map(row => ({
    team: 'TEST', age: 25, games: 1, starts: 0, minutes: 24,
    points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0,
    turnovers: 0, fgPct: 0, threePct: 0, efgPct: 0, ftPct: 0, ...row,
  }));
  const evidence = {
    model,
    players: Object.fromEntries([
      ...anchors.map(row => [row.id, { offense: 0, defense: 0, reliability: 1, displayEligible: true }]),
      ...pair.map(row => [row.providerPlayerId, row]),
    ]),
  };
  const impact = buildScoutImpactModel(players, evidence, { mode: 'scout' });
  assert.equal(impact.available, true, impact.reason);
  for (const row of pair) {
    assert.equal(impact.impactsById.get(row.providerPlayerId).offense, row.offensiveRapmPer100, 'Ridge must not shrink twice.');
    assert.equal(impact.impactsById.get(row.providerPlayerId).defense, row.defensiveRapmPer100, 'Ridge must not shrink twice.');
  }
  const { optimizeLineups } = await loadOptimizerCore();
  const cases = [];
  for (const side of ['balanced', 'offense', 'defense']) {
    const value = row => side === 'offense' ? row.offensiveRapmPer100
      : side === 'defense' ? row.defensiveRapmPer100 : row.offensiveRapmPer100 + row.defensiveRapmPer100;
    // Enumerate every feasible center allocation independently of the solver.
    // Compare objectives, not a hand-picked winner or a presumed NBA rotation.
    let exactValue = -Infinity;
    for (let firstMinutes = 8; firstMinutes <= 40; firstMinutes++) {
      exactValue = Math.max(exactValue, (firstMinutes * value(pair[0]) + (48 - firstMinutes) * value(pair[1])) / 48);
    }
    const result = optimizeLineups(players, {
      mode: 'rotation', size: 8, alternatives: 1, minGames: 0, minMinutes: 0,
      modelMode: 'scout', scoutObjective: side, scoutEvidence: evidence,
      rotationOptions: {
        minMinutes: 8, maxMinutes: 40, scoringBasis: 'per36', minutePlan: 'openWhatIf',
        positionMinuteRequirements: { G: 96, F: 96, C: 48 },
        playerBounds: Object.fromEntries(anchors.map(row => [row.id, { min: 32, max: 32 }])),
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    const additive = result.best.modelAdjustments.scoutImpact.additiveImpactPer100;
    const achieved = side === 'balanced' ? additive.net : additive[side];
    assert.ok(Math.abs(achieved - exactValue) < 1e-8, `${side} must match exhaustive enumeration.`);
    assert.equal(result.best.rotation.totalMinutes, 240);
    assert.equal(additive.validatedLineupForecast, false);
    cases.push({ objective: side, passed: true, objectiveMatchesExhaustiveSearch: true,
      higherMarginalEstimate: value(pair[0]) === value(pair[1]) ? 'tie'
        : pair[value(pair[0]) > value(pair[1]) ? 0 : 1].playerName });
  }
  return {
    status: 'passed', cases,
    caseType: 'real_package_coefficients_in_synthetic_constraint_fixture',
    limitations: 'Tests objective plumbing and exactness only. Does not fit usage response, recommend minutes, certify causal impact, or establish better NBA lineup predictions.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const readiness = await runReadinessAudit(args);
    assert.equal(readiness.readyForIntegrationReview, true, JSON.stringify(readiness));
    const { manifest: manifestPath } = parseReadinessArgs(args);
    const { data: manifest, sha256 } = await readReadinessMetadata(manifestPath);
    // Recheck the report binding after reopening, instead of assuming a path
    // still contains the same manifest that the readiness call inspected.
    const { data: report } = await readReadinessMetadata(parseReadinessArgs(args).packageValidation);
    assert.equal(sha256, report.inputSha256, 'Manifest changed since validation.');
    process.stdout.write(`${JSON.stringify({ manifestSha256: sha256, ...await benchmarkScoutPackagePair(manifest) }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Scout package benchmark failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
