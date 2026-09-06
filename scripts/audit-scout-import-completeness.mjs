import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { BOX_FIELDS, buildGameModelEvidence } from './lib/nba-scout-model-evidence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROOT = path.join(ROOT, 'outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const INCLUDED_PHASES = new Set(['regular', 'in_season_tournament', 'play_in', 'playoffs']);
const optional = async file => fs.readFile(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));

export function seasonDownloadCompleteness(manifest) {
  const entries = Object.entries(manifest.games ?? {});
  const completed = entries.filter(([, row]) => row.status === 'completed').length;
  const expected = Number.isSafeInteger(manifest.uniqueEligibleGames) ? manifest.uniqueEligibleGames : null;
  const unresolved = entries.filter(([, row]) => row.status !== 'completed').map(([gameId, row]) => ({ gameId, status: row.status }));
  return { expectedGames: expected, completedGames: completed, unresolved,
    notYetAttemptedGames: expected === null ? null : Math.max(0, expected - entries.length),
    allScheduledGamesDownloaded: expected !== null && completed === expected && unresolved.length === 0 };
}

export function summarizeOfficialEvidence(record, summaryOverlay = null) {
  // This is a source-completeness audit, NOT another analytics derivation.
  // Reuse recorded exposure only for row membership. No reconstruction replay,
  // fit, coefficient update, lineup ranking, or package promotion occurs here.
  const evidence = buildGameModelEvidence(record, { summaryOverlay, replay: false });
  return {
    playerGames: evidence.players.length,
    missingOfficialPlayers: evidence.players.filter(row => row.missingOfficialFields.length).map(row => ({ playerId: row.playerId, teamId: row.teamId, fields: row.missingOfficialFields })),
    discrepancies: evidence.players.filter(row => row.mismatchedFields.length || row.officialIdentityIssues.length).map(row => ({
      playerId: row.playerId, teamId: row.teamId, fields: row.mismatchedFields, officialIdentityIssues: row.officialIdentityIssues,
    })),
    fullyReconciledPlayers: evidence.players.filter(row => row.boxScoreReconciled).length,
    perField: Object.fromEntries(BOX_FIELDS.map(field => [field, {
      expected: evidence.players.length,
      officialKnown: evidence.players.filter(row => row.officialTotals[field] !== null).length,
      matched: evidence.players.filter(row => row.fieldReconciliation[field] === 'matched').length,
      mismatched: evidence.players.filter(row => row.fieldReconciliation[field] === 'mismatch').length,
    }])),
  };
}

