import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCES,
  buildHeadshotRows,
  buildLogoRows,
  extractHeadshot,
  extractTeamPageHeadshots,
  parseArgs,
} from '../import-sports-reference-media.mjs';

test('media options default to both sports and 2010 headshots', () => {
  assert.deepEqual(parseArgs([]), {
    help: false,
    sports: ['mlb', 'nfl'],
    kind: 'all',
    start: 1950,
    end: new Date().getUTCFullYear(),
    profileStart: 2010,
    cacheOnly: false,
    apply: false,
    analytics: false,
  });
});

test('team logo templates preserve historical season and source codes', () => {
  assert.equal(SOURCES.mlb.teamLogoUrl('NYY', 1950), 'https://cdn.ssref.net/req/202608270/tlogo/br/NYY-1950.png');
  assert.equal(SOURCES.nfl.teamLogoUrl('CIN', 1981), 'https://cdn.ssref.net/req/202608202/tlogo/pfr/cin-1981.png');
  const rows = buildLogoRows(SOURCES.mlb, [{ id: 1, season_year: 1950, team_code: 'NYY', team_name: 'New York Yankees' }], { start: 1950, end: 1950 });
  assert.equal(rows[0].capture_method, 'derived_template');
  assert.equal(rows[0].asset_kind, 'team_logo');
});

test('headshot extraction accepts only source-hosted image paths', () => {
  const html = '<img alt="Photo of Player" src="https://www.baseball-reference.com/req/2025011210/images/headshots/a/player_sabr.jpg">';
  assert.equal(extractHeadshot(html, SOURCES.mlb), 'https://www.baseball-reference.com/req/2025011210/images/headshots/a/player_sabr.jpg');
  assert.equal(extractHeadshot('<img src="https://example.com/player.jpg">', SOURCES.mlb), '');
});

test('headshot rows honor the 2010 eligibility floor and browser cache', () => {
  const rows = buildHeadshotRows(SOURCES.nfl, [
    { player_id: '00000000-0000-4000-8000-000000000001', full_name: 'Modern Player', external_id: 'MahoPa00', first_season: 2017 },
    { player_id: '00000000-0000-4000-8000-000000000002', full_name: 'Historical Player', external_id: 'OldPlr00', first_season: 1980 },
  ], { profileStart: 2010 });
  // The test intentionally supplies no cache files; missing browser captures
  // are skipped rather than guessed or fetched unattended.
  assert.deepEqual(rows, []);
});

test('team-page headshots pair the source player ID with the nearby image', () => {
  const html = '<div><a href="/players/y/youngch04.shtml"><img src="https://www.baseball-reference.com/req/2025011210/images/headshots/f/player.jpg" alt="Photo of Chris Young"></a></div>';
  const found = extractTeamPageHeadshots(html, SOURCES.mlb, 'https://www.baseball-reference.com/teams/ARI/2010.shtml');
  assert.equal(found.get('youngch04').assetUrl.endsWith('/images/headshots/f/player.jpg'), true);
});
