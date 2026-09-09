import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildScoutDailyGame } from '../lib/scout-daily-games.mjs';
import {
  assertScoutDailyGamePublicBoard,
  assertScoutDailyGameReveal,
  loadScoutDailyBoard,
  normalizeDailySeed,
  revealScoutDailyGame,
} from '../../tools/scout-daily-game-client.js';

function player(id, position, offense, defense) {
  return {
    playerId: id,
    name: id.replace(/-/g, ' '),
    positions: [position],
    teamCode: 'MIN',
    teamName: 'Minnesota Timberwolves',
    franchiseId: 'min',
    sourceSeasonEndYear: 2025,
    publicStats: { games: 70, minutes: 28, points: 10 },
    scout: { offense, defense },
  };
}

const scope = {
  id: 'browser-client-fixture',
  status: 'ready',
  model: {
    publicLabel: 'Validated Scout O/D model',
    seasonEndYears: [2025],
    calibration: { status: 'validated', allComponentsImproved: true },
  },
  players: [
    ...Array.from({ length: 6 }, (_, index) => player(`g-${index}`, 'G', index + 1, 8 - index)),
    ...Array.from({ length: 6 }, (_, index) => player(`f-${index}`, 'F', 8 - index, index + 1)),
    ...Array.from({ length: 3 }, (_, index) => player(`c-${index}`, 'C', index + 2, 8 - index)),
  ],
};

test('browser client accepts canonical public boards and rejects private Scout fields', () => {
  const result = buildScoutDailyGame({ gameKind: 'fix-the-five', dailySeed: '2026-09-05', scopes: [scope] });
  assert.equal(assertScoutDailyGamePublicBoard(result.publicBoard, 'fix-the-five', '2026-09-05'), result.publicBoard);
  assert.ok(result.publicBoard.challenges[0].candidates[0].id.startsWith('p'));
  const leaked = structuredClone(result.publicBoard);
  leaked.challenges[0].candidates[0].scout = { offense: 1.2 };
  assert.throws(() => assertScoutDailyGamePublicBoard(leaked), /not a public Scout game field/);
  const providerFieldLeak = structuredClone(result.publicBoard);
  providerFieldLeak.challenges[0].candidates[0].playerId = 'legacy-provider-id';
  assert.throws(() => assertScoutDailyGamePublicBoard(providerFieldLeak), /not a public Scout game field/);
  const providerIdLeak = structuredClone(result.publicBoard);
  providerIdLeak.challenges[0].candidates[0].id = '550e8400-e29b-41d4-a716-446655440000';
  assert.throws(() => assertScoutDailyGamePublicBoard(providerIdLeak), /identifier|opaque/i);
  assert.equal(normalizeDailySeed('2026-02-29'), '');
  assert.equal(normalizeDailySeed('2026-09-05'), '2026-09-05');
});

test('browser client invokes only the public board and sealed reveal contracts', async () => {
  const result = buildScoutDailyGame({ gameKind: 'fix-the-five', dailySeed: '2026-09-05', scopes: [scope] });
  const challenge = result.publicBoard.challenges[0];
  const candidate = challenge.candidates[0];
  const calls = [];
  const invoke = async (functionName, body) => {
    calls.push({ functionName, body });
    if (body.action === 'board') return { board: result.publicBoard };
    return {
      contractVersion: 1,
      gameKind: 'fix-the-five',
      dailySeed: '2026-09-05',
      outcome: result.sealedResults[challenge.id][candidate.id],
    };
  };

  const board = await loadScoutDailyBoard({
    gameKind: 'fix-the-five', dailySeed: '2026-09-05', invoke,
  });
  assert.equal(board.challenges[0].id, challenge.id);
  const outcome = await revealScoutDailyGame({
    gameKind: 'fix-the-five', dailySeed: '2026-09-05', challengeId: challenge.id, candidateId: candidate.id, invoke,
  });
  assert.equal(outcome.candidateId, candidate.id);
  assert.deepEqual(calls, [
    { functionName: 'scout-daily-game', body: { action: 'board', gameKind: 'fix-the-five', dailySeed: '2026-09-05' } },
    { functionName: 'scout-daily-game', body: {
      action: 'reveal', gameKind: 'fix-the-five', dailySeed: '2026-09-05', challengeId: challenge.id, candidateId: candidate.id,
    } },
  ]);
});

test('browser client binds a reveal to its requested board and selection', () => {
  const invalid = {
    contractVersion: 1,
    gameKind: 'fix-the-five',
    dailySeed: '2026-09-05',
    outcome: { candidateId: 'someone-else', rank: 1, roundScore: 100 },
  };
  assert.throws(() => assertScoutDailyGameReveal(invalid, 'fix-the-five', '2026-09-05', { candidateId: 'selected-player' }), /did not match/);
});

test('live game routes use the Scout-only client instead of bundled fixture engines', () => {
  const fixPage = fs.readFileSync(new URL('../../tools/fix-the-five/index.html', import.meta.url), 'utf8');
  const draftPage = fs.readFileSync(new URL('../../tools/draft-night/index.html', import.meta.url), 'utf8');
  assert.match(fixPage, /supabase-client\.js/);
  assert.match(fixPage, /scout-fix-the-five\.js/);
  assert.doesNotMatch(fixPage, /src="\.\/fix-the-five\.js/);
  assert.match(draftPage, /supabase-client\.js/);
  assert.match(draftPage, /scout-draft-night\.js/);
  assert.doesNotMatch(draftPage, /src="\.\/draft-night\.js/);
});