export async function auditScoutImportCompleteness({ overlay, output }) {
  for (const target of [overlay, output]) assert.ok(path.resolve(target).startsWith(`${PRIVATE_ROOT}${path.sep}`), 'Audit outputs must remain private.');
  const seasons = [], missingSummaryGames = [], discrepancyGames = [], fileErrors = [];
  for (const year of [2020, 2021, 2022, 2023, 2024, 2025]) {
    const directory = path.join(PRIVATE_ROOT, year < 2022 ? 'data-2020-2021-trial' : 'data-2022-2025-trial-composed', String(year));
    const manifestPath = path.join(directory, 'manifest.json');
    const raw = await fs.readFile(manifestPath), manifest = JSON.parse(raw);
    assert.equal(manifest.seasonStartYear, year);
    const season = { seasonStartYear: year, ...seasonDownloadCompleteness(manifest), manifestSha256: sha(raw),
      filesChecked: 0, gamesInModelScope: 0, otherArchivedGames: 0, summaryOverlaysUsed: 0,
      playerGames: 0, fullyReconciledPlayers: 0, missingSummaryGames: 0, discrepancyGames: 0,
      perField: Object.fromEntries(BOX_FIELDS.map(field => [field, { expected: 0, officialKnown: 0, matched: 0, mismatched: 0 }])) };
    for (const [gameId, entry] of Object.entries(manifest.games)) {
      if (entry.status !== 'completed') continue;
      try {
        const file = path.resolve(directory, entry.gameFile);
        assert.ok(file.startsWith(`${directory}${path.sep}`), 'Game path escapes its season.');
        const bytes = await fs.readFile(file), record = JSON.parse(gunzipSync(bytes));
        assert.equal(record.game.providerGameId, gameId);
        assert.equal(record.game.seasonStartYear, year);
        assert.equal(record.source.accessLevel, manifest.accessLevel);
        season.filesChecked++;
        if (!INCLUDED_PHASES.has(record.game.primaryPhase) || record.game.status !== 'closed'
          || record.teams?.length !== 2 || !record.teams.every(team => String(team.srId ?? '').startsWith('sr:team:'))) {
          season.otherArchivedGames++; continue;
        }
        season.gamesInModelScope++;
        const overlayBytes = await optional(path.join(overlay, String(year), `${gameId}.json`));
        const independent = overlayBytes ? JSON.parse(overlayBytes) : null;
        if (independent) { assert.equal(independent.sourceGzipSha256, sha(bytes)); season.summaryOverlaysUsed++; }
        const evidence = summarizeOfficialEvidence(record, independent);
        season.playerGames += evidence.playerGames;
        season.fullyReconciledPlayers += evidence.fullyReconciledPlayers;
        if (evidence.missingOfficialPlayers.length) {
          season.missingSummaryGames++;
          missingSummaryGames.push({ seasonStartYear: year, gameId, players: evidence.missingOfficialPlayers });
        }
        if (evidence.discrepancies.length) {
          season.discrepancyGames++;
          discrepancyGames.push({ seasonStartYear: year, gameId, players: evidence.discrepancies });
        }
        for (const field of BOX_FIELDS) for (const metric of Object.keys(season.perField[field])) season.perField[field][metric] += evidence.perField[field][metric];
      } catch (error) {
        fileErrors.push({ seasonStartYear: year, gameId, code: error.code ?? 'SOURCE_CHECK_FAILED' });
      }
    }
    // Imports may run during a progress audit. A changed manifest is a moving
    // checkpoint, never an attestation of a stable, finished source revision.
    season.manifestUnchangedDuringAudit = sha(await fs.readFile(manifestPath)) === season.manifestSha256;
    seasons.push(season);
    process.stdout.write(`${JSON.stringify({ phase: 'season_completeness_audit', seasonStartYear: year,
      completedGames: season.completedGames, missingSummaryGames: season.missingSummaryGames })}\n`);
  }
  const report = { version: 'scout_six_season_import_completeness_v1', generatedAt: new Date().toISOString(),
    seasonStartYears: seasons.map(row => row.seasonStartYear), seasons, fileErrors, missingSummaryGames, discrepancyGames,
    allScheduledGamesDownloaded: seasons.every(row => row.allScheduledGamesDownloaded),
    allOfficialFieldsPresent: fileErrors.length === 0 && missingSummaryGames.length === 0,
    sourcesStableDuringAudit: seasons.every(row => row.manifestUnchangedDuringAudit),
    readyForRebuild: false, rebuildStarted: false,
    caveat: 'Progress/completeness audit only. Full source attestation and discrepancy review remain required. Preseason and non-NBA opponents remain archived but outside the existing model scope.' };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report)}\n`, { flag: 'wx' });
  return { report: output, allScheduledGamesDownloaded: report.allScheduledGamesDownloaded,
    missingSummaryGames: missingSummaryGames.length, discrepancyGames: discrepancyGames.length, fileErrors: fileErrors.length, rebuildStarted: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length === 4 && args[0] === '--summary-overlay' && args[2] === '--output', 'Use --summary-overlay <private directory> --output <new private JSON>.');
    process.stdout.write(`${JSON.stringify(await auditScoutImportCompleteness({ overlay: path.resolve(args[1]), output: path.resolve(args[3]) }))}\n`);
  } catch (error) { process.stderr.write(`Scout completeness audit failed: ${error.code ?? 'AUDIT_ERROR'}. No source files changed.\n`); process.exitCode = 1; }
}
