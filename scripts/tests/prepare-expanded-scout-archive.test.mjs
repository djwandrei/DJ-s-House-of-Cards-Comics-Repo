import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { optionsFromArgs, prepareExpandedScoutArchive } from '../prepare-expanded-scout-archive.mjs';

async function writeSeason(root, year, {
  completedGames = 1,
  eligibleGames = completedGames,
  gamePhases = Array.from({ length: completedGames }, () => 'regular'),
  ineligibleGameIndexes = [],
  emptySections = [],
} = {}) {
  const season = path.join(root, String(year));
  const games = path.join(season, 'games');
  await fs.mkdir(games, { recursive: true });
  const manifestGames = {};
  for (let index = 0; index < completedGames; index += 1) {
    const gameId = `game-${year}-${index}`;
    const filename = `${gameId}.json.gz`;
    const phase = gamePhases[index] ?? gamePhases.at(-1) ?? 'regular';
    const isIneligible = ineligibleGameIndexes.includes(index);
    manifestGames[gameId] = {
      status: 'completed',
      sourcePhases: [phase],
      primaryPhase: phase,
      gameFile: `games/${filename}`,
      coverageStatus: isIneligible ? 'ineligible' : 'eligible',
      eligibleForPublication: !isIneligible,
    };
    const fixtureRecord = {
      analytics: {
        coverageStatus: isIneligible ? 'ineligible' : 'eligible',
        eligibleForPublication: !isIneligible,
        validation: {
          errors: isIneligible ? ['fixture_source_error'] : [],
          finalScore: {
            expectedHomePoints: 100,
            expectedAwayPoints: 99,
            observedHomePoints: 100,
            observedAwayPoints: isIneligible ? 97 : 99,
            verified: !isIneligible,
          },
        },
      }, deletedEvents: [], exportVersion: 'fixture', source: {},
      game: { providerGameId: gameId, seasonStartYear: year, seasonEndYear: year + 1, primaryPhase: phase, sourcePhases: [phase], coverage: 'full', trackOnCourt: true, homeProviderTeamId: 'home', awayProviderTeamId: 'away' },
      teams: [{ id: 'home', srId: 'sr:team:home', points: 100, possessions: 100, offensiveRating: 100, defensiveRating: 100 }],
      players: [{ id: 'player', providerTeamId: 'home', minutesPlayed: 30, plusMinus: 1, officialBoxScore: null }],
      events: [{ id: 'event', eventType: 'fieldgoal', statistics: [], onCourt: [], periodSequence: 1, clockRemainingMs: 1, possessionTeamId: 'home', attributionTeamId: 'home', isRescinded: false }],
      stints: [{ homeLineupId: 'home-lineup', awayLineupId: 'away-lineup', homePoints: 0, awayPoints: 0, homeOffensivePossessions: 0, awayOffensivePossessions: 0, startElapsedMs: 0, endElapsedMs: 1 }],
      possessions: [{ id: 'possession', offenseProviderTeamId: 'home', defenseProviderTeamId: 'away', offensePoints: 0, defensePoints: 0, homeLineupId: 'home-lineup', awayLineupId: 'away-lineup', periodSequence: 1, isClutchV1: false, transitionContext: null }],
      lineups: [{ id: 'home-lineup', playerIds: ['player'], providerTeamId: 'home' }],
    };
    for (const section of emptySections) fixtureRecord[section] = [];
    await fs.writeFile(path.join(games, filename), gzipSync(JSON.stringify(fixtureRecord)));
  }
  await fs.writeFile(path.join(season, 'manifest.json'), `${JSON.stringify({
    seasonStartYear: year,
    accessLevel: 'trial',
    uniqueEligibleGames: eligibleGames,
    games: manifestGames,
  })}\n`);
  return season;
}

