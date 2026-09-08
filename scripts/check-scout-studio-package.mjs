import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseStudioArgs, createScoutStudioServer } from './preview-scout-studio.mjs';
import { readReadinessMetadata } from './audit-lineup-scout-readiness.mjs';
import { createScoutStudioSource } from './lib/scout-studio-source.mjs';
import { buildBlueprint, analyzeChemistry, createForgeRecipe, buildComposite, FORGE_BLOCKS } from '../tools/scout-studio/studio-analysis.js';
import { buildCareerTimeline, summarizeCareer, replayObservedCareer } from '../tools/scout-studio/career-simulator.js';
import { SEASON_FORGE_BLOCKS, validateSeasonDonorProfiles, createSeasonForgeRecipe, buildSeasonComposite } from '../tools/scout-studio/season-composite.js';
import { findPlayerStyleMatches, findCompositeStyleMatches } from '../tools/scout-studio/style-matches.js';
import { analyzePlayerContextLens } from '../tools/scout-studio/context-lens.js';
import { teamGameEvidence, simulateMatchup } from '../tools/scout-studio/possession-simulator.js';
import { simulateLeague } from '../tools/scout-studio/season-simulator.js';
import { captureLeagueSummary, compareLeagueScenarios } from '../tools/scout-studio/league-comparisons.js';
import { captureChemistry, compareChemistry, compareForgeRecipes } from '../tools/scout-studio/workbench-comparisons.js';

