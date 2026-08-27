import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  buildImporterArgs,
  crawlDelayForUserAgent,
  DEFAULT_REQUEST_DELAY_MS,
  isConfirmationPresent,
  isPathAllowedByRobots,
  parseRobotsTxt,
  parseWeeklyUpdateOptions,
  seasonEndYearForDate,
  shouldAllowMissingPlayoffs,
  sourcePathsForSeason
} from '../update-nba-basketball-reference-weekly.mjs';

const currentRobotsShape = `
User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /basketball/
Disallow: */gamelog/

Disallow: /req/

Crawl-delay: 3
`;

test('selects the NBA season ending year at the October boundary', () => {
  assert.equal(seasonEndYearForDate('2026-08-23T12:00:00Z'), 2026);
  assert.equal(seasonEndYearForDate('2026-09-30T23:59:59Z'), 2026);
  assert.equal(seasonEndYearForDate('2026-10-01T00:00:00Z'), 2027);
  assert.equal(seasonEndYearForDate('2027-01-15T12:00:00Z'), 2027);
});

test('parses wildcard robots rules and the declared crawl delay', () => {
  const robots = parseRobotsTxt(currentRobotsShape);
  assert.equal(robots.crawlDelaySeconds, 3);
  assert.equal(isPathAllowedByRobots('/leagues/NBA_2026_totals.html', robots), true);
  assert.equal(isPathAllowedByRobots('/playoffs/NBA_2026_advanced.html', robots), true);
  assert.equal(isPathAllowedByRobots('/req/20260823/images/example.png', robots), false);
  assert.equal(isPathAllowedByRobots('/players/a/example/gamelog/2026', robots), false);
});

test('uses the most specific robots rule and lets Allow win an equal tie', () => {
  const robots = parseRobotsTxt(`
User-agent: *
Disallow: /leagues/
Allow: /leagues/NBA_2026_totals.html$
`);
  assert.equal(isPathAllowedByRobots('/leagues/NBA_2026_totals.html', robots), true);
  assert.equal(isPathAllowedByRobots('/leagues/NBA_2026_advanced.html', robots), false);
});

test('honors a crawler-specific group ahead of the wildcard group', () => {
  const robots = parseRobotsTxt(`
User-agent: DJHC-Lineup-Lab-Updater
Disallow: /
Crawl-delay: 9

User-agent: *
Disallow: /req/
Crawl-delay: 3
`);
  const userAgent = 'DJHC-Lineup-Lab-Updater/1.0 (+https://example.test/contact)';
  assert.equal(isPathAllowedByRobots('/leagues/NBA_2026_totals.html', robots, userAgent), false);
  assert.equal(crawlDelayForUserAgent(robots, userAgent), 9);
  assert.equal(crawlDelayForUserAgent(robots, 'AnotherBot/1.0'), 3);
});

test('builds a fresh one-season importer command with no media crawl', () => {
  const options = parseWeeklyUpdateOptions([], { now: new Date('2026-08-23T12:00:00Z') });
  const args = buildImporterArgs(options, { now: new Date('2026-08-23T12:00:00Z') });
  assert.equal(options.apply, false);
  assert.equal(options.seasonEndYear, 2026);
  assert.equal(options.phase, 'both');
  assert.equal(options.requestDelayMs, DEFAULT_REQUEST_DELAY_MS);
  assert.deepEqual(args.slice(1), [
    '--analytics',
    '--season-start', '2026',
    '--season-end', '2026',
    '--phase', 'both',
    '--request-delay-ms', '4000',
    '--refresh-cache',
    '--new-run'
  ]);
  assert.equal(args.includes('--apply'), false);
  assert.equal(args.includes('--analytics'), true);
  assert.equal(args.includes('--allow-missing-playoffs'), false);
  assert.equal(args.some((argument) => argument.includes('media')), false);
});

test('allows an absent postseason table only before the current season playoffs should exist', () => {
  const now = new Date('2026-01-15T12:00:00Z');
  const options = parseWeeklyUpdateOptions([], { now });
  assert.equal(shouldAllowMissingPlayoffs(options, { now }), true);
  assert.equal(buildImporterArgs(options, { now }).includes('--allow-missing-playoffs'), true);
  assert.equal(
    shouldAllowMissingPlayoffs(options, { now: new Date('2026-04-01T00:00:00Z') }),
    false,
  );
  assert.equal(
    shouldAllowMissingPlayoffs({ ...options, seasonEndYear: 2025 }, { now }),
    false,
  );
});

test('adds the importer apply flag only after the wrapper is explicitly placed in apply mode', () => {
  const options = parseWeeklyUpdateOptions([
    '--apply',
    '--season-end-year=2025',
    '--phase', 'regular',
    '--request-delay-ms', '6000',
    '--report-file', 'outputs/nba-weekly-update/custom.json'
  ]);
  assert.equal(options.apply, true);
  assert.equal(options.seasonEndYear, 2025);
  assert.equal(options.phase, 'regular');
  assert.equal(options.requestDelayMs, 6000);
  assert.equal(path.basename(options.reportFile), 'custom.json');
  assert.equal(buildImporterArgs(options).at(-1), '--apply');
});

test('rejects unsafe request cadence, invalid phases, and report paths outside the repository', () => {
  assert.throws(
    () => parseWeeklyUpdateOptions(['--request-delay-ms', '2999']),
    /between 3000 and 120000/
  );
  assert.throws(() => parseWeeklyUpdateOptions(['--phase', 'preseason']), /regular, playoffs, or both/);
  assert.throws(
    () => parseWeeklyUpdateOptions(['--report-file', '..\\outside.json']),
    /inside the repository/
  );
});

test('constructs only the expected season-level source paths', () => {
  assert.deepEqual(sourcePathsForSeason(2026, 'regular'), [
    '/leagues/NBA_2026.html',
    '/leagues/NBA_2026_totals.html',
    '/leagues/NBA_2026_advanced.html'
  ]);
  assert.deepEqual(sourcePathsForSeason(2026, 'playoffs'), [
    '/leagues/NBA_2026.html',
    '/playoffs/NBA_2026_totals.html',
    '/playoffs/NBA_2026_advanced.html'
  ]);
});

test('permission and write acknowledgements require the exact confirmed token', () => {
  assert.equal(isConfirmationPresent('confirmed'), true);
  assert.equal(isConfirmationPresent(' CONFIRMED '), true);
  assert.equal(isConfirmationPresent('true'), false);
  assert.equal(isConfirmationPresent('yes'), false);
  assert.equal(isConfirmationPresent(''), false);
});
