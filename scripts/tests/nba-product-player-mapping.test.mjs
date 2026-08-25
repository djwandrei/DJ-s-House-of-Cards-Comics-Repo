import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aliasesFromNbaPlayers,
  buildNbaProductPlayerMappingPlan,
  inferNbaSeasonContext,
  isNbaBasketballProduct,
  normalizeCatalogPlayerName,
  splitCatalogPlayerNames,
} from '../lib/nba-product-player-mapping.mjs';

const verifiedAlias = (athleteId, alias, aliasType = 'canonical') => ({
  athleteId,
  leagueCode: 'NBA',
  alias,
  normalizedAlias: normalizeCatalogPlayerName(alias),
  aliasType,
  reviewState: 'verified',
  identityStatus: 'active',
});

const nbaProduct = (overrides = {}) => ({
  id: 101,
  name: '2003-04 Upper Deck LeBron James Rookie',
  category: 'Basketball',
  league: 'NBA',
  playerAthlete: 'LeBron James',
  ...overrides,
});

test('name normalization is conservative and pipe splitting preserves subject order', () => {
  assert.equal(normalizeCatalogPlayerName('  Kareem   Abdul-Jabbar  '), 'kareem abdul-jabbar');
  assert.notEqual(normalizeCatalogPlayerName('Nick Smith Jr.'), normalizeCatalogPlayerName('Nick Smith'));
  assert.deepEqual(splitCatalogPlayerNames(' LeBron James | Dwyane Wade |  '), [
    'LeBron James',
    'Dwyane Wade',
  ]);
});

test('NBA eligibility requires both the basketball category and NBA league', () => {
  assert.equal(isNbaBasketballProduct(nbaProduct()), true);
  assert.equal(isNbaBasketballProduct(nbaProduct({ league: 'WNBA' })), false);
  assert.equal(isNbaBasketballProduct(nbaProduct({ category: 'Football' })), false);
  assert.equal(isNbaBasketballProduct({ category: ' basketball ', league: ' nba ' }), true);
});

test('season inference accepts only exact adjacent NBA season prefixes', () => {
  assert.deepEqual(inferNbaSeasonContext('2024-25 Panini Test'), {
    label: '2024-25', startYear: 2024, endYear: 2025, method: 'title_season_range',
  });
  assert.deepEqual(inferNbaSeasonContext('1999-00 Upper Deck Test'), {
    label: '1999-00', startYear: 1999, endYear: 2000, method: 'title_season_range',
  });
  assert.deepEqual(inferNbaSeasonContext('2004-2005 Topps Test'), {
    label: '2004-05', startYear: 2004, endYear: 2005, method: 'title_season_range',
  });
  assert.deepEqual(inferNbaSeasonContext('2020-2025 Multi-year lot'), {
    label: '', startYear: null, endYear: null, method: 'unresolved',
  });
  assert.deepEqual(inferNbaSeasonContext('Card from 2024-25'), {
    label: '', startYear: null, endYear: null, method: 'unresolved',
  });
});

test('a single canonical exact match creates one primary universal mapping', () => {
  const plan = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct()],
    aliases: [verifiedAlias('athlete-lebron', 'LeBron James')],
  });
  assert.deepEqual(plan.summary, {
    eligibleProductCount: 1,
    mappedProductCount: 1,
    mappedRowCount: 1,
    unresolvedProductCount: 0,
  });
  assert.deepEqual(plan.mappings[0], {
    product_id: 101,
    athlete_id: 'athlete-lebron',
    league_code: 'NBA',
    subject_order: 1,
    subject_role: 'primary',
    depicted_season_label: '2003-04',
    depicted_season_start_year: 2003,
    depicted_season_end_year: 2004,
    season_mapping_method: 'title_season_range',
    match_method: 'catalog_player_exact',
    match_confidence: 1,
    review_state: 'auto_verified',
    source_player_text: 'LeBron James',
    evidence: {
      mappingVersion: 1,
      catalogPlayerAthlete: 'LeBron James',
      normalizedSourceName: 'lebron james',
      matchedAliasType: 'canonical',
      productName: '2003-04 Upper Deck LeBron James Rookie',
    },
  });
});

test('verified known-name aliases remain explicit in mapping provenance', () => {
  const plan = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct({ playerAthlete: 'Lew Alcindor' })],
    aliases: [verifiedAlias('athlete-kareem', 'Lew Alcindor', 'known_name')],
  });
  assert.equal(plan.mappings[0].match_method, 'catalog_player_alias');
  assert.equal(plan.mappings[0].evidence.matchedAliasType, 'known_name');
});

