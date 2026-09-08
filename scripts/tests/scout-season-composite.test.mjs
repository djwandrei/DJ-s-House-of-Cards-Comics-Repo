import assert from 'node:assert/strict';
import test from 'node:test';
import { SEASON_FORGE_BLOCKS, validateSeasonDonorProfiles, createSeasonForgeRecipe, buildSeasonComposite, seasonComponentEvidence } from '../../tools/scout-studio/season-composite.js';

function profile(key, player = 'Player One', year = 2024) {
  return { key, player, season: `${year}–25`, seasonStartYear: year, phase: 'regular', team: 'Test Franchise', scope: 'team', games: 20,
    perGame: { points: 15, assists: 4, turnovers: 2, rebounds: 6, steals: 1, blocks: 1 },
    shooting: { fieldGoalPercentage: .5, threePointPercentage: .4, threePointAttemptShare: .4, freeThrowPercentage: .8 },
    components: { fieldGoalAccuracy: { value: .5, numerator: 100, denominator: 200, knownGames: 20 }, threePointAccuracy: { value: .4, numerator: 40, denominator: 100, knownGames: 20 }, threePointFrequency: { value: .4, numerator: 100, denominator: 200, knownGames: 20 }, freeThrowAccuracy: { value: .8, numerator: 80, denominator: 100, knownGames: 20 } } };
}

test('season composite keeps block scope and component denominators', () => {
  const profiles = [profile('a', 'Player One'), profile('b', 'Player Two', 2023)];
  const recipe = createSeasonForgeRecipe(profiles, Object.fromEntries(SEASON_FORGE_BLOCKS.map(block => [block.key, 'a'])));
  const report = buildSeasonComposite(profiles, recipe, 'b');
  assert.equal(report.assigned, 5);
  assert.equal(report.blocks.flatMap(block => block.components).length, 10);
  assert.equal(report.blocks[0].components[0].label, 'Field-goal accuracy');
  assert.equal(report.blocks[0].components[0].denominator, 200);
  assert.equal(report.blocks[0].components[0].difference, 0);
  assert.match(report.note, /Hypothetical season-keyed/);
});

test('season composite preserves unavailable fields and rejects stale keys', () => {
  const missing = profile('missing'); delete missing.perGame.assists;
  assert.equal(seasonComponentEvidence(missing, 'assists', 'perGame').status, 'unavailable');
  assert.throws(() => validateSeasonDonorProfiles([profile('a'), profile('a')]), /duplicate/);
  assert.throws(() => createSeasonForgeRecipe([profile('a')], { scoring: 'stale' }), /outside/);
  const incomplete = buildSeasonComposite([profile('a')], createSeasonForgeRecipe([profile('a')]));
  assert.equal(incomplete.status, 'incomplete');
});
