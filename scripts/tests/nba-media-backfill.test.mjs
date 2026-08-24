import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MediaRequestLimitReachedError,
  basketballReferenceMediaPageUrl,
  basketballReferenceTeamLogoRevision,
  basketballReferenceTeamLogoRevisionFromLeagueHtml,
  basketballReferenceTeamLogoUrlFromRevision,
  blankMediaCheckpoint,
  buildDerivedTeamLogoAssetPlan,
  buildMediaCandidateQuery,
  buildTrustedTeamLogoRevisionCatalog,
  createMediaRequestBudget,
  hasConfirmedExistingMedia,
  isExactBasketballReferenceMediaPageUrl,
  isMatchingMediaCheckpoint,
  mediaCacheRelativePath,
  normalizeMediaCandidateRows,
  normalizedMediaAltText,
  recordMediaCandidateStatus,
  shouldAttemptMediaCandidate,
  validatedBasketballReferenceMediaUrl,
} from '../lib/nba-media-backfill.mjs';
import {
  buildMediaSql,
  createPageFetcher,
  optionsFromArgs,
} from '../import-nba-basketball-reference.mjs';
import { parseRobotsTxt } from '../update-nba-basketball-reference-weekly.mjs';

const player = Object.freeze({
  subjectType: 'player',
  externalId: 'abdulka01',
  fullName: 'Kareem Abdul-Jabbar',
});

const team = Object.freeze({
  subjectType: 'team',
  teamCode: 'LAL',
  teamName: 'Los Angeles Lakers',
  seasonEndYear: 1980,
});

test('candidate SQL globally de-duplicates players while retaining team seasons', () => {
  const sql = buildMediaCandidateQuery({
    start: 1980,
    end: 2026,
    phases: ['regular', 'playoffs'],
    teamCode: 'LAL',
  });
  assert.match(sql, /select distinct on \(external_ids\.external_id\)/i);
  assert.match(sql, /stats\.season_phase in \('regular', 'playoffs'\)/i);
  assert.match(sql, /stats\.team_code = 'LAL'/i);
  assert.match(sql, /external_ids\.source_name = 'basketball_reference'/i);
  assert.match(sql, /select distinct\s+'team'::text as subject_type/i);
  assert.match(sql, /team_seasons\.id as team_season_id/i);
  assert.match(sql, /media\.rights_confirmed/i);
  assert.match(sql, /existing_media\.source_name as existing_source_name/i);
  assert.match(sql, /select media\.asset_url, media\.rights_confirmed, media\.source_name, media\.source_url/i);
  assert.match(sql, /left join lateral/i);
  assert.doesNotMatch(sql, /insert\s+into|update\s+public|delete\s+from/i);
});

test('candidate row normalization is defensive across regular/playoff duplicates', () => {
  const rows = [
    {
      subject_type: 'player', external_id: 'AbdulKa01', full_name: '  Kareem  Abdul-Jabbar ',
      existing_asset_url: '', existing_rights_confirmed: false,
    },
    {
      subject_type: 'player', external_id: 'abdulka01', full_name: 'Kareem Abdul-Jabbar',
      existing_asset_url: '', existing_rights_confirmed: false,
    },
    {
      subject_type: 'team', season_end_year: '1980', team_code: 'lal', team_name: 'Los Angeles Lakers',
      existing_asset_url: '', existing_rights_confirmed: false,
    },
    {
      subject_type: 'team', season_end_year: 1981, team_code: 'LAL', team_name: 'Los Angeles Lakers',
      existing_asset_url: '', existing_rights_confirmed: false,
    },
  ];
  const candidates = normalizeMediaCandidateRows(rows);
  assert.equal(candidates.length, 3);
  assert.equal(candidates.filter((candidate) => candidate.subjectType === 'player').length, 1);
  assert.deepEqual(candidates.filter((candidate) => candidate.subjectType === 'team').map((candidate) => candidate.key), [
    'team:1980:LAL',
    'team:1981:LAL',
  ]);
});

