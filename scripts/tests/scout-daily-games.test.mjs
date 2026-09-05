import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertScoutDailyGamePublicBoard,
  buildScoutDailyGame,
  collectScoutDailyGameSources,
} from '../lib/scout-daily-games.mjs';

function player(id, position, offense, defense, options = {}) {
  return {
    playerId: id,
    name: options.name || id.replace(/-/g, ' '),
    positions: [position],
    teamCode: options.teamCode || 'MIN',
    teamName: options.teamName || 'Minnesota Timberwolves',
    franchiseId: options.franchiseId || options.teamCode || 'MIN',
    sourceSeasonEndYear: options.seasonEndYear || 2025,
    publicStats: { games: 70, minutes: 28, points: options.points || 10 },
    scout: { offense, defense },
  };
}

function teamRoster(prefix, options = {}) {
  return [
    ...Array.from({ length: 6 }, (_, index) => player(`${prefix}-g${index + 1}`, 'G', index + 1, 7 - index, options)),
    ...Array.from({ length: 6 }, (_, index) => player(`${prefix}-f${index + 1}`, 'F', 8 - index, index + 1, options)),
    ...Array.from({ length: 3 }, (_, index) => player(`${prefix}-c${index + 1}`, 'C', index + 2, 8 - index, options)),
  ];
}

function scope(id, players, seasonEndYears = [2025], status = 'ready') {
  return {
    id,
    status,
    model: {
      publicLabel: 'Validated Scout O/D model',
      seasonEndYears,
      calibration: { status: 'validated', allComponentsImproved: true },
    },
    players,
  };
}

const singleSeasonScope = scope('season-2024-25', teamRoster('min'));
const combinedScope = scope('combined-2023-26', [
  ...teamRoster('min24', { seasonEndYear: 2024, teamCode: 'MIN', franchiseId: 'MIN' }),
  ...teamRoster('min25', { seasonEndYear: 2025, teamCode: 'MIN', franchiseId: 'MIN' }),
  ...teamRoster('bos24', { seasonEndYear: 2024, teamCode: 'BOS', teamName: 'Boston Celtics', franchiseId: 'BOS' }),
  ...teamRoster('bos25', { seasonEndYear: 2025, teamCode: 'BOS', teamName: 'Boston Celtics', franchiseId: 'BOS' }),
], [2024, 2025]);

test('Scout daily games are deterministic, legal, and score with private Scout input only', () => {
  const first = buildScoutDailyGame({ gameKind: 'fix-the-five', dailySeed: '2026-09-05', scopes: [singleSeasonScope] });
  const second = buildScoutDailyGame({ gameKind: 'fix-the-five', dailySeed: '2026-09-05', scopes: [singleSeasonScope] });
  assert.deepEqual(first, second);
  assert.equal(first.publicBoard.challenges.length, 5);
  for (const challenge of first.publicBoard.challenges) {
    assert.equal(challenge.lineup.length, 5);
    assert.equal(challenge.candidates.length, 3);
    assert.equal(new Set([...challenge.lineup, ...challenge.candidates].map((entry) => entry.id)).size, 8);
    const result = first.sealedResults[challenge.id];
    assert.equal(Object.keys(result).length, 3);
    assert.equal(Object.values(result).filter((entry) => entry.isBest).length, 1);
  }
  assertScoutDailyGamePublicBoard(first.publicBoard);
  const collectKeys = (value) => Array.isArray(value)
    ? value.flatMap(collectKeys)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, nested]) => [key, ...collectKeys(nested)])
      : [];
  assert.ok(collectKeys(first.publicBoard).every((key) => !/(offen[sc]|defen[sc]|rapm|impact|coefficient|scout(?:score|value|impact)?|rawscore)/i.test(key)));
  assert.throws(
    () => assertScoutDailyGamePublicBoard({ ...first.publicBoard, scout: { offense: 1 } }),
    /private Scout value/i,
  );
});

test('Draft Night has all 243 legal paths and only returns relative Scout outcomes', () => {
  const result = buildScoutDailyGame({ gameKind: 'draft-night', dailySeed: '2026-09-05', scopes: [singleSeasonScope] });
  assert.equal(result.publicBoard.deck.rounds.length, 5);
  assert.equal(Object.keys(result.sealedResults).length, 243);
  const outcomes = Object.values(result.sealedResults);
  assert.equal(outcomes.filter((outcome) => outcome.isBest).length, 1);
  assert.ok(outcomes.every((outcome) => outcome.roundScore >= 0 && outcome.roundScore <= 100));
  assert.ok(outcomes.every((outcome) => !Object.hasOwn(outcome, 'privateScore')));
  assertScoutDailyGamePublicBoard(result.publicBoard);
});

test('cross-season families require a validated combined scope and build distinct sources', () => {
  const sources = collectScoutDailyGameSources([combinedScope]);
  assert.ok(sources.some((entry) => entry.family === 'team-season'));
  assert.ok(sources.some((entry) => entry.family === 'franchise-window'));
  assert.ok(sources.some((entry) => entry.family === 'multi-season-pool'));
  const franchise = buildScoutDailyGame({
    gameKind: 'draft-night', dailySeed: '2026-09-06', scopes: [combinedScope], family: 'franchise-window',
  });
  assert.equal(franchise.publicBoard.deck.source.family, 'franchise-window');
  assert.equal(franchise.publicBoard.deck.source.seasonEndYears.length, 2);
  const mixed = buildScoutDailyGame({
    gameKind: 'draft-night', dailySeed: '2026-09-06', scopes: [combinedScope], family: 'multi-season-pool',
  });
  assert.equal(mixed.publicBoard.deck.source.family, 'multi-season-pool');
  assert.equal(mixed.publicBoard.deck.source.seasonEndYears.length, 2);
});

test('unready or unvalidated source seasons cannot enter the daily rotation', () => {
  assert.equal(collectScoutDailyGameSources([scope('pending-2023-24', teamRoster('pending', { seasonEndYear: 2024 }), [2024], 'pending')]).length, 0);
  assert.throws(() => buildScoutDailyGame({ gameKind: 'draft-night', dailySeed: '2026-09-06', scopes: [
    {
      ...singleSeasonScope,
      model: { ...singleSeasonScope.model, calibration: { status: 'pending', allComponentsImproved: false } },
    },
  ] }), /calibration gate/);
});

test('changing descriptive public stats does not change a Scout-ranked outcome', () => {
  const first = buildScoutDailyGame({ gameKind: 'draft-night', dailySeed: '2026-09-07', scopes: [singleSeasonScope] });
  const edited = structuredClone(singleSeasonScope);
  edited.players.forEach((entry) => { entry.publicStats.points = 999; entry.publicStats.assists = 999; });
  const second = buildScoutDailyGame({ gameKind: 'draft-night', dailySeed: '2026-09-07', scopes: [edited] });
  assert.deepEqual(first.sealedResults, second.sealedResults);
});