async function writeReferencePackage(privateRoot) {
  const referencePackage = path.join(privateRoot, 'reference-package.json');
  await fs.writeFile(referencePackage, JSON.stringify({
    schemaVersion: 4,
    metricsVersion: 'nba-scout-metrics-v4',
    provider: 'Sportradar NBA v8 licensed local archive',
    definitions: { fourFactors: {}, netRating: {} },
    tables: { teams: 1, playerProfiles: 1 },
    analyticsAvailability: { directPlayerBoxScoreTotals: { status: 'available_with_coverage' }, onOff: { status: 'available' } },
    provenance: { sourceArchiveValidationPassed: true },
  }));
  return referencePackage;
}

async function fixture() {
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-expanded-archive-'));
  const older = path.join(privateRoot, 'older');
  const current = path.join(privateRoot, 'current');
  await writeSeason(older, 2017);
  await writeSeason(current, 2020, { completedGames: 2 });
  return { privateRoot, older, current, referencePackage: await writeReferencePackage(privateRoot) };
}

test('parses a multi-root, no-copy expanded archive request', () => {
  const options = optionsFromArgs([
    '--source-root', 'outputs/older', '--source-root', 'outputs/current',
    '--expect-seasons', '2017,2020', '--output-dir', 'outputs/linked', '--reference-package', 'outputs/reference.json',
  ]);
  assert.deepEqual(options.expectedSeasons, [2017, 2020]);
  assert.equal(options.sourceRoots.length, 2);
});

test('parses an explicit phase scope', () => {
  const options = optionsFromArgs([
    '--source-root', 'outputs/older', '--source-root', 'outputs/current',
    '--expect-seasons', '2017,2020', '--output-dir', 'outputs/linked', '--reference-package', 'outputs/reference.json',
    '--phases', 'regular,playoffs',
  ]);
  assert.deepEqual(options.includedPhases, ['regular', 'playoffs']);
});

test('parses and deduplicates explicit game exclusions', () => {
  const options = optionsFromArgs([
    '--source-root', 'outputs/older', '--source-root', 'outputs/current',
    '--expect-seasons', '2017,2020', '--output-dir', 'outputs/linked', '--reference-package', 'outputs/reference.json',
    '--exclude-game', 'bad-game', '--exclude-game=bad-game', '--exclude-game', 'other-game',
  ]);
  assert.deepEqual(options.excludedGameIds, ['bad-game', 'other-game']);
});

test('parses and deduplicates preserved source seasons', () => {
  const options = optionsFromArgs([
    '--source-root', 'outputs/older', '--source-root', 'outputs/current',
    '--expect-seasons', '2017,2020', '--output-dir', 'outputs/linked', '--reference-package', 'outputs/reference.json',
    '--preserve-season', '2020', '--preserve-season=2017,2020',
  ]);
  assert.deepEqual(options.preserveSeasons, [2017, 2020]);
});

test('creates a linked archive view without copying season data', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  const outputDir = path.join(setup.privateRoot, 'linked');
  const result = await prepareExpandedScoutArchive({
    sourceRoots: [setup.older, setup.current], expectedSeasons: [2017, 2020], outputDir, referencePackage: setup.referencePackage, privateRoot: setup.privateRoot,
  });
  assert.equal(result.plan.mode.includes('no_raw_copy'), true);
  assert.deepEqual(result.plan.archiveScope.seasonStartYears, [2017, 2020]);
  assert.equal(result.plan.seasons.reduce((sum, season) => sum + season.completedGames, 0), 3);
  assert.equal((await fs.stat(path.join(outputDir, '2017', 'games', 'game-2017-0.json.gz'))).isFile(), true);
  const linkedRecord = gunzipSync(await fs.readFile(path.join(outputDir, '2020', 'games', 'game-2020-1.json.gz'))).toString('utf8');
  assert.equal(linkedRecord.includes('game-2020-1'), true);
  assert.equal(result.plan.metricContract.metricsVersion, 'nba-scout-metrics-v4');
  assert.equal(await fs.stat(path.join(outputDir, 'archive-composition.json')).then(() => true), true);
});