test('media assets require exact provider host and subject-specific path', () => {
  const headshot = 'https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg';
  const logo = 'https://cdn.ssref.net/req/202608202/tlogo/bbr/LAL-1980.png';
  assert.equal(validatedBasketballReferenceMediaUrl(player, headshot), headshot);
  assert.equal(validatedBasketballReferenceMediaUrl(team, logo), logo);

  const rejected = [
    'http://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg',
    'https://basketball-reference.com.example.test/req/202605210/images/headshots/abdulka01.jpg',
    'https://www.basketball-reference.com/req/202605210/images/headshots/jamesle01.jpg',
    'https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg?download=1',
    // Assemble the deliberately unsafe credential form at runtime so the
    // repository secret scanner does not mistake this negative fixture for a
    // stored basic-auth URL.
    `https://${['user', 'pass'].join(':')}@www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg`,
  ];
  for (const url of rejected) assert.equal(validatedBasketballReferenceMediaUrl(player, url), '');
  assert.equal(validatedBasketballReferenceMediaUrl(team,
    'https://cdn.ssref.net/req/202608202/tlogo/bbr/LAL-1981.png'), '');
  assert.equal(validatedBasketballReferenceMediaUrl(team,
    'https://www.basketball-reference.com/req/202608202/tlogo/bbr/LAL-1980.png'), '');
});

test('team-logo revisions are derived only from exact league or candidate URLs', () => {
  const leagueHtml = `
    <img src="https://cdn.ssref.net/req/202608202/tlogo/bbr/NBA-1980.png" alt="NBA logo">
    <img src="https://cdn.ssref.net/req/202608202/favicons/bbr/favicon-48.png" alt="">
  `;
  assert.equal(basketballReferenceTeamLogoRevisionFromLeagueHtml(leagueHtml, 1980), '202608202');
  assert.equal(basketballReferenceTeamLogoRevisionFromLeagueHtml(
    '<img src="https://cdn.ssref.net/req/202608202/tlogo/bbr/NBA-1981.png">', 1980), '');
  assert.equal(basketballReferenceTeamLogoRevisionFromLeagueHtml(
    '<img src="https://cdn.ssref.net/req/202608202/tlogo/bbr/NBA-1980.png?download=1">', 1980), '');
  assert.equal(basketballReferenceTeamLogoRevisionFromLeagueHtml(`
    <img src="https://cdn.ssref.net/req/revision-a/tlogo/bbr/NBA-1980.png">
    <img src="https://cdn.ssref.net/req/revision-b/tlogo/bbr/NBA-1980.png">
  `, 1980), '');
  assert.equal(basketballReferenceTeamLogoRevisionFromLeagueHtml(
    '<img src="https://cdn.ssref.net.example.test/req/202608202/tlogo/bbr/NBA-1980.png">', 1980), '');

  const exactLogo = 'https://cdn.ssref.net/req/202608202/tlogo/bbr/LAL-1980.png';
  assert.equal(basketballReferenceTeamLogoRevision(team, exactLogo), '202608202');
  assert.equal(basketballReferenceTeamLogoRevision(
    { ...team, teamCode: 'SDC' }, exactLogo), '');
  assert.equal(basketballReferenceTeamLogoRevision(player, exactLogo), '');
});

