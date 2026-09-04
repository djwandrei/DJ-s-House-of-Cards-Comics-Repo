import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseDefaultProSportsSeason,
  mountProSportsSlabStatsPanel,
  normalizeProSportsSlabStatsPayload,
  renderProSportsSeasonStats,
  renderProSportsSlabStatsPanel,
} from '../../pro-sports-slab-stats.mjs';

const mapping = (overrides = {}) => ({
  subjectOrder: 1,
  subjectRole: 'primary',
  depictedSeasonLabel: '2024',
  depictedSeasonStartYear: 2024,
  depictedSeasonEndYear: 2024,
  seasonMappingMethod: 'title_year',
  reviewState: 'human_verified',
  ...overrides,
});

const mlbPayload = (overrides = {}) => ({
  schemaVersion: 1,
  provider: 'MLB',
  productId: 101,
  players: [{
    mapping: mapping(),
    player: {
      athleteId: 'athlete-mlb-one',
      leagueCode: 'MLB',
      name: 'Example Hitter',
      primaryPosition: 'CF',
      headshotUrl: 'https://example.com/hitter.jpg',
    },
    seasons: [{
      seasonEndYear: 2024,
      seasonLabel: '2024',
      phase: 'regular',
      statGroup: 'batting',
      gamesPlayed: 150,
      metrics: {
        battingAverage: 0.301,
        homeRuns: 31,
        runsBattedIn: 99,
        onBasePlusSlugging: 0.901,
        stolenBases: 18,
        war: 5.2,
        plateAppearances: 640,
      },
    }, {
      seasonEndYear: 2024,
      seasonLabel: '2024',
      phase: 'regular',
      statGroup: 'pitching',
      gamesPlayed: 1,
      metrics: { wins: 0, losses: 0, earnedRunAverage: 0 },
    }, {
      seasonEndYear: 2025,
      seasonLabel: '2025',
      phase: 'regular',
      statGroup: 'batting',
      gamesPlayed: 10,
      metrics: { battingAverage: 0.2 },
    }],
  }],
  ...overrides,
});

const nflPayload = (overrides = {}) => ({
  schemaVersion: 1,
  provider: 'NFL',
  productId: 202,
  players: [{
    mapping: mapping({ depictedSeasonEndYear: 2023, depictedSeasonLabel: '2023' }),
    player: {
      athleteId: 'athlete-nfl-one',
      leagueCode: 'NFL',
      name: 'Example Quarterback',
      primaryPosition: 'QB',
      headshotUrl: 'https://example.com/qb.jpg',
    },
    seasons: [{
      seasonEndYear: 2023,
      seasonLabel: '2023',
      phase: 'regular',
      statGroup: 'passing',
      gamesPlayed: 17,
      gamesStarted: 17,
      metrics: {
        passingYards: 4300,
        passingTouchdowns: 31,
        interceptions: 10,
        completionPercentage: 67.4,
        passerRating: 101.2,
        yardsPerAttempt: 7.5,
        completions: 401,
        attempts: 595,
      },
    }],
  }],
  ...overrides,
});

test('MLB normalization retains only expected provider fields and depicted-position defaults', () => {
  const normalized = normalizeProSportsSlabStatsPayload(mlbPayload(), 101);
  assert.equal(normalized.provider, 'MLB');
  assert.equal(normalized.players.length, 1);
  assert.equal(normalized.players[0].seasons.length, 2);

  const selection = chooseDefaultProSportsSeason(normalized.players[0], normalized.provider);
  assert.equal(selection.reason, 'depicted_season');
  assert.equal(selection.season.seasonKey, '2024:regular:batting');
});

test('MLB scorebook-code pitchers hide ordinary batting seasons but retain real two-way seasons', () => {
  const raw = mlbPayload();
  raw.players[0].player.primaryPosition = '/1';
  raw.players[0].seasons = [{
    seasonEndYear: 2024,
    seasonLabel: '2024',
    phase: 'regular',
    statGroup: 'pitching',
    gamesPlayed: 30,
    metrics: { inningsPitchedOuts: 450, strikeouts: 170 },
  }, {
    seasonEndYear: 2024,
    seasonLabel: '2024',
    phase: 'regular',
    statGroup: 'batting',
    gamesPlayed: 30,
    metrics: { plateAppearances: 149, atBats: 132, hits: 29 },
  }, {
    seasonEndYear: 2023,
    seasonLabel: '2023',
    phase: 'regular',
    statGroup: 'batting',
    gamesPlayed: 120,
    metrics: { plateAppearances: 415, atBats: 370, hits: 100 },
  }];

  const normalized = normalizeProSportsSlabStatsPayload(raw, 101);
  assert.deepEqual(
    normalized.players[0].seasons.map((season) => season.seasonKey),
    ['2024:regular:pitching', '2023:regular:batting'],
  );
  assert.equal(
    chooseDefaultProSportsSeason(normalized.players[0], normalized.provider).season.seasonKey,
    '2024:regular:pitching',
  );
  assert.doesNotMatch(renderProSportsSlabStatsPanel(normalized), /2024 - Regular season · Batting/);
});