// Read-only integration spot check of one roster and a two-team Game Lab
// matchup; the package validator remains responsible for all 30 teams.
// No source files, database rows or model fits change.
const browserCheck = process.argv.includes('--browser');
const leagueCheck = process.argv.includes('--league');
const options = parseStudioArgs(process.argv.slice(2).filter(arg => !['--browser', '--league'].includes(arg)));
const source = createScoutStudioSource(options);
const status = await source.status();
assert.equal(status.phase, 'ready', 'The exact current package must pass readiness first.');
const { data: manifest } = await readReadinessMetadata(options.manifest);
const sortedShards = [...manifest.dataShards].sort((a, b) => a.jsonBytes - b.jsonBytes);
const [smallest, nextSmallest] = sortedShards;
const team = status.teams.find(team => team.name === smallest.team);
const opponent = status.teams.find(team => team.name === nextSmallest.team);
console.log(JSON.stringify({ stage: 'streaming_one_validated_team', team: team.name, bytes: smallest.jsonBytes }));
const started = Date.now();
const roster = await source.roster(team.id, status.snapshot);
assert.equal(roster.players.length, smallest.rows.playerProfiles);
assert.ok(roster.players.some(player => player.metrics.some(metric => metric.status === 'observed')));
assert.ok(roster.players.some(player => player.tendencies.labels.length));
const selected = [...roster.players].sort((a, b) => b.minutes - a.minutes).slice(0, 2).map(player => player.id);
const hasSeasonEvidence = Boolean(manifest.modelEvidence?.files?.playerSeasonSkillProfiles);
let careerPlayerId = selected[0];
let careerResult = await source.playerSeasons(team.id, status.snapshot, careerPlayerId);
// A package can contain a valid base roster row without a corresponding
// additive season row. For the v2 package, find the first roster handle with
// actual season evidence so the real check exercises the intended path.
if (hasSeasonEvidence && !careerResult.profiles.length) {
  for (const candidate of roster.players) {
    const candidateResult = await source.playerSeasons(team.id, status.snapshot, candidate.id);
    if (candidateResult.profiles.length) { careerPlayerId = candidate.id; careerResult = candidateResult; break; }
  }
}
let careerCheck = { status: 'unavailable', profiles: careerResult.profiles.length, observedSeasons: 0, gaps: 0, replayTrials: 0 };
let seasonForgeCheck = { status: 'unavailable', donors: 0, assigned: 0, components: 0 };
if (hasSeasonEvidence) {
  assert.ok(careerResult.profiles.length > 0, 'The v2 package must expose at least one player-season profile for the selected roster.');
  const timeline = buildCareerTimeline(careerResult.profiles, { seasonStartYears: status.source.seasonStartYears });
  const careerSummary = summarizeCareer(timeline);
  const careerReplay = replayObservedCareer(timeline, { trials: 50, seed: 'real-career-review' });
  assert.equal(careerSummary.observedSeasons, timeline.observedRows.length);
  assert.equal(careerSummary.gapSeasons, timeline.gapRows.length);
  assert.equal(careerReplay.trials, 50);
  assert.equal(careerReplay.targetSeasons, timeline.observedRows.length);
  careerCheck = { status: 'passed', profiles: careerResult.profiles.length,
    observedSeasons: careerSummary.observedSeasons, gaps: careerSummary.gapSeasons, replayTrials: careerReplay.trials };
  const seasonDonorResult = await source.seasonDonors(team.id, status.snapshot);
  validateSeasonDonorProfiles(seasonDonorResult.profiles);
  assert.ok(seasonDonorResult.profiles.length > 0, 'The v2 package must expose bounded season donors.');
  assert.ok(seasonDonorResult.profiles.every(row => /^p\d+$/.test(row.playerId)), 'Season donor handles must be opaque public handles.');
  const preferredDonor = seasonDonorResult.profiles.find(row => row.scope === 'all-teams' && row.phase === 'regular') || seasonDonorResult.profiles[0];
  const seasonRecipe = createSeasonForgeRecipe(seasonDonorResult.profiles,
    Object.fromEntries(SEASON_FORGE_BLOCKS.map(block => [block.key, preferredDonor.key])));
  const seasonComposite = buildSeasonComposite(seasonDonorResult.profiles, seasonRecipe, preferredDonor.key);
  assert.equal(seasonComposite.assigned, SEASON_FORGE_BLOCKS.length);
  assert.equal(seasonComposite.blocks.flatMap(block => block.components).length, 10);
  seasonForgeCheck = { status: 'passed', donors: seasonDonorResult.profiles.length,
    assigned: seasonComposite.assigned, components: seasonComposite.blocks.flatMap(block => block.components).length };
  assert.doesNotMatch(JSON.stringify({ careerResult, timeline, careerSummary, careerReplay, seasonDonorResult, seasonComposite }),
    /"(?:teamId|rapm|coefficient|archivePath|manifestSha256|userCorrectionIds|providerId)"/);
}
const playerContextResult = await source.playerContexts(team.id, status.snapshot, selected[0]);
const playerContext = analyzePlayerContextLens(roster, selected[0], playerContextResult);
assert.equal(playerContext.status, 'ready');
assert.ok(playerContext.rows.some(row => row.key === 'all'));
const teamContextResult = await source.teamContexts(team.id, status.snapshot);
const gameEvidence = teamGameEvidence(teamContextResult, 2024);
assert.equal(gameEvidence.status, 'ready', gameEvidence.reason);
const result = await source.chemistry(team.id, status.snapshot, selected);
assert.ok(result.combination, 'Most-used pair must have an observed co-presence record.');
assert.equal(result.wowy.length, 4);
assert.equal(buildBlueprint(roster, selected[0]).components.length, 10);
assert.equal(analyzeChemistry(roster, result, selected).cells.length, 4);
const five = [...roster.players].sort((a, b) => b.minutes - a.minutes).slice(0, 5).map(player => player.id);
const groupResult = await source.chemistry(team.id, status.snapshot, five);
const groupEvidence = analyzeChemistry(roster, groupResult, five);
assert.equal(groupEvidence.pairs.length, 10);
const composite = buildComposite(roster, createForgeRecipe(roster, Object.fromEntries(FORGE_BLOCKS.map((block, index) => [block.key, selected[index % 2]]))), selected[0]);
assert.equal(composite.assigned, 5);
assert.equal(composite.blocks.flatMap(block => block.components).length, 10);
const referenceRecipe = createForgeRecipe(roster, Object.fromEntries(FORGE_BLOCKS.map(block => [block.key, selected[0]])));
const recipeComparison = compareForgeRecipes(roster, referenceRecipe, composite.recipe);
assert.equal(recipeComparison.rows.length, 10); assert.equal(recipeComparison.changedBlocks, 2);
const otherPair = [selected[0], five[2]], otherPairResult = await source.chemistry(team.id, status.snapshot, otherPair);
const groupComparison = compareChemistry(roster, captureChemistry(roster, result, selected), captureChemistry(roster, otherPairResult, otherPair));
assert.equal(groupComparison.kept.length, 1); assert.equal(groupComparison.added.length, 1); assert.equal(groupComparison.removed.length, 1);
const styleMatches = { player: findPlayerStyleMatches(roster, selected[0]), composite: findCompositeStyleMatches(roster, composite.recipe) };
for (const match of Object.values(styleMatches)) {
  assert.equal(match.snapshot, roster.snapshot); assert.equal(match.team, roster.team);
  assert.ok(match.matches.length <= 3);
  if (match.status === 'ready') {
    assert.ok(match.components.length >= 6 && match.eligible >= 3);
    assert.ok(match.matches.every(candidate => Number.isFinite(candidate.distance) && candidate.gaps.length === match.components.length));
  } else assert.equal(match.matches.length, 0);
}
assert.doesNotMatch(JSON.stringify({ roster, playerContext, teamContextResult, result, groupResult, styleMatches, groupComparison, recipeComparison }), /"(?:playerId|teamId|rapm|coefficient|archivePath|manifestSha256)"/);
console.log(JSON.stringify({ passed: true, scope: 'one-team integration spot check, not a 30-team UI audit',
  team: team.name, profiles: roster.players.length, contextRows: playerContext.rows.length, chemistryStatus: result.combination.sample.status,
  career: { player: careerPlayerId, ...careerCheck }, seasonForge: seasonForgeCheck,
  pinnedComparisons: { recipeRows: recipeComparison.rows.length, changedDonorBlocks: recipeComparison.changedBlocks, groupContexts: groupComparison.contexts.length },
  gameSample: { season: 2024, offensePossessions: gameEvidence.offense.possessions, defensePossessions: gameEvidence.defense.possessions },
  fivePlayerPairCount: groupEvidence.pairs.length, observedPairs: groupEvidence.pairs.filter(pair => pair.status === 'observed').length,
  styleMatching: Object.fromEntries(Object.entries(styleMatches).map(([kind, value]) => [kind, { status: value.status, eligible: value.eligible, components: value.components.length }])),
  observedMetrics: roster.players.reduce((sum, player) => sum + player.metrics.filter(metric => metric.status === 'observed').length, 0),
  unavailableMetrics: roster.players.reduce((sum, player) => sum + player.metrics.filter(metric => metric.status === 'unavailable').length, 0),
  independentBoxScore: Object.fromEntries(['complete_and_reconciled', 'not_fully_reconciled'].map(state => [state, roster.players.filter(player => player.coverage.independentBoxScore === state).length])),
  elapsedSeconds: Math.round((Date.now() - started) / 1000) }));

