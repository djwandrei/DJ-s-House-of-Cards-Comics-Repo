import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync, createGzip, createGunzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { parseReadinessArgs, readReadinessMetadata, runReadinessAudit } from './audit-lineup-scout-readiness.mjs';
import { MODEL_EVIDENCE_VERSION, BOX_FIELDS, buildGameModelEvidence, aggregatePlayerSeasons, BLUEPRINT_CAPABILITIES } from './lib/nba-scout-model-evidence.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value)}\n`;
const exists = async target => fs.stat(target).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));

function inside(root, relative) {
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Artifact path escapes its intended directory.');
  return resolved;
}

async function atomicJson(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, json(value), { flag: 'wx' });
  await fs.rename(temporary, target);
}

async function hashFile(target) {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(target)) { digest.update(chunk); bytes += chunk.length; }
  return { sha256: digest.digest('hex'), bytes };
}

async function writeRows(directory, name, rows) {
  const target = inside(directory, `model-evidence/${name}.jsonl.gz`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // JSONL streams avoid the V8 single-string ceiling encountered by the older
  // package writer. Keep only one serializable row in the compression buffer.
  await pipeline(Readable.from((function* () { for (const row of rows) yield json(row); })()), createGzip(), createWriteStream(target));
  let decodedRows = 0;
  const reader = createReadStream(target), unzip = createGunzip();
  const pumping = pipeline(reader, unzip);
  for await (const line of createInterface({ input: unzip, crlfDelay: Infinity })) {
    if (!line) continue;
    JSON.parse(line); decodedRows++;
  }
  await pumping;
  assert.equal(decodedRows, rows.length, `${name} row count must round-trip.`);
  const file = await hashFile(target);
  return { path: `model-evidence/${name}.jsonl.gz`, rows: rows.length, gzipBytes: file.bytes, gzipSha256: file.sha256 };
}

export function rebuildOptions(argv) {
  const core = [], own = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (['--archive-dir', '--output-dir', '--summary-overlay'].includes(name)) {
      if (!value || value.startsWith('--') || own[name]) throw new Error(`Invalid ${name}.`);
      own[name] = path.resolve(value);
    } else core.push(name, value);
  }
  if (!own['--archive-dir'] || !own['--output-dir']) throw new Error('Use --archive-dir and --output-dir in addition to readiness arguments.');
  const readiness = parseReadinessArgs(core);
  const output = own['--output-dir'];
  const privateRoot = path.join(ROOT, 'outputs');
  inside(privateRoot, path.relative(privateRoot, output));
  if (output === path.dirname(readiness.manifest) || output === own['--archive-dir']) throw new Error('Replacement must use a new output directory.');
  return { core, readiness, archive: own['--archive-dir'], output, overlay: own['--summary-overlay'] ?? null };
}

/**
 * Build a new additive package, preserving every existing base key and shard.
 * Hard links retain independent directory entries while avoiding another 34GB
 * copy. They are NEVER modified after linking. Deleting an old package later
 * does not delete the replacement's links. No source package is deleted here.
 * Every linked file is streamed through SHA-256 against its original manifest.
 */
