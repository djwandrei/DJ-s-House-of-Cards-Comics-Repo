import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { optionsFromArgs, prepareExpandedScoutArchive } from '../prepare-expanded-scout-archive.mjs';

async function writeSeason(root, year, { completedGames = 1, eligibleGames = completedGames } = {}) {
  const season = path.join(root, String(year));
  const games = path.join(season, 'games');
  await fs.mkdir(games, { recursive: true });
  const manifestGames = {};
  for (let index = 0; index < completedGames; index += 1) {
    const gameId = `game-${year}-${index}`;
    const filename = `${gameId}.json.gz`;
    manifestGames[gameId] = { status: 'completed', gameFile: `games/${filename}` };
    await fs.writeFile(path.join(games, filename), gzipSync(JSON.stringify({
      analytics: {}, deletedEvents: [], exportVersion: 'fixture', source: {},
      game: { providerGameId: gameId, seasonStartYear: year, seasonEndYear: year + 1, primaryPhase: 'regular', coverage: 'full', trackOnCourt: true, homeProviderTeamId: 'home', awayProviderTeamId: 'away' },
      teams: [{ id: 'home', srId: 'sr:team:home', points: 100, possessions: 100, offensiveRating: 100, defensiveRating: 100 }],
      players: [{ id: 'player', providerTeamId: 'home', minutesPlayed: 30, plusMinus: 1, officialBoxScore: null }],
      events: [{ id: 'event', eventType: 'fieldgoal', statistics: [], onCourt: [], periodSequence: 1, clockRemainingMs: 1, possessionTeamId: 'home', attributionTeamId: 'home', isRescinded: false }],
      stints: [{ homeLineupId: 'home-lineup', awayLineupId: 'away-lineup', homePoints: 0, awayPoints: 0, homeOffensivePossessions: 0, awayOffensivePossessions: 0, startElapsedMs: 0, endElapsedMs: 1 }],
      possessions: [{ id: 'possession', offenseProviderTeamId: 'home', defenseProviderTeamId: 'away', offensePoints: 0, defensePoints: 0, homeLineupId: 'home-lineup', awayLineupId: 'away-lineup', periodSequence: 1, isClutchV1: false, transitionContext: null }],
      lineups: [{ id: 'home-lineup', playerIds: ['player'], providerTeamId: 'home' }],
    })));
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