console.log(JSON.stringify({ stage: 'streaming_matchup_opponent', team: opponent.name, bytes: nextSmallest.jsonBytes }));
const opponentContextResult = await source.teamContexts(opponent.id, status.snapshot);
for (const season of [2023, 2024, 2025]) {
  for (const evidence of [teamContextResult, opponentContextResult]) {
    const sample = teamGameEvidence(evidence, season);
    assert.equal(sample.status, 'ready', `${evidence.team} ${season}: ${sample.reason}`);
  }
}
const matchup = await simulateMatchup({ a: teamContextResult, b: opponentContextResult,
  season: 2024, seed: 'real-package-review', trials: 1000, format: 'best_of_7' });
assert.equal(matchup.wins.a + matchup.wins.b + matchup.wins.unresolved, 1000);
assert.doesNotMatch(JSON.stringify({ opponentContextResult, matchup }), /"(?:playerId|teamId|rapm|coefficient|archivePath|manifestSha256)"/);
console.log(JSON.stringify({ gameLabIntegration: 'passed', teams: [team.name, opponent.name],
  seasonSamplesChecked: [2023, 2024, 2025], series: 1000, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));

if (leagueCheck) {
  const leagueTeams = [teamContextResult, opponentContextResult], names = [team.name, opponent.name];
  for (const descriptor of sortedShards.slice(2, 4)) {
    const selected = status.teams.find(team => team.name === descriptor.team);
    console.log(JSON.stringify({ stage: 'streaming_league_team', team: selected.name, bytes: descriptor.jsonBytes }));
    leagueTeams.push(await source.teamContexts(selected.id, status.snapshot)); names.push(selected.name);
  }
  const report = await simulateLeague({ teams: leagueTeams, season: 2024, seed: 'real-league-review', trials: 100 });
  assert.equal(report.teams.reduce((sum, team) => sum + team.titles, 0) + report.unresolvedTitles, 100);
  assert.equal(report.example.table.reduce((sum, row) => sum + row.pointsFor - row.pointsAgainst, 0), 0);
  const reference = captureLeagueSummary(report);
  assert.equal(compareLeagueScenarios(reference, report).identical, true);
  const changed = await simulateLeague({ teams: leagueTeams, season: 2024, seed: 'real-league-review', trials: 100, possessions: 110 });
  const comparison = compareLeagueScenarios(reference, changed);
  assert.deepEqual(comparison.changes.map(row => row.key), ['possessions']);
  assert.doesNotMatch(JSON.stringify({ report, reference, comparison }), /"(?:playerId|teamId|rapm|coefficient|archivePath|manifestSha256)"/);
  console.log(JSON.stringify({ realLeagueIntegration: 'passed', teams: names, seasons: 100, games: report.gamesPlayed,
    pinnedComparison: 'passed: identical replay and pace-only change',
    elapsedSeconds: Math.round((Date.now() - started) / 1000), scope: 'four-team integration, not forecast validation' }));
}

if (browserCheck) {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
  const server = createScoutStudioServer(source);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const errors = [];
    const base = `http://127.0.0.1:${server.address().port}`;
    const output = path.resolve('outputs/scout-studio-smoke');
    await fs.mkdir(output, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/tools/scout-studio/`);
      await page.getByRole('heading', { name: 'Validated for local integration review' }).waitFor();
      await page.locator('#teamSelect').selectOption(team.id);
      await page.getByRole('button', { name: 'Load team evidence' }).click();
      await page.getByText(`${roster.players.length} source player profiles loaded.`, { exact: false }).waitFor();
      await page.locator('#playerSelect').selectOption(selected[0]);
      await page.locator('#compareSelect').selectOption(selected[1]);
      if (hasSeasonEvidence) {
        await page.getByRole('button', { name: 'Career Lab', exact: true }).click();
        await page.locator('#careerPlayerSelect').selectOption(careerPlayerId);
        await page.getByRole('button', { name: 'Load observed career', exact: true }).click();
        await page.locator('[data-career-result]').waitFor();
        await page.getByRole('button', { name: 'Replay observed seasons', exact: true }).click();
        await page.locator('[data-career-replay]').waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator('#careerResults').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `real-career-lab-${viewport.width}.png`) });
        await page.getByRole('button', { name: 'Player Blueprint', exact: true }).click();
      }
      const playerContexts = page.locator('[data-context-lens="player"]');
      await playerContexts.locator(':scope > summary').click();
      await playerContexts.getByRole('button', { name: 'Load context splits' }).click();
      await playerContexts.getByRole('rowheader', { name: /^Season:/ }).first().waitFor();
      assert.equal(await playerContexts.locator('table').count(), 1);
      await page.locator('#blueprintTitle').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `real-blueprint-${viewport.width}.png`) });
      await page.locator('[data-style-matches="blueprint"] > summary').click();
      assert.equal(await page.locator('[data-style-matches="blueprint"] button').count(), styleMatches.player.matches.length);
      await page.locator('[data-style-matches="blueprint"]').screenshot({ path: path.join(output, `real-style-matches-${viewport.width}.png`) });
      await page.getByRole('button', { name: 'Chemistry Lab', exact: true }).click();
      for (const id of selected) await page.getByRole('button', { name: roster.players.find(player => player.id === id).name, exact: true }).click();
      await page.getByRole('button', { name: 'Inspect shared floor' }).click();
      await page.locator('#chemistryContent table').first().waitFor();
      const groupContexts = page.locator('[data-context-lens="group"]');
      assert.equal(await groupContexts.count(), 1);
      await groupContexts.locator(':scope > summary').click();
      await groupContexts.getByRole('columnheader', { name: 'Net vs all', exact: true }).waitFor();
      assert.equal(await groupContexts.locator('table').count(), 1);
      assert.ok(await page.locator('#chemistryContent table').count() >= 3);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#chemistryContent').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `real-chemistry-${viewport.width}.png`) });
      await page.getByRole('button', { name: 'Composite Forge', exact: true }).click();
      await page.locator('#forgeBaseline').selectOption(selected[0]);
      await page.getByRole('button', { name: 'Use baseline for all blocks' }).click();
      await page.locator('#forge-shooting').selectOption(selected[1]);
      await page.getByRole('heading', { name: '5/5 donor blocks selected' }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#forgeTitle').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `real-forge-${viewport.width}.png`) });
      await page.locator('#forgeChange').screenshot({ path: path.join(output, `real-forge-change-${viewport.width}.png`) });
      await page.locator('#forgeContent').screenshot({ path: path.join(output, `real-forge-ledger-${viewport.width}.png`) });
      if (hasSeasonEvidence) {
        await page.getByRole('button', { name: 'Load observed season donors', exact: true }).click();
        await page.locator('#seasonForgeContent h4').filter({ hasText: /observed season blocks selected/ }).waitFor();
        assert.equal(await page.locator('#seasonForgeContent table tbody tr').count(), 10);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator('#seasonForgeContent').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `real-season-forge-${viewport.width}.png`) });
      }
      await page.getByRole('button', { name: 'Game Lab', exact: true }).click();
      await page.locator('#gameTeamA').selectOption(team.id);
      await page.locator('#gameTeamB').selectOption(opponent.id);
      await page.locator('#gameSeason').selectOption('2024');
      await page.getByRole('button', { name: 'Simulate matchup', exact: true }).click();
      await page.getByText('Experiment complete.', { exact: false }).waitFor({ timeout: 120000 });
      assert.equal(await page.locator('.studio-game-histogram progress').count(), 7);
      assert.match(await page.locator('#gameResults').innerText(), /2024–25/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#gameResults').screenshot({ path: path.join(output, `real-game-lab-${viewport.width}.png`) });
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realPackageBrowserCheck: 'passed', viewports: [1440, 390],
      rosterTeam: team.name, gameTeams: [team.name, opponent.name], career: careerCheck.status,
      seasonForge: seasonForgeCheck.status, screenshots: output }));
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
