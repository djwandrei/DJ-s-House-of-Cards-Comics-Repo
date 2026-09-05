import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SPORTRADAR_NBA_SOURCE,
  buildSportradarNbaDailyChangesUrl,
  buildSportradarNbaPlayByPlayUrl,
  buildSportradarNbaScheduleUrl,
  buildSportradarNbaSummaryUrl,
  compareSportradarPbpEvents,
  createSportradarNbaHeaders,
  fetchSportradarNbaJson,
  normalizeOnCourtSnapshot,
  normalizeSportradarPlayByPlay,
  normalizeSportradarSchedule,
  normalizeSportradarSummary,
  parseSportradarClockMilliseconds,
  parseSportradarMinutes,
  retryAfterMilliseconds,
  SportradarNbaError,
  SportradarNbaNormalizationError
} from '../lib/nba-sportradar-pbp.mjs';

const IDS = Object.freeze({
  game: '11111111-1111-4111-8111-111111111111',
  home: '22222222-2222-4222-8222-222222222222',
  away: '33333333-3333-4333-8333-333333333333',
  eventOne: '44444444-4444-4444-8444-444444444444',
  eventTwo: '55555555-5555-4555-8555-555555555555',
  homePlayers: [
    '60000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000003',
    '60000000-0000-4000-8000-000000000004',
    '60000000-0000-4000-8000-000000000005'
  ],
  awayPlayers: [
    '70000000-0000-4000-8000-000000000001',
    '70000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000003',
    '70000000-0000-4000-8000-000000000004',
    '70000000-0000-4000-8000-000000000005'
  ]
});

function team(id, alias, market, name) {
  return { id, sr_id: `sr:team:${alias}`, reference: alias, alias, market, name, country: 'USA' };
}

function validOnCourt() {
  return {
    home: { players: IDS.homePlayers.map((id) => ({ id })) },
    away: { players: IDS.awayPlayers.map((id) => ({ id })) }
  };
}

test('builds official NBA v8 URLs and keeps API keys out of the URL', () => {
  assert.equal(
    buildSportradarNbaScheduleUrl({ seasonStartYear: 2024, seasonPhase: 'regular', accessLevel: 'production' }),
    'https://api.sportradar.com/nba/production/v8/en/games/2024/REG/schedule.json'
  );
  assert.equal(
    buildSportradarNbaSummaryUrl({ gameId: IDS.game, accessLevel: 'trial', language: 'en' }),
    `https://api.sportradar.com/nba/trial/v8/en/games/${IDS.game}/summary.json`
  );
  assert.equal(
    buildSportradarNbaPlayByPlayUrl({ gameId: IDS.game }),
    `https://api.sportradar.com/nba/production/v8/en/games/${IDS.game}/pbp.json`
  );
  assert.equal(
    buildSportradarNbaDailyChangesUrl({ year: 2025, month: 2, day: 3 }),
    'https://api.sportradar.com/nba/production/v8/en/league/2025/02/03/changes.json'
  );
  const headers = createSportradarNbaHeaders('provider-key-do-not-log', { 'User-Agent': 'DJHC importer' });
  assert.equal(headers['x-api-key'], 'provider-key-do-not-log');
  assert.equal(headers.Accept, 'application/json');
  assert.equal(Object.isFrozen(headers), true);
  assert.throws(
    () => buildSportradarNbaSummaryUrl({ gameId: 'not-a-uuid' }),
    SportradarNbaNormalizationError
  );
});

test('parses PBP clocks and player minutes without guessing invalid values', () => {
  assert.equal(parseSportradarClockMilliseconds('11:40.500'), 700500);
  assert.equal(parseSportradarClockMilliseconds('01:02:03.004'), 3723004);
  assert.equal(parseSportradarClockMilliseconds(null, '00:05'), 5000);
  assert.equal(parseSportradarClockMilliseconds('not-a-clock', null), null);
  assert.equal(parseSportradarMinutes('30:30'), 30.5);
  assert.equal(parseSportradarMinutes(12.25), 12.25);
  assert.throws(() => parseSportradarMinutes('thirty'), SportradarNbaNormalizationError);
});

test('normalizes a schedule only when its games are structurally usable', () => {
  const parsed = normalizeSportradarSchedule({
    generated_at: '2025-01-01T02:00:00Z',
    games: [{
      id: IDS.game,
      sr_id: 'sr:match:one',
      reference: 'GAME-ONE',
      scheduled: '2025-01-02T01:00:00Z',
      status: 'closed',
      coverage: 'full',
      track_on_court: true,
      home: { ...team(IDS.home, 'HOM', 'Home', 'Homes'), points: 110 },
      away: { ...team(IDS.away, 'AWY', 'Away', 'Aways'), points: 105 }
    }]
  }, { seasonStartYear: 2024, seasonPhase: 'regular' });
  assert.equal(parsed.source, SPORTRADAR_NBA_SOURCE);
  assert.equal(parsed.seasonEndYear, 2025);
  assert.equal(parsed.games[0].homePoints, 110);
  assert.equal(parsed.games[0].trackOnCourt, true);
  assert.equal(parsed.games[0].providerStatus, 'closed');
  assert.throws(() => normalizeSportradarSchedule({ games: [{}] }, {
    seasonStartYear: 2024,
    seasonPhase: 'regular'
  }), SportradarNbaNormalizationError);
});

