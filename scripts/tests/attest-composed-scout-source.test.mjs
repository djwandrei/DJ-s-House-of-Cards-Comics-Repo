import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { attestComposedScoutSource } from '../attest-composed-scout-source.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sourceReportFor({ year, manifestRaw, compressed }) {
  const descriptor = {
    relativePath: 'games/game.json.gz',
    byteLength: compressed.length,
    gzipSha256: sha256(compressed),
    uncompressedByteLength: 2,
    uncompressedSha256: sha256('[]'),
    normalizedJsonSha256: sha256('{}'),
    gameId: `game-${year}`,
  };
  const aggregateFileHash = sha256(stableJson([{
    relativePath: descriptor.relativePath,
    byteLength: descriptor.byteLength,
    gzipSha256: descriptor.gzipSha256,
    uncompressedByteLength: descriptor.uncompressedByteLength,
    uncompressedSha256: descriptor.uncompressedSha256,
    normalizedJsonSha256: descriptor.normalizedJsonSha256,
  }]));
  return {
    validatorVersion: 'sportradar-nba-local-archive-validator-v4',
    passed: true,
    reconstructionModules: {},
    seasons: [{
      seasonStartYear: year,
      seasonEndYear: year + 1,
      manifestSha256: sha256(manifestRaw),
      files: { expectedCompletedFiles: 1, discoveredGameFiles: 1, aggregateFileHash, records: [descriptor] },
      dataQuality: {
        gamesWithSummaryTeamScoreNonReconciliation: 0,
        gamesWithSummaryTeamOffensiveRatingAlgebraDiagnostics: 0,
        summaryTeamOffensiveRatingAlgebraDiagnostics: 0,
        gamesWithSummaryTeamDefensiveRatingAlgebraDiagnostics: 0,
        summaryTeamDefensiveRatingAlgebraDiagnostics: 0,
        gamesWithSummaryTeamPossessionSymmetryDiagnostics: 0,
        summaryTeamPossessionSymmetryDiagnostics: 0,
      },
      totals: { events: 0, stints: 0, possessions: 0, players: 0, lineups: 0 },
    }],
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-attestation-'));
  const archive = path.join(root, 'archive');
  const seasonDirectory = path.join(archive, '2024');
  const gamesDirectory = path.join(seasonDirectory, 'games');
  await fs.mkdir(gamesDirectory, { recursive: true });
  const manifest = {
    seasonStartYear: 2024,
    accessLevel: 'trial',
    uniqueEligibleGames: 1,
    games: { 'game-2024': { status: 'completed', gameFile: 'games/game.json.gz' } },
  };
  const manifestRaw = `${JSON.stringify(manifest)}\n`;
  const compressed = Buffer.from('compressed-fixture');
  await fs.writeFile(path.join(seasonDirectory, 'manifest.json'), manifestRaw);
  await fs.writeFile(path.join(gamesDirectory, 'game.json.gz'), compressed);
  const reportPath = path.join(root, 'source-report.json');
  await fs.writeFile(reportPath, JSON.stringify(sourceReportFor({ year: 2024, manifestRaw, compressed })));
  return { root, archive, reportPath, gamePath: path.join(gamesDirectory, 'game.json.gz') };
}

test('attests a composed archive against a passing source report', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  const outputDir = path.join(setup.root, 'attestation');
  const result = await attestComposedScoutSource({
    archiveDir: setup.archive,
    outputDir,
    sourceReports: [setup.reportPath],
    expectedSeasons: [2024],
  });
  assert.equal(result.report.passed, true);
  assert.equal(result.report.summary.completedGames, 1);
  assert.equal(result.report.compositionAttestation.seasons[0].expectedCompletedFiles, 1);
  assert.equal(await fs.stat(result.reportPath).then(() => true), true);
});

test('marks an altered composed game file as a failed attestation', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  await fs.writeFile(setup.gamePath, Buffer.from('altered-compressed-fixture'));
  const result = await attestComposedScoutSource({
    archiveDir: setup.archive,
    outputDir: path.join(setup.root, 'attestation'),
    sourceReports: [setup.reportPath],
    expectedSeasons: [2024],
  });
  assert.equal(result.report.passed, false);
  assert.ok(result.report.errors.some((error) => error.code === 'composed_game_gzip_hash_mismatch'));
});