test('NFL position preference selects passing when a depicted year has multiple stat groups', () => {
  const raw = nflPayload();
  raw.players[0].seasons.push({
    seasonEndYear: 2023,
    seasonLabel: '2023',
    phase: 'regular',
    statGroup: 'rushing',
    gamesPlayed: 17,
    metrics: { rushingYards: 200 },
  });
  const normalized = normalizeProSportsSlabStatsPayload(raw, 202);
  const selection = chooseDefaultProSportsSeason(normalized.players[0], normalized.provider);
  assert.equal(selection.season.seasonKey, '2023:regular:passing');

  const markup = renderProSportsSeasonStats(normalized.players[0], normalized.provider, selection.season.seasonKey);
  assert.match(markup, /<span>YDS<\/span><strong>4,300<\/strong>/);
  assert.match(markup, /<span>CMP%<\/span><strong>67\.4%<\/strong>/);
});

test('NFL suppresses all-zero cross-position templates while retaining actual multi-role contributions', () => {
  const raw = nflPayload();
  raw.players[0].seasons.push({
    seasonEndYear: 2023,
    seasonLabel: '2023',
    phase: 'regular',
    statGroup: 'receiving',
    gamesPlayed: 17,
    metrics: { receptions: 0, targets: 0, receivingYards: 0, receivingTouchdowns: 0 },
  }, {
    seasonEndYear: 2023,
    seasonLabel: '2023',
    phase: 'regular',
    statGroup: 'rushing',
    gamesPlayed: 17,
    metrics: { attempts: 44, rushingYards: 200, rushingTouchdowns: 2 },
  });

  const normalized = normalizeProSportsSlabStatsPayload(raw, 202);
  assert.deepEqual(
    normalized.players[0].seasons.map((season) => season.seasonKey),
    ['2023:regular:passing', '2023:regular:rushing'],
  );
  assert.doesNotMatch(renderProSportsSlabStatsPanel(normalized), /Receiving/);

  raw.players[0].seasons[1].metrics = {
    receptions: 1,
    targets: 1,
    receivingYards: 12,
    receivingTouchdowns: 0,
  };
  const withRealReception = normalizeProSportsSlabStatsPayload(raw, 202);
  assert.ok(
    withRealReception.players[0].seasons.some((season) => season.seasonKey === '2023:regular:receiving'),
    'a real QB reception must remain selectable',
  );
});

test('payload verification rejects the wrong provider or product and discards unsafe headshots', () => {
  const unsafe = mlbPayload();
  unsafe.players[0].player.headshotUrl = 'javascript:alert(1)';
  const normalized = normalizeProSportsSlabStatsPayload(unsafe, 101);
  assert.equal(normalized.players[0].headshotUrl, '');
  assert.equal(normalizeProSportsSlabStatsPayload(mlbPayload({ provider: 'NBA' }), 101), null);
  assert.equal(normalizeProSportsSlabStatsPayload(mlbPayload(), 999), null);
});

test('rendered markup escapes player content and never substitutes unavailable statistics', () => {
  const raw = mlbPayload();
  raw.players[0].player.name = '<script>bad</script>';
  raw.players[0].seasons[0].metrics.war = null;
  const normalized = normalizeProSportsSlabStatsPayload(raw, 101);
  const panel = renderProSportsSlabStatsPanel(normalized);
  const season = renderProSportsSeasonStats(normalized.players[0], normalized.provider, '2024:regular:batting');
  assert.match(panel, /DJ&apos;s Slab-to-Stats/);
  assert.match(panel, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(panel, /<script>bad<\/script>/);
  assert.match(panel, /Historical performance only/);
  assert.match(season, /<span>WAR<\/span><strong>&mdash;<\/strong>/);
});

test('a player with no valid season payload is retained but renders an explicit empty state', () => {
  const raw = nflPayload();
  raw.players[0].seasons = [{ seasonEndYear: 2023, phase: 'invalid', statGroup: 'passing' }];
  const normalized = normalizeProSportsSlabStatsPayload(raw, 202);
  assert.equal(normalized.players[0].seasons.length, 0);
  assert.match(renderProSportsSeasonStats(normalized.players[0], normalized.provider), /not available/);
});

test('a no-match mount clears its loading state before hiding the panel', async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  class FakeHTMLElement {
    constructor() {
      this.hidden = false;
      this.isConnected = true;
      this.attributes = new Map();
      this.innerHTML = '';
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    replaceChildren() { this.innerHTML = ''; }
  }
  globalThis.HTMLElement = FakeHTMLElement;
  try {
    const container = new FakeHTMLElement();
    const mounted = await mountProSportsSlabStatsPanel(container, { id: 202 }, {
      requestStats: async () => null,
      isCurrent: () => true,
    });
    assert.equal(mounted, false);
    assert.equal(container.hidden, true);
    assert.equal(container.getAttribute('aria-busy'), null);
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});