test('trusted team-logo catalog preserves historical code/year and fails closed on conflicts', () => {
  const confirmed1981 = {
    ...team,
    seasonEndYear: 1981,
    existingRightsConfirmed: true,
    existingSourceName: 'basketball_reference',
    existingAssetUrl: 'https://cdn.ssref.net/req/confirmed-revision/tlogo/bbr/LAL-1981.png',
  };
  const catalog = buildTrustedTeamLogoRevisionCatalog({
    candidates: [confirmed1981, player],
    cachedLeagueHtmlBySeason: new Map([[
      1980,
      '<img src="https://cdn.ssref.net/req/league-revision/tlogo/bbr/NBA-1980.png">',
    ]]),
  });
  const sanDiego1980 = { ...team, teamCode: 'SDC', teamName: 'San Diego Clippers' };
  assert.equal(catalog.revisionFor(sanDiego1980), 'league-revision');
  assert.equal(
    basketballReferenceTeamLogoUrlFromRevision(sanDiego1980, catalog.revisionFor(sanDiego1980)),
    'https://cdn.ssref.net/req/league-revision/tlogo/bbr/SDC-1980.png'
  );
  assert.equal(catalog.revisionFor(confirmed1981), 'confirmed-revision');
  assert.equal(catalog.revisionFor({ ...team, seasonEndYear: 1982 }), 'confirmed-revision');
  assert.equal(catalog.revisionFor(player), '');
  assert.deepEqual({
    leagueSeasons: catalog.leagueSeasons,
    confirmedSeasons: catalog.confirmedSeasons,
    hasUniqueGlobalRevision: catalog.hasUniqueGlobalRevision,
  }, {
    leagueSeasons: 1,
    confirmedSeasons: 1,
    hasUniqueGlobalRevision: true,
  });

  const conflictingCatalog = buildTrustedTeamLogoRevisionCatalog({
    candidates: [
      confirmed1981,
      {
        ...team,
        seasonEndYear: 1982,
        existingRightsConfirmed: true,
        existingSourceName: 'basketball_reference',
        existingAssetUrl: 'https://cdn.ssref.net/req/other-revision/tlogo/bbr/LAL-1982.png',
      },
      {
        ...team,
        seasonEndYear: 1983,
        existingRightsConfirmed: true,
        existingSourceName: 'other_provider',
        existingAssetUrl: 'https://cdn.ssref.net/req/ignored-revision/tlogo/bbr/LAL-1983.png',
      },
    ],
  });
  assert.equal(conflictingCatalog.hasUniqueGlobalRevision, false);
  assert.equal(conflictingCatalog.revisionFor({ ...team, seasonEndYear: 1984 }), '');
  assert.equal(conflictingCatalog.revisionFor(confirmed1981), 'confirmed-revision');
});

test('derived team-logo plan is independent of player-first candidate order', () => {
  const sanDiego1980 = {
    ...team,
    teamCode: 'SDC',
    teamName: 'San Diego Clippers',
  };
  const unavailable1981 = { ...team, seasonEndYear: 1981 };
  const catalog = {
    revisionFor(candidate) {
      return candidate.seasonEndYear === 1980 ? 'trusted-revision' : '';
    },
  };
  const originalOrder = [player, sanDiego1980, unavailable1981];
  const plan = buildDerivedTeamLogoAssetPlan(originalOrder, catalog);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].candidate, sanDiego1980);
  assert.equal(plan[0].assetUrl,
    'https://cdn.ssref.net/req/trusted-revision/tlogo/bbr/SDC-1980.png');
  // Planning does not reorder or remove the fallback candidates; the importer
  // can still iterate this original list for players and unavailable teams.
  assert.deepEqual(originalOrder, [player, sanDiego1980, unavailable1981]);
});

test('Basketball Reference existing media skips only after exact URL validation', () => {
  assert.equal(hasConfirmedExistingMedia({
    ...player,
    existingRightsConfirmed: true,
    existingSourceName: 'basketball_reference',
    existingAssetUrl: 'https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg',
  }), true);
  assert.equal(hasConfirmedExistingMedia({
    ...player,
    existingRightsConfirmed: true,
    existingSourceName: 'basketball_reference',
    existingAssetUrl: 'https://evil.example/images/headshots/abdulka01.jpg',
  }), false);
  assert.equal(hasConfirmedExistingMedia({
    ...player,
    existingRightsConfirmed: false,
    existingSourceName: 'basketball_reference',
    existingAssetUrl: 'https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg',
  }), false);
});