test('normalizes PBP, preserves deleted events, orders by provider sequence, and never accepts a bad snapshot', () => {
  const duplicateHome = validOnCourt();
  duplicateHome.home.players[4] = { id: IDS.homePlayers[0] };
  const parsed = normalizeSportradarPlayByPlay({
    id: IDS.game,
    status: 'closed',
    coverage: 'full',
    track_on_court: true,
    generated_at: '2025-01-02T04:00:00Z',
    periods: [{
      sequence: 1,
      number: 1,
      type: 'REG',
      events: [{
        id: IDS.eventOne,
        sequence: 20,
        number: 2,
        clock_decimal: '11:40.500',
        home_points: 2,
        away_points: 0,
        event_type: 'twopointmade',
        attempt: '1 of 1',
        attribution: { id: IDS.home },
        possession: { id: IDS.away },
        qualifiers: [{ qualifier: 'fastbreak' }],
        statistics: [],
        location: { coord_x: 1, coord_y: 2 },
        created: '2025-01-02T04:00:00Z',
        updated: '2025-01-02T04:00:01Z',
        rescinded: true,
        on_court: validOnCourt()
      }, {
        id: IDS.eventTwo,
        sequence: 10,
        number: 1,
        clock: '11:55',
        home_points: 0,
        away_points: 0,
        event_type: 'foul',
        qualifiers: [],
        statistics: [],
        location: {},
        on_court: duplicateHome
      }]
    }],
    deleted_events: [{ id: IDS.eventOne, sequence: 20, deleted_at: '2025-01-02T04:01:00Z' }]
  }, { expectedGameId: IDS.game });
  assert.deepEqual(parsed.events.map((event) => event.id), [IDS.eventTwo, IDS.eventOne]);
  assert.equal(parsed.events[0].onCourt.snapshotStatus, 'duplicate_player');
  assert.equal(parsed.events[1].onCourt.snapshotStatus, 'valid_five_on_five');
  assert.equal(parsed.events[1].isRescinded, true);
  assert.equal(parsed.events[1].createdByProviderAt, '2025-01-02T04:00:00.000Z');
  assert.equal(parsed.events[1].clockRemainingMs, 700500);
  assert.equal(parsed.events[1].attempt, '1 of 1');
  assert.equal(parsed.deletedEvents[0].id, IDS.eventOne);
  assert.equal(parsed.validSnapshotCount, 1);
  assert.equal(parsed.invalidSnapshotCount, 1);
  assert.ok(compareSportradarPbpEvents(parsed.events[0], parsed.events[1]) < 0);
  assert.throws(() => normalizeSportradarPlayByPlay({ id: IDS.game, periods: [{ events: [{ id: 'invalid' }] }] }), SportradarNbaNormalizationError);
});

test('classifies incomplete or unresolved on-court snapshots as ineligible', () => {
  assert.deepEqual(normalizeOnCourtSnapshot(null), {
    homePlayerIds: [],
    awayPlayerIds: [],
    snapshotStatus: 'missing'
  });
  const unresolved = validOnCourt();
  unresolved.away.players[4] = { id: 'not-a-uuid' };
  assert.equal(normalizeOnCourtSnapshot(unresolved).snapshotStatus, 'unresolved_player');
  const crossTeam = validOnCourt();
  crossTeam.away.players[0] = { id: IDS.homePlayers[0] };
  assert.equal(normalizeOnCourtSnapshot(crossTeam).snapshotStatus, 'cross_team_duplicate');
});