test('multi-player products map all subjects in order or none at all', () => {
  const complete = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct({ playerAthlete: 'LeBron James|Dwyane Wade' })],
    aliases: [
      verifiedAlias('athlete-lebron', 'LeBron James'),
      verifiedAlias('athlete-wade', 'Dwyane Wade'),
    ],
  });
  assert.deepEqual(complete.mappings.map((mapping) => [
    mapping.athlete_id, mapping.subject_order, mapping.subject_role,
  ]), [
    ['athlete-lebron', 1, 'co_subject'],
    ['athlete-wade', 2, 'co_subject'],
  ]);

  const partial = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct({ playerAthlete: 'LeBron James|Unknown Player' })],
    aliases: [verifiedAlias('athlete-lebron', 'LeBron James')],
  });
  assert.equal(partial.mappings.length, 0);
  assert.equal(partial.unresolved[0].reason, 'unmatched_alias');
});

test('ambiguous aliases, repeated athletes, qualifiers, and unverified identity evidence fail closed', () => {
  const ambiguous = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct({ playerAthlete: 'Chris Smith' })],
    aliases: [
      verifiedAlias('athlete-chris-a', 'Chris Smith'),
      verifiedAlias('athlete-chris-b', 'Chris Smith'),
    ],
  });
  assert.equal(ambiguous.mappings.length, 0);
  assert.equal(ambiguous.unresolved[0].reason, 'ambiguous_alias');

  const repeated = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct({ playerAthlete: 'LeBron James|King James' })],
    aliases: [
      verifiedAlias('athlete-lebron', 'LeBron James'),
      verifiedAlias('athlete-lebron', 'King James', 'known_name'),
    ],
  });
  assert.equal(repeated.mappings.length, 0);
  assert.equal(repeated.unresolved[0].reason, 'duplicate_athlete_subject');

  const qualifier = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct({ playerAthlete: 'Dell Curry Redemption' })],
    aliases: [verifiedAlias('athlete-curry', 'Dell Curry')],
  });
  assert.equal(qualifier.mappings.length, 0);
  assert.equal(qualifier.unresolved[0].reason, 'unmatched_alias');

  const unverified = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct()],
    aliases: [{
      ...verifiedAlias('athlete-lebron', 'LeBron James'),
      reviewState: 'needs_review',
    }],
  });
  assert.equal(unverified.mappings.length, 0);
  assert.equal(unverified.unresolved[0].reason, 'unmatched_alias');

  const inactiveMembership = buildNbaProductPlayerMappingPlan({
    products: [nbaProduct()],
    aliases: [{
      ...verifiedAlias('athlete-lebron', 'LeBron James'),
      membershipStatus: 'inactive',
    }],
  });
  assert.equal(inactiveMembership.mappings.length, 0);
  assert.equal(inactiveMembership.unresolved[0].reason, 'unmatched_alias');
});

test('NBA player rows seed canonical aliases only after a universal identity is linked', () => {
  assert.deepEqual(aliasesFromNbaPlayers([{
    id: 'nba-player-id',
    athlete_id: 'universal-athlete-id',
    full_name: 'Nikola Jokic',
    normalized_name: 'nikola jokic',
  }]), [{
    athleteId: 'universal-athlete-id',
    leagueCode: 'NBA',
    alias: 'Nikola Jokic',
    normalizedAlias: 'nikola jokic',
    aliasType: 'canonical',
    reviewState: 'verified',
    identityStatus: 'active',
  }]);

  assert.deepEqual(aliasesFromNbaPlayers([{
    id: 'nba-profile-without-universal-link',
    full_name: 'Nikola Jokic',
  }]), []);
});

test('duplicate eligible catalog product IDs are withheld before mappings are emitted', () => {
  const plan = buildNbaProductPlayerMappingPlan({
    products: [
      nbaProduct({ id: 101, playerAthlete: 'LeBron James' }),
      nbaProduct({ id: '101', playerAthlete: 'Dwyane Wade' }),
    ],
    aliases: [
      verifiedAlias('athlete-lebron', 'LeBron James'),
      verifiedAlias('athlete-wade', 'Dwyane Wade'),
    ],
  });

  assert.deepEqual(plan.summary, {
    eligibleProductCount: 2,
    mappedProductCount: 0,
    mappedRowCount: 0,
    unresolvedProductCount: 2,
  });
  assert.equal(plan.mappings.length, 0);
  assert.deepEqual(plan.unresolved.map((item) => item.reason), [
    'duplicate_product_id',
    'duplicate_product_id',
  ]);
});

test('invalid NBA product identities are reported and other leagues are ignored', () => {
  const plan = buildNbaProductPlayerMappingPlan({
    products: [
      nbaProduct({ id: 'not-an-id' }),
      nbaProduct({ id: 102, league: 'WNBA' }),
    ],
    aliases: [verifiedAlias('athlete-lebron', 'LeBron James')],
  });
  assert.deepEqual(plan.summary, {
    eligibleProductCount: 1,
    mappedProductCount: 0,
    mappedRowCount: 0,
    unresolvedProductCount: 1,
  });
  assert.equal(plan.unresolved[0].reason, 'invalid_product_id');
});
