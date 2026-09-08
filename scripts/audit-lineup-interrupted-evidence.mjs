/** Offline development audit. Never promotes an interrupted Scout package. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { compileScoutPlayerGameEvidence, shootingOpportunity } from '../prototypes/basketball-lineup-optimizer/projection-evidence.js';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '../outputs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function auditInterruptedEvidence({ buildDir, sourceValidation, output }) {
  for (const target of [buildDir, sourceValidation, output]) assert.ok(path.resolve(target).startsWith(`${ROOT}${path.sep}`), 'Keep artifacts private.');
  const validationBytes = await fs.readFile(sourceValidation), source = JSON.parse(validationBytes);
  assert.equal(source.passed, true);
  const bindingBytes = await fs.readFile(path.join(buildDir, 'rebuild-binding.json'));
  const binding = JSON.parse(bindingBytes);
  for (const target of [binding.archive, binding.overlay]) if (target) assert.ok(path.resolve(target).startsWith(`${ROOT}${path.sep}`));
  const report = { version: 'lineup-interrupted-evidence-audit-v1', generatedAt: new Date().toISOString(),
    inputBuild: path.resolve(buildDir), inputBindingSha256: sha(bindingBytes), sourceValidationSha256: sha(validationBytes),
    packagePromoted: false, coefficientsFitted: false, seasons: [],
    caveat: 'Frozen interrupted player-game checkpoints only. Checks source/overlay hashes and component pairing, not complete-package or holdout validation. Missing seasons remain unavailable.' };
  for (const season of source.seasons) {
    const directory = path.join(buildDir, 'model-evidence/checkpoints', String(season.seasonStartYear));
    let files;
    try { files = (await fs.readdir(directory)).filter(name => name.endsWith('.json.gz')).sort(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    const descriptors = new Map(season.files.records.map(row => [row.gameId, row]));
    const groups = new Map(); let playerGames = 0;
    for (const name of files) {
      const row = JSON.parse(gunzipSync(await fs.readFile(path.join(directory, name))));
      const gameId = name.slice(0, -8), descriptor = descriptors.get(gameId);
      assert.ok(descriptor, 'Checkpoint absent from the requested attestation.');
      assert.equal(row.sourceGzipSha256, descriptor.gzipSha256, 'Checkpoint source binding changed.');
      if (row.summaryOverlaySha256) {
        assert.ok(binding.overlay);
        const overlayBytes = await fs.readFile(path.join(binding.overlay, String(season.seasonStartYear), `${gameId}.json`));
        assert.equal(sha(overlayBytes), row.summaryOverlaySha256, 'Checkpoint Summary binding changed.');
      }
      for (const player of row.players) {
        assert.equal(player.gameId, gameId); assert.equal(player.seasonStartYear, season.seasonStartYear);
        const key = `${player.playerId}~${player.phase}`;
        if (!groups.has(key)) groups.set(key, []);
        // Retain only the fields used by the compiler, not the large shot/event
        // annotations. A season is released from memory before the next one.
        groups.get(key).push(Object.fromEntries(['gameId', 'teamId', 'playerId', 'seasonStartYear', 'phase', 'officialMinutes',
          'minutesReconciled', 'rateExposure', 'officialTotals', 'pbpTotals', 'fieldReconciliation', 'officialIdentityIssues', 'pbpIdentityIssues']
          .map(field => [field, player[field]])));
        playerGames++;
      }
    }
    const metrics = {};
    for (const rows of groups.values()) {
      const evidence = compileScoutPlayerGameEvidence(rows, { playerId: rows[0].playerId,
        seasonStartYear: season.seasonStartYear, phase: rows[0].phase, sourceRevision: path.basename(buildDir) });
      for (const [metric, coverage] of Object.entries(evidence.coverage)) {
        metrics[metric] ??= { supportedPlayerProfiles: 0, suppliedPlayerGames: 0, verifiedPlayerGames: 0, omittedPlayerGames: 0 };
        metrics[metric].suppliedPlayerGames += coverage.suppliedGames;
        metrics[metric].verifiedPlayerGames += coverage.verifiedGames;
        metrics[metric].omittedPlayerGames += coverage.omittedGameIds.length;
        const paired = evidence.metrics[metric];
        if (paired) {
          metrics[metric].supportedPlayerProfiles++;
          if (metric === 'threePct' || metric === 'efgPct') {
            assert.equal(paired.participationPer36, paired.sample * 36 / paired.minutes);
            assert.ok(shootingOpportunity(paired).decisionPer36 <= paired.participationPer36 + 1e-10);
          }
        }
      }
    }
    report.seasons.push({ seasonStartYear: season.seasonStartYear, checkpointGames: files.length, playerGames,
      playerSeasonPhaseProfiles: groups.size, available: files.length > 0, metrics });
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
  return { output, packagePromoted: false, seasons: report.seasons.map(row => ({
    seasonStartYear: row.seasonStartYear, checkpointGames: row.checkpointGames, playerGames: row.playerGames,
    verifiedShootingPlayerGames: row.metrics.threePct?.verifiedPlayerGames ?? 0,
  })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  const args = process.argv.slice(2), values = {};
  for (let index = 0; index < args.length; index += 2) {
    assert.ok(['--build-dir', '--source-validation', '--output'].includes(args[index]) && args[index + 1] && !values[args[index]]);
    values[args[index]] = path.resolve(args[index + 1]);
  }
  assert.equal(Object.keys(values).length, 3);
  console.log(JSON.stringify(await auditInterruptedEvidence({ buildDir: values['--build-dir'],
    sourceValidation: values['--source-validation'], output: values['--output'] }), null, 2));
}
