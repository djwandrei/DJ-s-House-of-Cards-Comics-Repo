import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { readJsonBody } from '../../supabase/functions/_shared/http.ts';
import {
  assertScoutDailyGamePublicBoard,
  buildScoutDailyGame,
} from '../lib/scout-daily-games.mjs';

const source = fs.readFileSync(new URL('../../supabase/functions/scout-daily-game/index.ts', import.meta.url), 'utf8');

function player(id, position, offense, defense, options = {}) {
  return {
    playerId: id,
    name: options.name || id.replace(/-/g, ' '),
    positions: [position],
    teamCode: options.teamCode || 'MIN',
    teamName: options.teamName || 'Minnesota Timberwolves',
    franchiseId: options.franchiseId || 'min',
    sourceSeasonEndYear: options.seasonEndYear || 2025,
    publicStats: { games: 70, minutes: 28, points: 10 },
    scout: { offense, defense },
  };
}

function catalog(status = 'ready') {
  const roster = [
    ...Array.from({ length: 6 }, (_, index) => player(`min-g${index + 1}`, 'G', index + 1, 8 - index)),
    ...Array.from({ length: 6 }, (_, index) => player(`min-f${index + 1}`, 'F', 8 - index, index + 1)),
    ...Array.from({ length: 3 }, (_, index) => player(`min-c${index + 1}`, 'C', index + 2, 8 - index)),
  ];
  return {
    contractVersion: 1,
    scopes: [{
      id: 'scout-2024-25-fixture',
      status,
      model: {
        publicLabel: 'Validated Scout O/D model',
        seasonEndYears: [2025],
        calibration: { status: 'validated', allComponentsImproved: true },
      },
      players: roster,
    }],
  };
}

function handler({ target = 'https://fbbmuqbdpgsmvnezowwn.supabase.co', data = catalog() } = {}) {
  let handle;
  let calls = 0;
  const nba = {
    rpc: async (name, args) => {
      calls += 1;
      assert.equal(name, 'get_nba_scout_daily_game_catalog');
      assert.equal(args, undefined);
      return { data };
    },
  };
  const env = {
    ANALYTICS_SUPABASE_URL: target,
    ANALYTICS_SUPABASE_SERVICE_ROLE_KEY: 'test-only',
  };
  const executable = source
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace('export default {', 'const __default = {');
  const exported = new Function(
    'Deno', 'createClient', 'readJsonBody', 'buildScoutDailyGame', 'assertScoutDailyGamePublicBoard',
    `${stripTypeScriptTypes(executable)}\nreturn __default;`,
  )(
    { env: { get: (key) => env[key] } },
    () => nba,
    readJsonBody,
    buildScoutDailyGame,
    assertScoutDailyGamePublicBoard,
  );
  handle = exported.fetch;
  return { run: handle, calls: () => calls };
}

function request(payload, headers = {}) {
  return new Request('https://commerce.invalid/functions/v1/scout-daily-game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

function assertNoPrivateScoutFields(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /offensive_rapm_per_100|defensive_rapm_per_100|"offense"\s*:|"defense"\s*:|rapm|coefficient|privateScore/i);
}

test('Scout Daily Game returns a public board only and caches its private catalog server-side', async () => {
  const h = handler();
  const first = await h.run(request({ action: 'board', gameKind: 'fix-the-five', dailySeed: '2026-09-05' }));
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /private, no-store/);
  const firstBody = await first.json();
  assertScoutDailyGamePublicBoard(firstBody.board);
  assertNoPrivateScoutFields(firstBody.board);
  assert.ok(firstBody.board.challenges[0].lineup.every((player) => /^p[a-z0-9]{7}(?:-\d+)?$/i.test(player.id)));
  assert.equal(h.calls(), 1);

  const second = await h.run(request({ action: 'board', gameKind: 'draft-night', dailySeed: '2026-09-05' }));
  assert.equal(second.status, 200);
  assert.equal(h.calls(), 1);
});

test('Scout Daily Game reveals only a legal, sealed Fix the Five outcome', async () => {
  const h = handler();
  const boardResponse = await h.run(request({ action: 'board', gameKind: 'fix-the-five', dailySeed: '2026-09-06' }));
  const board = (await boardResponse.json()).board;
  const challenge = board.challenges[0];
  const candidate = challenge.candidates[0];
  const revealed = await h.run(request({
    action: 'reveal', gameKind: 'fix-the-five', dailySeed: '2026-09-06',
    challengeId: challenge.id, candidateId: candidate.id,
  }));
  assert.equal(revealed.status, 200);
  const body = await revealed.json();
  assert.equal(body.outcome.candidateId, candidate.id);
  assert.ok(Number.isInteger(body.outcome.rank));
  assert.ok(body.outcome.roundScore >= 0 && body.outcome.roundScore <= 100);
  assertNoPrivateScoutFields(body);
  assert.equal(h.calls(), 1);

  const invalid = await h.run(request({
    action: 'reveal', gameKind: 'fix-the-five', dailySeed: '2026-09-06',
    challengeId: challenge.id, candidateId: 'not-on-the-board',
  }));
  assert.equal(invalid.status, 400);
});

test('Scout Daily Game validates full Draft Night paths before revealing an outcome', async () => {
  const h = handler();
  const boardResponse = await h.run(request({ action: 'board', gameKind: 'draft-night', dailySeed: '2026-09-07' }));
  const board = (await boardResponse.json()).board;
  const selectionIds = board.deck.rounds.map((round) => round.candidates[0].id);
  const revealed = await h.run(request({
    action: 'reveal', gameKind: 'draft-night', dailySeed: '2026-09-07', selectionIds,
  }));
  assert.equal(revealed.status, 200);
  const body = await revealed.json();
  assert.deepEqual(body.outcome.selectionIds, selectionIds);
  assert.ok(Number.isInteger(body.outcome.rank));
  assertNoPrivateScoutFields(body);

  const invalid = await h.run(request({
    action: 'reveal', gameKind: 'draft-night', dailySeed: '2026-09-07',
    selectionIds: [...selectionIds.slice(0, 4), selectionIds[0]],
  }));
  assert.equal(invalid.status, 400);
});

test('Scout Daily Game fails closed for bad origins, malformed requests, unvalidated scopes, and wrong targets', async () => {
  const h = handler();
  assert.equal((await h.run(request({ action: 'board', gameKind: 'fix-the-five', dailySeed: '2026-09-05' }, {
    Origin: 'https://untrusted.invalid',
  }))).status, 403);
  assert.equal((await h.run(request({ action: 'board', gameKind: 'not-a-game', dailySeed: '2026-09-05' }))).status, 400);
  assert.equal((await h.run(new Request('https://commerce.invalid/functions/v1/scout-daily-game'))).status, 405);
  assert.equal(h.calls(), 0);

  const unvalidated = handler({ data: catalog('pending') });
  assert.equal((await unvalidated.run(request({ action: 'board', gameKind: 'fix-the-five', dailySeed: '2026-09-05' }))).status, 503);
  const wrongTarget = handler({ target: 'https://wrong.invalid' });
  assert.equal((await wrongTarget.run(request({ action: 'board', gameKind: 'fix-the-five', dailySeed: '2026-09-05' }))).status, 503);
  assert.equal(wrongTarget.calls(), 0);
});