test('rights-confirmed primary media from another provider is preserved', () => {
  assert.equal(hasConfirmedExistingMedia({
    ...player,
    existingRightsConfirmed: true,
    existingSourceName: 'licensed_portrait_partner',
    existingAssetUrl: 'https://media.partner.example/players/abdulka01.webp',
  }), true);
  assert.equal(hasConfirmedExistingMedia({
    ...team,
    existingRightsConfirmed: true,
    existingSourceName: 'historic_logo_archive',
    existingAssetUrl: 'https://logos.partner.example/LAL-1980.svg',
  }), true);
  assert.equal(hasConfirmedExistingMedia({
    ...player,
    existingRightsConfirmed: false,
    existingSourceName: 'licensed_portrait_partner',
    existingAssetUrl: 'https://media.partner.example/players/abdulka01.webp',
  }), false);
});

test('source page URLs and cache keys are exact and globally stable', () => {
  const playerUrl = basketballReferenceMediaPageUrl(player);
  const teamUrl = basketballReferenceMediaPageUrl(team);
  assert.equal(playerUrl, 'https://www.basketball-reference.com/players/a/abdulka01.html');
  assert.equal(teamUrl, 'https://www.basketball-reference.com/teams/LAL/1980.html');
  assert.equal(isExactBasketballReferenceMediaPageUrl(player, playerUrl), true);
  assert.equal(isExactBasketballReferenceMediaPageUrl(player, `${playerUrl}?x=1`), false);
  assert.equal(mediaCacheRelativePath(player), 'media/player/abdulka01.html');
  assert.equal(mediaCacheRelativePath({ ...player, seasonEndYear: 1980 }), 'media/player/abdulka01.html');
  assert.equal(mediaCacheRelativePath(team), 'media/team/1980-LAL.html');
  assert.equal(mediaCacheRelativePath({ ...team, seasonEndYear: 1981 }), 'media/team/1981-LAL.html');
});

test('request budget counts actual attempts and fails before exceeding its limit', () => {
  const budget = createMediaRequestBudget(2);
  assert.equal(budget.consume(), 1);
  assert.equal(budget.consume(), 2);
  assert.deepEqual(budget.snapshot(), { limit: 2, used: 2, remaining: 0 });
  assert.throws(() => budget.consume(), MediaRequestLimitReachedError);
  assert.deepEqual(budget.snapshot(), { limit: 2, used: 2, remaining: 0 });
});

