import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseDefaultNbaSeason,
  deriveNbaSeasonMetrics,
  mountNbaSlabStatsPanel,
  normalizeNbaSlabStatsPayload,
  renderNbaSeasonStats,
  renderNbaSlabStatsPanel,
  summarizeNbaCareer,
} from '../../nba-slab-stats.mjs';

const season = (overrides = {}) => ({
  seasonEndYear: 2004,
  seasonLabel: '2003-04',
  phase: 'regular',
  gamesPlayed: 10,
  minutesPlayed: 350,
  points: 200,
  totalRebounds: 80,
  assists: 60,
  steals: 20,
  blocks: 10,
  turnovers: 30,
  fieldGoalPercentage: 0.5,
  threePointPercentage: 0.4,
  freeThrowPercentage: 0.8,
  trueShootingPercentage: 0.61,
  playerEfficiencyRating: 22.2,
  winShares: 4.5,
  winSharesPer48: 0.2,
  boxPlusMinus: 5.3,
  valueOverReplacementPlayer: 3.1,
  ...overrides,
});

const payload = (overrides = {}) => ({
  schemaVersion: 1,
  provider: 'NBA',
  productId: 101,
  players: [{
    mapping: {
      subjectOrder: 1,
      subjectRole: 'primary',
      depictedSeasonLabel: '2003-04',
      depictedSeasonStartYear: 2003,
      depictedSeasonEndYear: 2004,
      seasonMappingMethod: 'title_season_range',
      reviewState: 'auto_verified',
    },
    player: {
      athleteId: 'athlete-lebron',
      nbaPlayerId: 'nba-lebron',
      name: 'LeBron James',
      primaryPosition: 'SF',
      heightInches: 81,
      weightPounds: 250,
      college: '',
      headshotUrl: 'https://example.com/lebron.jpg',
    },
    seasons: [
      season(),
      season({ seasonEndYear: 2005, seasonLabel: '2004-05', points: 250 }),
      season({ seasonEndYear: 2004, phase: 'playoffs', points: 100 }),
    ],
  }],
  ...overrides,
});

test('payload normalization verifies provider, product, players, and unique seasons', () => {
  const normalized = normalizeNbaSlabStatsPayload(payload(), 101);
  assert.equal(normalized.provider, 'NBA');
  assert.equal(normalized.players.length, 1);
  assert.equal(normalized.players[0].seasons.length, 3);
  assert.equal(normalized.players[0].seasons[0].seasonEndYear, 2005);
  assert.equal(normalizeNbaSlabStatsPayload(payload({ provider: 'MLB' }), 101), null);
  assert.equal(normalizeNbaSlabStatsPayload(payload(), 999), null);
});

test('unsafe headshot URLs are discarded without rejecting valid stats', () => {
  const unsafe = payload();
  unsafe.players[0].player.headshotUrl = 'javascript:alert(1)';
  const normalized = normalizeNbaSlabStatsPayload(unsafe, 101);
  assert.equal(normalized.players[0].headshotUrl, '');
});

test('the depicted regular season wins; otherwise the latest regular season is explicit', () => {
  const player = normalizeNbaSlabStatsPayload(payload(), 101).players[0];
  const exact = chooseDefaultNbaSeason(player);
  assert.equal(exact.reason, 'depicted_season');
  assert.equal(exact.season.seasonKey, '2004:regular');

  const unresolved = { ...player, depictedSeasonEndYear: null };
  const latest = chooseDefaultNbaSeason(unresolved);
  assert.equal(latest.reason, 'latest_available');
  assert.equal(latest.season.seasonKey, '2005:regular');
});

test('per-game and career calculations use totals and exclude playoffs from career', () => {
  const player = normalizeNbaSlabStatsPayload(payload(), 101).players[0];
  const metrics = deriveNbaSeasonMetrics(player.seasons.find((entry) => entry.seasonKey === '2004:regular'));
  assert.equal(metrics.pointsPerGame, 20);
  assert.equal(metrics.reboundsPerGame, 8);
  assert.equal(metrics.assistsPerGame, 6);

  const career = summarizeNbaCareer(player);
  assert.equal(career.seasons, 2);
  assert.equal(career.gamesPlayed, 20);
  assert.equal(career.pointsPerGame, 22.5);
});

test('rendered panel labels historical context and escapes athlete content', () => {
  const raw = payload();
  raw.players[0].player.name = '<script>bad</script>';
  const normalized = normalizeNbaSlabStatsPayload(raw, 101);
  const markup = renderNbaSlabStatsPanel(normalized);
  assert.match(markup, /DJ's Slab-to-Stats/);
  assert.match(markup, /Historical performance only/);
  assert.match(markup, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>bad<\/script>/);
  assert.match(markup, /Explore DJ's Lineup Lab/);
});

test('season rendering handles unavailable advanced metrics without fabricating values', () => {
  const player = normalizeNbaSlabStatsPayload(payload(), 101).players[0];
  const withoutAdvanced = {
    ...player,
    seasons: [{
      ...player.seasons[0],
      trueShootingPercentage: null,
      boxPlusMinus: null,
      valueOverReplacementPlayer: null,
    }],
  };
  const markup = renderNbaSeasonStats(withoutAdvanced, withoutAdvanced.seasons[0].seasonKey);
  assert.match(markup, /<span>TS%<\/span>\s*<strong>&mdash;<\/strong>/);
  assert.match(markup, /<span>BPM<\/span>\s*<strong>&mdash;<\/strong>/);
  assert.match(markup, /<span>VORP<\/span>\s*<strong>&mdash;<\/strong>/);
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
    const mounted = await mountNbaSlabStatsPanel(container, { id: 101 }, {
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