test('filters excluded phases from the composed archive view', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.older, 2017, { completedGames: 2, eligibleGames: 2, gamePhases: ['preseason', 'regular'] });
  const outputDir = path.join(setup.privateRoot, 'filtered');
  const result = await prepareExpandedScoutArchive({
    sourceRoots: [setup.older, setup.current],
    expectedSeasons: [2017, 2020],
    outputDir,
    referencePackage: setup.referencePackage,
    privateRoot: setup.privateRoot,
    includedPhases: ['regular'],
  });
  const seasonManifest = JSON.parse(await fs.readFile(path.join(outputDir, '2017', 'manifest.json'), 'utf8'));
  assert.equal(result.plan.mode, 'phase_filtered_hardlinks_no_raw_copy');
  assert.deepEqual(result.plan.archiveScope.includedPhases, ['regular']);
  assert.equal(result.plan.seasons.reduce((sum, season) => sum + season.completedGames, 0), 3);
  assert.deepEqual(Object.keys(seasonManifest.games), ['game-2017-1']);
  assert.equal(await fs.access(path.join(outputDir, '2017', 'games', 'game-2017-0.json.gz')).then(() => true).catch(() => false), false);
  assert.equal(await fs.stat(path.join(outputDir, '2017', 'games', 'game-2017-1.json.gz')).then(() => true), true);
});

test('preserves an attested source manifest byte-for-byte and includes all phases', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.older, 2017, { completedGames: 2, eligibleGames: 2, gamePhases: ['preseason', 'regular'] });
  const sourceManifestRaw = await fs.readFile(path.join(setup.older, '2017', 'manifest.json'), 'utf8');
  const outputDir = path.join(setup.privateRoot, 'preserved');
  const result = await prepareExpandedScoutArchive({
    sourceRoots: [setup.older, setup.current],
    expectedSeasons: [2017, 2020],
    outputDir,
    referencePackage: setup.referencePackage,
    privateRoot: setup.privateRoot,
    includedPhases: ['regular'],
    preserveSeasons: [2017],
  });
  const outputManifestRaw = await fs.readFile(path.join(outputDir, '2017', 'manifest.json'), 'utf8');
  assert.equal(outputManifestRaw, sourceManifestRaw);
  assert.equal(result.plan.archiveScope.preservedSeasons.includes(2017), true);
  assert.equal(result.plan.seasons.find((season) => season.seasonStartYear === 2017).preserveSourceManifest, true);
  assert.equal(result.plan.seasons.find((season) => season.seasonStartYear === 2017).completedGames, 2);
  assert.equal(await fs.stat(path.join(outputDir, '2017', 'games', 'game-2017-0.json.gz')).then(() => true), true);
});

test('refuses exclusions that would rewrite a preserved source manifest', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.current, 2020, { completedGames: 2, ineligibleGameIndexes: [0] });
  await assert.rejects(
    prepareExpandedScoutArchive({
      sourceRoots: [setup.older, setup.current],
      expectedSeasons: [2017, 2020],
      outputDir: path.join(setup.privateRoot, 'preserved-conflict'),
      referencePackage: setup.referencePackage,
      privateRoot: setup.privateRoot,
      preserveSeasons: [2020],
      excludedGameIds: ['game-2020-0'],
    }),
    /cannot preserve its source manifest while excluding game/,
  );
});