test('page fetcher spends the media budget only on actual HTTP attempts', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'djhc-media-fetch-test-'));
  try {
    const budget = createMediaRequestBudget(1);
    const robots = parseRobotsTxt('User-agent: *\nAllow: /\nCrawl-delay: 0\n');
    let fetchCalls = 0;
    const fetchImplementation = async () => {
      fetchCalls += 1;
      return new Response('<html>cached</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const fetchPage = createPageFetcher({
      cacheDirectory: temporaryDirectory,
      requestDelayMs: 0,
      refreshCache: false,
      robots,
      mediaRequestBudget: budget,
      fetchImplementation,
      sleepImplementation: async () => {},
    });
    const firstCache = path.join(temporaryDirectory, 'player-a.html');
    const pageUrl = 'https://www.basketball-reference.com/players/a/abdulka01.html';
    assert.equal(await fetchPage({ url: pageUrl, cacheFile: firstCache, requestKind: 'media' }), '<html>cached</html>');
    assert.equal(await fetchPage({ url: pageUrl, cacheFile: firstCache, requestKind: 'media' }), '<html>cached</html>');
    await assert.rejects(() => fetchPage({
      url: 'https://www.basketball-reference.com/players/j/jamesle01.html',
      cacheFile: path.join(temporaryDirectory, 'player-b.html'),
      requestKind: 'media',
    }), MediaRequestLimitReachedError);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(budget.snapshot(), { limit: 1, used: 1, remaining: 0 });

    const blockedFetcher = createPageFetcher({
      cacheDirectory: temporaryDirectory,
      requestDelayMs: 0,
      refreshCache: false,
      robots: parseRobotsTxt('User-agent: *\nDisallow: /players/\n'),
      mediaRequestBudget: createMediaRequestBudget(1),
      fetchImplementation,
      sleepImplementation: async () => {},
    });
    await assert.rejects(() => blockedFetcher({
      url: pageUrl,
      cacheFile: firstCache,
      requestKind: 'media',
    }), /robots\.txt disallows/);
    assert.equal(fetchCalls, 1);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('media SQL is a small-batch idempotent update-or-insert transaction', () => {
  const sql = buildMediaSql({
    mediaRows: [{
      subject_type: 'player',
      external_id: 'abdulka01',
      season_end_year: null,
      team_code: null,
      asset_kind: 'headshot',
      asset_url: 'https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg',
      alt_text: 'Kareem Abdul-Jabbar headshot',
      source_url: 'https://www.basketball-reference.com/players/a/abdulka01.html',
    }],
  });
  assert.match(sql, /^\s*begin;/i);
  assert.match(sql, /update public\.nba_media_assets as media/i);
  assert.match(sql, /update public\.nba_media_assets as media[\s\S]*?and media\.source_name = 'basketball_reference'/i);
  assert.match(sql, /insert into public\.nba_media_assets/i);
  assert.match(sql, /and not exists\s*\(/i);
  const insertSection = sql.slice(sql.indexOf('insert into public.nba_media_assets'));
  const notExistsSection = insertSection.slice(insertSection.indexOf('and not exists'));
  assert.doesNotMatch(notExistsSection, /existing_media\.source_name\s*=/i);
  assert.match(sql, /commit;\s*$/i);
  assert.doesNotMatch(sql, /delete\s+from|truncate\s+/i);
});

test('CLI exposes bounded requests, bounded batches, and the legacy alias', () => {
  const current = optionsFromArgs([
    '--media-only', '--apply', '--media-request-limit', '75', '--media-batch-size', '20',
    '--season-start', '1980', '--season-end', '2026',
  ]);
  assert.equal(current.mediaRequestLimit, 75);
  assert.equal(current.mediaBatchSize, 20);
  assert.equal(optionsFromArgs(['--media-limit', '8']).mediaRequestLimit, 8);
  assert.throws(() => optionsFromArgs(['--media-limit', '8', '--media-request-limit', '9']));
  assert.throws(() => optionsFromArgs(['--media-batch-size', '101']));
  assert.throws(() => optionsFromArgs(['--media-only', '--media-request-limit', '1']), /requires --apply/);
  assert.throws(() => optionsFromArgs(['--media-only', '--apply']), /positive --media-request-limit/);
});

test('checkpoint statuses resume retry and stop found/no-image candidates', () => {
  const options = { start: 1980, end: 2026, phases: ['regular', 'playoffs'], teamCode: '' };
  const checkpoint = blankMediaCheckpoint(options);
  assert.equal(isMatchingMediaCheckpoint(checkpoint, options), true);
  assert.equal(shouldAttemptMediaCandidate(checkpoint, player), true);

  recordMediaCandidateStatus(checkpoint, player, 'retry', { reason: 'temporary' });
  assert.equal(shouldAttemptMediaCandidate(checkpoint, player), true);
  assert.equal(checkpoint.candidates['player:abdulka01'].attempts, 1);

  recordMediaCandidateStatus(checkpoint, player, 'found', { assetUrl: 'https://example.test/a.jpg' });
  assert.equal(shouldAttemptMediaCandidate(checkpoint, player), false);
  assert.equal(checkpoint.candidates['player:abdulka01'].attempts, 2);

  recordMediaCandidateStatus(checkpoint, team, 'no-image', { reason: 'absent' });
  assert.equal(shouldAttemptMediaCandidate(checkpoint, team), false);
  assert.throws(() => recordMediaCandidateStatus(checkpoint, team, 'pending'));
});

test('alt text is normalized and free of provider footnotes or markup', () => {
  assert.equal(normalizedMediaAltText('player', '  Kareem <b>Abdul-Jabbar</b>*  '), 'Kareem Abdul-Jabbar headshot');
  assert.equal(normalizedMediaAltText('team', 'Los Angeles Lakers logo'), 'Los Angeles Lakers logo');
  assert.equal(normalizedMediaAltText('team', '', 'LAL'), 'LAL logo');
});