test('normalizes provider summary ratings, possessions, and player minutes', () => {
  const parsed = normalizeSportradarSummary({
    id: IDS.game,
    reference: 'GAME-ONE',
    sr_id: 'sr:match:one',
    status: 'closed',
    scheduled: '2025-01-02T01:00:00Z',
    coverage: 'full',
    track_on_court: true,
    home: {
      ...team(IDS.home, 'HOM', 'Home', 'Homes'),
      points: 112,
      statistics: {
        possessions: 100,
        opponent_possessions: 101,
        offensive_rating: 112,
        defensive_rating: 109.9,
        fast_break_points: 15
      },
      players: [{
        id: IDS.homePlayers[0],
        full_name: 'Home Player',
        first_name: 'Home',
        last_name: 'Player',
        position: 'G',
        jersey_number: '3',
        statistics: {
          minutes: '30:30', plus_minus: 8, offensive_rating: 118.2, defensive_rating: 106.4,
          points: 21, field_goals_made: 7, field_goals_att: 13,
          two_points_made: 4, two_points_att: 7,
          three_points_made: 3, three_points_att: 6,
          free_throws_made: 4, free_throws_att: 5,
          offensive_rebounds: 2, defensive_rebounds: 5, rebounds: 7,
          assists: 6, steals: 1, blocks: 2, turnovers: 3, personal_fouls: 4,
        },
        starter: true,
        active: true,
        on_court: false
      }]
    },
    away: {
      ...team(IDS.away, 'AWY', 'Away', 'Aways'),
      points: 111,
      statistics: { possessions: 101, opponent_possessions: 100, offensive_rating: 109.9, defensive_rating: 112 },
      players: [{ id: IDS.awayPlayers[0], full_name: 'Away Player', statistics: { minutes: 29.5 } }]
    }
  }, { expectedGameId: IDS.game });
  assert.equal(parsed.home.pointsAgainst, 111);
  assert.equal(parsed.home.fastBreakPoints, 15);
  assert.equal(parsed.players[0].minutesPlayed, 30.5);
  assert.equal(parsed.players[0].plusMinus, 8);
  assert.equal(parsed.players[0].isStarter, true);
  assert.deepEqual(parsed.players[0].officialBoxScore, {
    source: 'summary_endpoint',
    availableFields: [
      'points', 'fieldGoalsMade', 'fieldGoalAttempts', 'twoPointMakes', 'twoPointAttempts',
      'threePointersMade', 'threePointAttempts', 'freeThrowsMade', 'freeThrowAttempts',
      'offensiveRebounds', 'defensiveRebounds', 'rebounds', 'assists', 'steals', 'blocks',
      'turnovers', 'personalFouls',
    ],
    fields: {
      points: 21, fieldGoalsMade: 7, fieldGoalAttempts: 13, twoPointMakes: 4, twoPointAttempts: 7,
      threePointersMade: 3, threePointAttempts: 6, freeThrowsMade: 4, freeThrowAttempts: 5,
      offensiveRebounds: 2, defensiveRebounds: 5, rebounds: 7, assists: 6, steals: 1, blocks: 2,
      turnovers: 3, personalFouls: 4,
    },
  });
  assert.equal(parsed.players[1].minutesPlayed, 29.5);
  assert.deepEqual(parsed.players[1].officialBoxScore.availableFields, []);
  assert.equal(parsed.players[1].officialBoxScore.fields.points, null);
  assert.equal(parsed.teams.length, 2);
});

test('uses an injected fetch implementation, retries transient provider responses, and exposes no request key', async () => {
  const calls = [];
  const waits = [];
  let callCount = 0;
  const responseHeaders = (values) => ({ get: (name) => values[String(name).toLowerCase()] ?? null });
  const result = await fetchSportradarNbaJson(buildSportradarNbaSummaryUrl({ gameId: IDS.game }), {
    apiKey: 'test-provider-key',
    maxAttempts: 2,
    fetchImpl: async (url, options) => {
      calls.push({ url, headers: options.headers });
      callCount += 1;
      if (callCount === 1) {
        return { ok: false, status: 429, headers: responseHeaders({ 'retry-after': '0' }) };
      }
      return {
        ok: true,
        status: 200,
        headers: responseHeaders({ etag: '"abc"', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' }),
        json: async () => ({ id: IDS.game })
      };
    },
    sleepImpl: async (milliseconds) => { waits.push(milliseconds); }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['x-api-key'], 'test-provider-key');
  assert.equal(result.payload.id, IDS.game);
  assert.equal(result.etag, '"abc"');
  assert.equal(result.sourceUrl.includes('test-provider-key'), false);
  assert.ok(waits.some((milliseconds) => milliseconds >= 1000));
  assert.equal(retryAfterMilliseconds('2', 0), 2000);
  await assert.rejects(
    fetchSportradarNbaJson('https://example.test/not-allowed', { apiKey: 'test-provider-key', fetchImpl: async () => null }),
    SportradarNbaError
  );
});

test('classifies final provider 429 responses without retaining provider body text', async () => {
  const responseHeaders = { get: () => null };
  for (const [responseText, providerLimit] of [
    ['Quota Exceeded for this usage plan.', 'quota_exceeded'],
    ['Request Throttled. Maximum requests per second exceeded.', 'throttled'],
    ['A generic HTTP 429 response.', 'rate_limited_unknown'],
  ]) {
    await assert.rejects(
      fetchSportradarNbaJson(buildSportradarNbaSummaryUrl({ gameId: IDS.game }), {
        apiKey: 'test-provider-key',
        maxAttempts: 1,
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          headers: responseHeaders,
          text: async () => responseText,
        }),
      }),
      (error) => {
        assert.equal(error instanceof SportradarNbaError, true);
        assert.equal(error.status, 429);
        assert.equal(error.providerLimit, providerLimit);
        assert.equal(error.retryAfterMs, 0);
        assert.equal(error.message.includes(responseText), false);
        return true;
      },
    );
  }
});