test('filters explicitly excluded completed games and records provenance', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.current, 2020, { completedGames: 2, ineligibleGameIndexes: [0] });
  const outputDir = path.join(setup.privateRoot, 'excluded');
  const result = await prepareExpandedScoutArchive({
    sourceRoots: [setup.older, setup.current],
    expectedSeasons: [2017, 2020],
    outputDir,
    referencePackage: setup.referencePackage,
    privateRoot: setup.privateRoot,
    excludedGameIds: ['game-2020-0'],
  });
  const plan = JSON.parse(await fs.readFile(path.join(outputDir, 'archive-composition.json'), 'utf8'));
  const seasonManifest = JSON.parse(await fs.readFile(path.join(outputDir, '2020', 'manifest.json'), 'utf8'));
  assert.deepEqual(plan.archiveScope.excludedGameIds, ['game-2020-0']);
  assert.deepEqual(plan.seasons.find((season) => season.seasonStartYear === 2020).excludedGameIds, ['game-2020-0']);
  assert.deepEqual(plan.seasons.find((season) => season.seasonStartYear === 2020).excludedGames[0].validationErrors, ['fixture_source_error']);
  assert.deepEqual(Object.keys(seasonManifest.games), ['game-2020-1']);
  assert.equal(await fs.access(path.join(outputDir, '2020', 'games', 'game-2020-0.json.gz')).then(() => true).catch(() => false), false);
});

test('refuses to exclude a completed game that is not source-ineligible', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await assert.rejects(
    prepareExpandedScoutArchive({
      sourceRoots: [setup.older, setup.current],
      expectedSeasons: [2017, 2020],
      outputDir: path.join(setup.privateRoot, 'eligible-exclusion'),
      referencePackage: setup.referencePackage,
      privateRoot: setup.privateRoot,
      excludedGameIds: ['game-2020-0'],
    }),
    /lacks matching ineligible source evidence/,
  );
});

test('refuses an exclusion that is not found in the selected scope', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await assert.rejects(
    prepareExpandedScoutArchive({
      sourceRoots: [setup.older, setup.current],
      expectedSeasons: [2017, 2020],
      outputDir: path.join(setup.privateRoot, 'missing-exclusion'),
      referencePackage: setup.referencePackage,
      privateRoot: setup.privateRoot,
      excludedGameIds: ['not-present'],
    }),
    /not found in the selected phase scope/,
  );
});

test('refuses an incomplete season before creating any output', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.older, 2018, { completedGames: 1, eligibleGames: 2 });
  const outputDir = path.join(setup.privateRoot, 'linked');
  await assert.rejects(
    prepareExpandedScoutArchive({
      sourceRoots: [setup.older, setup.current], expectedSeasons: [2017, 2018, 2020], outputDir, referencePackage: setup.referencePackage, privateRoot: setup.privateRoot,
    }),
    /complete eligible-game manifest/,
  );
  assert.equal(await fs.access(outputDir).then(() => true).catch(() => false), false);
});

test('refuses structurally empty identity sections while allowing empty possessions', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.older, 2017, { emptySections: ['teams', 'players', 'events', 'stints', 'lineups'] });
  await assert.rejects(
    prepareExpandedScoutArchive({
      sourceRoots: [setup.older, setup.current],
      expectedSeasons: [2017, 2020],
      outputDir: path.join(setup.privateRoot, 'empty-structural-sections'),
      referencePackage: setup.referencePackage,
      privateRoot: setup.privateRoot,
    }),
    /sectionFailures.*teams.*players.*events.*stints.*lineups/,
  );

  await writeSeason(setup.older, 2017, { emptySections: ['possessions'] });
  const result = await prepareExpandedScoutArchive({
    sourceRoots: [setup.older, setup.current],
    expectedSeasons: [2017, 2020],
    outputDir: path.join(setup.privateRoot, 'empty-possessions'),
    referencePackage: setup.referencePackage,
    privateRoot: setup.privateRoot,
  });
  assert.equal(result.plan.seasons.find((season) => season.seasonStartYear === 2017).completedGames, 1);
});

test('refuses the same season from two source roots', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.privateRoot, { recursive: true, force: true }));
  await writeSeason(setup.current, 2017);
  await assert.rejects(
    prepareExpandedScoutArchive({
      sourceRoots: [setup.older, setup.current], expectedSeasons: [2017, 2020], outputDir: path.join(setup.privateRoot, 'linked'), referencePackage: setup.referencePackage, privateRoot: setup.privateRoot,
    }),
    /more than one source root/,
  );
});