export async function rebuildScoutModelEvidence(argv) {
  const options = rebuildOptions(argv);
  assert.equal((await runReadinessAudit(options.core)).readyForIntegrationReview, true, 'Base package must pass readiness first.');
  const baseFile = await readReadinessMetadata(options.readiness.manifest);
  const base = baseFile.data;
  const sourceFile = await readReadinessMetadata(options.readiness.sourceValidation);
  const baseDir = path.dirname(options.readiness.manifest);
  if (await exists(options.output)) throw new Error('Completed output already exists; choose a new version instead of overwriting it.');
  const stage = `${options.output}.building`;
  await fs.mkdir(stage, { recursive: true });
  // A worker lock prevents concurrent writers. A genuinely stale lock is kept
  // for explicit operator review instead of risking corruption by deleting it.
  const lock = await fs.open(path.join(stage, 'writer.lock'), 'wx');
  await lock.writeFile(json({ processId: process.pid, startedAt: new Date().toISOString() }));
  let finished = false;
  try {
    const codePaths = [SCRIPT_PATH, path.join(ROOT, 'scripts/lib/nba-scout-model-evidence.mjs'),
      path.join(ROOT, 'scripts/derive-local-scout-analytics.mjs'), path.join(ROOT, 'scripts/lib/nba-lineup-reconstruction.mjs')];
    const codeHashes = Object.fromEntries(await Promise.all(codePaths.map(async target => [path.relative(ROOT, target), (await hashFile(target)).sha256])));
    const binding = { version: MODEL_EVIDENCE_VERSION, baseManifestSha256: baseFile.sha256,
      sourceValidationSha256: sourceFile.sha256, archive: options.archive, overlay: options.overlay, codeHashes };
    const bindingPath = path.join(stage, 'rebuild-binding.json');
    if (await exists(bindingPath)) assert.deepEqual(JSON.parse(await fs.readFile(bindingPath, 'utf8')), binding, 'Checkpoint belongs to different inputs/code.');
    else await atomicJson(bindingPath, binding);
    const progress = async value => {
      const update = { ...value, processId: process.pid, updatedAt: new Date().toISOString() };
      await atomicJson(path.join(stage, 'progress.json'), update);
      process.stdout.write(`${JSON.stringify(update)}\n`);
    };
    const officialPhases = new Set(base.scope.includedPhases);
    const allPlayers = [], games = [], connections = [], refresh = [], sourceRows = [];
    let completed = 0, reused = 0;
    for (const year of options.readiness.seasons) {
      const season = sourceFile.data.seasons.find(row => row.seasonStartYear === year);
      assert.ok(season?.files?.records?.length, `Source attestation missing season ${year}.`);
      const sourceManifest = await fs.readFile(path.join(options.archive, String(year), 'manifest.json'));
      assert.equal(sha(sourceManifest), base.provenance.manifestSha256BySeason[year], 'Source manifest changed.');
      for (const descriptor of season.files.records) {
        const sourcePath = inside(path.join(options.archive, String(year)), descriptor.relativePath);
        const compressed = await fs.readFile(sourcePath);
        assert.equal(sha(compressed), descriptor.gzipSha256, `Source game changed: ${descriptor.gameId}`);
        const record = JSON.parse(gunzipSync(compressed));
        const game = record.game;
        assert.equal(game.providerGameId, descriptor.gameId);
        if (!officialPhases.has(game.primaryPhase) || game.status !== 'closed'
          || record.teams?.length !== 2 || !record.teams.every(team => String(team.srId ?? '').startsWith('sr:team:'))) continue;
        const checkpoint = inside(stage, `model-evidence/checkpoints/${year}/${game.providerGameId}.json.gz`);
        let summaryOverlay = null, overlaySha256 = null;
        if (options.overlay) {
          const overlayPath = inside(options.overlay, `${year}/${game.providerGameId}.json`);
          if (await exists(overlayPath)) {
            const raw = await fs.readFile(overlayPath);
            summaryOverlay = JSON.parse(raw); overlaySha256 = sha(raw);
            assert.equal(summaryOverlay.sourceGzipSha256, descriptor.gzipSha256, 'Summary overlay belongs to different source bytes.');
          }
        }
        let enriched;
        if (await exists(checkpoint)) {
          enriched = JSON.parse(gunzipSync(await fs.readFile(checkpoint)));
          assert.equal(enriched.sourceGzipSha256, descriptor.gzipSha256);
          assert.equal(enriched.summaryOverlaySha256, overlaySha256, 'Summary overlay changed since checkpoint.');
          reused++;
        } else {
          enriched = { ...buildGameModelEvidence(record, { summaryOverlay }), sourceGzipSha256: descriptor.gzipSha256, summaryOverlaySha256: overlaySha256 };
          await fs.mkdir(path.dirname(checkpoint), { recursive: true });
          const temporary = `${checkpoint}.tmp`;
          await fs.writeFile(temporary, gzipSync(Buffer.from(json(enriched))));
          await fs.rename(temporary, checkpoint);
        }
        allPlayers.push(...enriched.players);
        games.push(enriched.game);
        connections.push(...enriched.assistedBasketConnections.map(row => ({ ...row, gameId: game.providerGameId, seasonStartYear: year, phase: game.primaryPhase })));
        sourceRows.push({ gameId: game.providerGameId, seasonStartYear: year, sourceGzipSha256: descriptor.gzipSha256, summaryOverlaySha256: overlaySha256 });
        if (enriched.summaryRefreshNeeded) refresh.push({ gameId: game.providerGameId, seasonStartYear: year,
          homeTeamId: game.homeProviderTeamId, awayTeamId: game.awayProviderTeamId,
          playersWithMissingOfficialFields: enriched.players.filter(row => row.missingOfficialFields.length).map(row => ({ playerId: row.playerId, teamId: row.teamId, fields: row.missingOfficialFields })) });
        completed++;
        if (completed % 100 === 0) await progress({ phase: 'game_evidence', completedGames: completed, reusedGames: reused, missingSummaryGames: refresh.length });
      }
    }
    games.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.providerGameId.localeCompare(b.providerGameId));
    const priorByTeam = new Map();
    const gameContexts = games.map(game => ({ ...game, teams: [game.homeProviderTeamId, game.awayProviderTeamId].map(teamId => {
      const id = `${game.seasonStartYear}~${teamId}`, previous = priorByTeam.get(id);
      priorByTeam.set(id, game);
      return { teamId, previousObservedGameId: previous?.providerGameId ?? null,
        hoursSincePreviousObservedTipoff: previous ? (Date.parse(game.scheduledAt) - Date.parse(previous.scheduledAt)) / 3600000 : null,
        interpretation: 'Scheduled-start spacing within this archive, not measured rest, travel, or fatigue.' };
    }) }));
    const unique = new Set(), gamesById = new Map(games.map(game => [game.providerGameId, game]));
    for (const row of allPlayers) {
      const id = `${row.gameId}~${row.playerId}`;
      assert.ok(!unique.has(id), 'Player/game identity duplicated across teams.'); unique.add(id);
      assert.equal(row.trainingEligible, row.boxScoreReconciled && row.minutesReconciled && row.officialMinutes > 0
        && gamesById.get(row.gameId)?.reconstructionEligible === true);
    }
    const seasons = aggregatePlayerSeasons(allPlayers);
    const descriptors = {};
    // Discrete game/season samples support future fits without forcing the
    // browser to download the original possession/lineup shards.
    for (const [name, rows] of Object.entries({ playerGames: allPlayers, playerSeasons: seasons,
      gameContext: gameContexts, assistedBasketConnections: connections, sourceGames: sourceRows,
      summaryRefreshQueue: refresh })) descriptors[name] = await writeRows(stage, name, rows);
    const coverage = {
      games: games.length, eligibleLineupGames: games.filter(game => game.reconstructionEligible).length,
      playerGames: allPlayers.length, uniquePlayers: new Set(allPlayers.map(row => row.playerId)).size,
      fullyReconciledPlayerGames: allPlayers.filter(row => row.boxScoreReconciled).length,
      workloadTrainingEligiblePlayerGames: allPlayers.filter(row => row.trainingEligible).length,
      gamesNeedingOfficialSummary: refresh.length,
      perField: Object.fromEntries(BOX_FIELDS.map(field => [field, {
        expectedPlayerGames: allPlayers.length,
        officialKnown: allPlayers.filter(row => row.officialTotals[field] !== null).length,
        matched: allPlayers.filter(row => row.fieldReconciliation[field] === 'matched').length,
        mismatched: allPlayers.filter(row => row.fieldReconciliation[field] === 'mismatch').length,
      }])),
    };
    assert.equal(coverage.eligibleLineupGames, base.coverage.archivesEligible, 'Extension replay eligibility must match validated base.');
    await progress({ phase: 'preserve_and_verify_base', completedGames: completed, coverage });
    let linkedFiles = 0;
    for (const shard of base.dataShards) {
      for (const prefix of ['json', 'gzip']) {
        const relative = shard[`${prefix}Path`], source = inside(baseDir, relative), target = inside(stage, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (!(await exists(target))) await fs.link(source, target);
        const actual = await hashFile(target);
        assert.equal(actual.sha256, shard[`${prefix}Sha256`], `Existing ${prefix} shard changed.`);
        assert.equal(actual.bytes, shard[`${prefix}Bytes`]);
        linkedFiles++;
        await progress({ phase: 'preserve_and_verify_base', verifiedFiles: linkedFiles, totalFiles: base.dataShards.length * 2 });
      }
    }
    const additions = { version: MODEL_EVIDENCE_VERSION, generatedAt: new Date().toISOString(),
      ...binding, coverage, files: descriptors, capabilities: BLUEPRINT_CAPABILITIES,
      baseAnalyticsPreserved: true, coefficientsRefitted: false, workloadResponseFitted: false,
      sourceRefreshStatus: refresh.length ? 'official_summary_backfill_required' : 'retained_summary_complete',
      caveat: 'Additive evidence package, not newly calibrated prediction models. Existing fitted coefficients and descriptive analytics are unchanged.' };
    const outputManifest = { ...base, modelEvidence: additions };
    for (const name of Object.keys(base)) assert.deepEqual(outputManifest[name], base[name], `Existing ${name} must remain unchanged.`);
    const manifestName = path.basename(options.readiness.manifest);
    await atomicJson(path.join(stage, manifestName), outputManifest);
    await atomicJson(path.join(stage, 'model-evidence-validation.json'), { passed: true, generatedAt: new Date().toISOString(),
      version: MODEL_EVIDENCE_VERSION, sourceGameHashesVerified: completed, baseFilesVerified: linkedFiles,
      coverage, checks: ['round-trip row counts', 'unique player/game identities', 'fieldwise missingness propagation', 'replayed eligible-game parity', 'exact preservation of base manifest fields and shard hashes'],
      workloadResponseFitted: false });
    await atomicJson(path.join(stage, 'model-evidence-capabilities.json'), BLUEPRINT_CAPABILITIES);
    await fs.copyFile(options.readiness.packageValidation, path.join(stage, 'base-package-validation.json'));
    await progress({ phase: 'full_package_validation', completedGames: completed });
    const validationName = `nba-scout-analytics-validation-${base.scope.seasonLabel}.json`;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'scripts/validate-local-scout-analytics.mjs'),
        '--input', path.join(stage, manifestName), '--validation-report', options.readiness.sourceValidation,
        '--seasons', options.readiness.seasons.join(','), '--output', path.join(stage, validationName)],
      { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      child.on('error', reject); child.on('exit', resolve);
    });
    assert.equal(exitCode, 0, 'Replacement full-package validation failed; validated base was not changed.');
    await progress({ phase: 'complete', completedGames: completed, coverage });
    await lock.close();
    await fs.unlink(path.join(stage, 'writer.lock')); // Only this run's coordination marker, not source data.
    await fs.rename(stage, options.output); finished = true;
    return { status: 'complete', output: options.output, coverage, basePackagePreserved: true };
  } finally {
    if (!finished) {
      await lock.close().catch(() => {});
      await fs.unlink(path.join(stage, 'writer.lock')).catch(() => {});
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  rebuildScoutModelEvidence(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => {
    process.stderr.write(`Scout evidence rebuild failed: ${error.message}\n`); process.exitCode = 1;
  });
}
