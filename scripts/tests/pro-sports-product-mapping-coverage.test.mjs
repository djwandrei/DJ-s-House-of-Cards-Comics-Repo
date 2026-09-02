import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProSportsCatalogMappingCoverage,
  buildProviderIdentityUniverse,
  foldProviderIdentityName,
  normalizeLeadingInitialism,
} from '../lib/pro-sports-product-mapping-coverage.mjs';
import { NFL_TEAM_CODE_NAMES } from '../lib/pro-sports-catalog-identity-overrides.mjs';
import { extractProviderIdentityObservations } from '../audit-pro-sports-product-mapping-coverage.mjs';

const config = { category: 'Baseball', leagueCode: 'MLB', sourceName: 'baseball_reference' };
const providerRows = [
  { externalId: 'one', fullName: 'José Ramírez', seasonYear: 2023, teamCode: 'CLE', teamName: 'Cleveland Guardians' },
  { externalId: 'one', fullName: 'José Ramírez', seasonYear: 2024, teamCode: 'CLE', teamName: 'Cleveland Guardians' },
  { externalId: 'two', fullName: 'Alex Smith', seasonYear: 1990, teamCode: 'BOS', teamName: 'Boston Red Sox' },
  { externalId: 'three', fullName: 'Alex Smith', seasonYear: 2010, teamCode: 'NYM', teamName: 'New York Mets' },
  { externalId: 'four', fullName: 'Ken Griffey Jr.', seasonYear: 1999, teamCode: 'SEA', teamName: 'Seattle Mariners' },
];

test('provider universe preserves stable external IDs, aliases, teams, and career bounds', () => {
  const universe = buildProviderIdentityUniverse(providerRows, config);
  assert.equal(universe.length, 4);
  assert.deepEqual(universe.find((identity) => identity.externalId === 'one'), {
    externalId: 'one', leagueCode: 'MLB', sourceName: 'baseball_reference',
    canonicalName: 'José Ramírez', observedNames: ['José Ramírez'], firstSeason: 2023, lastSeason: 2024,
    teamCodes: ['CLE'], teamNames: ['Cleveland Guardians'],
    teamObservations: [
      { seasonYear: 2023, teamCode: 'CLE', teamName: 'Cleveland Guardians' },
      { seasonYear: 2024, teamCode: 'CLE', teamName: 'Cleveland Guardians' },
    ],
  });
  assert.equal(foldProviderIdentityName('José Ramírez'), 'jose ramirez');
  assert.equal(normalizeLeadingInitialism('C.J. Prosise'), 'cj prosise');
});

test('compact cache extraction keeps stable provider IDs and removes display markers', () => {
  const extracted = extractProviderIdentityObservations(`
    <a href="/teams/CLE/2000.shtml">Cleveland Guardians</a>
    <tr><td data-stat="name_display"><a href="/players/r/ramirjo01.shtml">José Ramírez #</a></td>
      <td data-stat="team_name_abbr"><a href="/teams/CLE/2000.shtml">CLE</a></td></tr>
    <tr><th class="left" data-stat="player"><a href="/players/r/ramirjo01.shtml"><strong>José Ramírez #</strong></a></th>
      <td data-stat="team_name_abbr">CLE</td></tr>
    <tr><td data-stat="name_display"><a href="/players/g/griffke02.shtml">Ken Griffey Jr.*+</a></td>
      <td data-stat="team_name_abbr">SEA</td></tr>
    <footer><a href="/players/j/judgeaa01.shtml">Aaron Judge</a></footer>
  `, { seasonYear: 2000, extension: 'shtml' });
  assert.equal(extracted.rows.length, 2);
  assert.equal(extracted.duplicateLinkCount, 1);
  assert.deepEqual(extracted.rows[0], {
    externalId: 'ramirjo01', fullName: 'José Ramírez', seasonYear: 2000,
    teamCode: 'CLE', teamName: 'Cleveland Guardians',
  });
});

test('coverage separates exact, folded, ambiguous, conflicts, unseen names, and intentional blanks', () => {
  const products = [
    { id: 1, category: 'Baseball', league: 'MLB', playerAthlete: 'José Ramírez', team: 'Cleveland Guardians', year: 2024, name: 'Exact' },
    { id: 2, category: 'Baseball', league: 'MLB', playerAthlete: 'Jose Ramirez', team: 'Cleveland Guardians', year: 2024, name: 'Folded' },
    { id: 3, category: 'Baseball', league: 'MLB', playerAthlete: 'Alex Smith', team: '', year: '', name: 'Ambiguous' },
    { id: 4, category: 'Baseball', league: 'MLB', playerAthlete: 'Ken Griffey Jr.', team: 'New York Yankees', year: 1999, name: 'Conflict' },
    { id: 5, category: 'Baseball', league: 'MLB', playerAthlete: 'Unknown Player', team: '', year: 2020, name: 'Unseen' },
    { id: 6, category: 'Baseball', league: 'MLB', playerAthlete: '', team: 'Boston Red Sox', year: 2020, name: 'Team lot' },
    { id: 7, category: 'Baseball', league: 'MLB', playerAthlete: 'José Ramírez|Ken Griffey Jr.', team: '', year: 2024, name: 'Multi' },
    { id: 8, category: 'Football', league: 'NFL', playerAthlete: 'Alex Smith', team: '', year: 2010, name: 'Wrong sport' },
    { id: 9, category: 'Baseball', league: 'MLB', playerAthlete: 'Alex Smith', team: '', year: 1990, name: 'Career disambiguated' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({ products, providerRows, config });
  assert.equal(coverage.eligibleProductCount, 8);
  assert.equal(coverage.sourceBackedCandidateProductCount, 4);
  assert.equal(coverage.sourceBackedCandidateMappingRowCount, 5);
  assert.deepEqual(coverage.dispositionCounts, {
    source_normalized_unique_candidate: 1,
    ambiguous_provider_identity: 1,
    source_exact_unique_candidate: 2,
    unseen_provider_name: 1,
    intentionally_blank_team_lot: 1,
    source_exact_career_disambiguated_candidate: 1,
    catalog_team_conflict_review: 1,
  });
  assert.equal(coverage.rows.find((row) => row.productId === 7).proposedSubjects[1].subjectOrder, 2);
  assert.equal(coverage.rows.find((row) => row.productId === 4).disposition, 'catalog_team_conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 9).proposedSubjects[0].candidates[0].providerExternalId, 'two');
});

test('coverage applies narrowly scoped aliases, visual overrides, exclusions, and exact team disambiguation', () => {
  const nflConfig = {
    category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
    teamCodeNames: { MIN: ['Minnesota Vikings'], CHI: ['Chicago Bears'], JAX: ['Jacksonville Jaguars'], NOR: ['New Orleans Saints'] },
    aliasOverrides: [{
      leagueCode: 'NFL', sourceName: 'pro_football_reference', sourcePlayerText: 'Maurice Drew',
      providerExternalId: 'drew', evidence: 'Reviewed historical-name alias.',
    }],
    productIdentityOverrides: [{
      productId: 4, leagueCode: 'NFL', sourceName: 'pro_football_reference', subjectOrder: 1,
      sourcePlayerText: 'Michael Thomas', providerExternalId: 'saints', evidence: 'Local card photo reviewed.',
      expectedProduct: {
        name: 'Visual override', playerAthlete: 'Michael Thomas', team: 'Miami Dolphins', year: 2016,
      },
      allowEvidenceConflict: true,
      proposedCatalogCorrections: { team: 'New Orleans Saints' },
    }],
    productIdentityExclusions: [{
      productId: 5, leagueCode: 'NFL', sourceName: 'pro_football_reference',
      disposition: 'intentionally_unmapped_catalog_misclassification', evidence: 'Not an NFL card.',
      expectedProduct: { name: 'Exclusion', playerAthlete: 'Not NFL', team: '', year: 2024 },
    }],
  };
  const nflRows = [
    { externalId: 'peterson-chi', fullName: 'Adrian Peterson', seasonYear: 2007, teamCode: 'CHI' },
    { externalId: 'peterson-min', fullName: 'Adrian Peterson', seasonYear: 2007, teamCode: 'MIN' },
    { externalId: 'prosise', fullName: 'C.J. Prosise', seasonYear: 2016, teamCode: 'SEA' },
    { externalId: 'drew', fullName: 'Maurice Jones-Drew', seasonYear: 2006, teamCode: 'JAX' },
    { externalId: 'saints', fullName: 'Michael Thomas', seasonYear: 2016, teamCode: 'NOR' },
  ];
  const products = [
    { id: 1, category: 'Football', league: 'NFL', playerAthlete: 'Adrian Peterson', team: 'Minnesota Vikings', year: 2007, name: 'Team disambiguated' },
    { id: 2, category: 'Football', league: 'NFL', playerAthlete: 'Cj Prosise', team: '', year: 2016, name: 'Initialism normalized' },
    { id: 3, category: 'Football', league: 'NFL', playerAthlete: 'Maurice Drew', team: 'Jacksonville Jaguars', year: 2006, name: 'Alias' },
    { id: 4, category: 'Football', league: 'NFL', playerAthlete: 'Michael Thomas', team: 'Miami Dolphins', year: 2016, name: 'Visual override' },
    { id: 5, category: 'Football', league: 'NFL', playerAthlete: 'Not NFL', team: '', year: 2024, name: 'Exclusion' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({ products, providerRows: nflRows, config: nflConfig });
  assert.equal(coverage.rows.find((row) => row.productId === 1).disposition, 'source_exact_team_disambiguated_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 1).proposedSubjects[0].candidates[0].providerExternalId, 'peterson-min');
  assert.equal(coverage.rows.find((row) => row.productId === 2).disposition, 'source_initialism_normalized_unique_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 3).disposition, 'reviewed_catalog_alias_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 4).disposition, 'reviewed_product_identity_override_candidate');
  assert.deepEqual(coverage.rows.find((row) => row.productId === 4).proposedCatalogCorrections, { team: 'New Orleans Saints' });
  assert.equal(coverage.rows.find((row) => row.productId === 5).disposition, 'intentionally_unmapped_catalog_misclassification');
});

test('contradictory evidence is manual unless a fingerprinted visual override permits it', () => {
  const products = [{
    id: 20, category: 'Baseball', league: 'MLB', playerAthlete: 'José Ramírez',
    team: 'New York Yankees', year: 1990, name: 'Conflicting card',
  }];
  const providerRows = [{
    externalId: 'ramirez', fullName: 'José Ramírez', seasonYear: 2023,
    teamCode: 'CLE', teamName: 'Cleveland Guardians',
  }];
  const coverage = buildProSportsCatalogMappingCoverage({ products, providerRows, config });
  assert.equal(coverage.rows[0].disposition, 'catalog_year_conflict_review');
  assert.equal(coverage.rows[0].evidence.catalogAttributeReviewRequired, true);
  assert.equal(coverage.sourceBackedCandidateProductCount, 0);

  const overridden = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      ...config,
      productIdentityOverrides: [{
        productId: 20, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
        sourcePlayerText: 'José Ramírez', providerExternalId: 'ramirez', evidence: 'Visible card evidence.',
        expectedProduct: {
          name: 'Conflicting card', playerAthlete: 'José Ramírez', team: 'New York Yankees', year: 1990,
        },
        allowEvidenceConflict: true,
      }],
    },
  });
  assert.equal(overridden.rows[0].disposition, 'reviewed_product_identity_override_candidate');

  const drifted = buildProSportsCatalogMappingCoverage({
    products: [{ ...products[0], team: 'Different Team' }],
    providerRows,
    config: {
      ...config,
      productIdentityOverrides: [{
        productId: 20, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
        sourcePlayerText: 'José Ramírez', providerExternalId: 'ramirez', evidence: 'Visible card evidence.',
        expectedProduct: {
          name: 'Conflicting card', playerAthlete: 'José Ramírez', team: 'New York Yankees', year: 1990,
        },
        allowEvidenceConflict: true,
      }],
    },
  });
  assert.equal(drifted.rows[0].disposition, 'reviewed_product_override_fingerprint_drift');
  assert.equal(drifted.sourceBackedCandidateProductCount, 0);
});

test('a multi-subject conflict requires every subject to carry a reviewed override', () => {
  const products = [{
    id: 21, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice|Bob',
    team: 'Wrong|Wrong', year: 1990, name: 'Reviewed leader card',
  }];
  const providerRows = [
    { externalId: 'alice', fullName: 'Alice', seasonYear: 2020, teamName: 'Alpha' },
    { externalId: 'bob', fullName: 'Bob', seasonYear: 2020, teamName: 'Beta' },
  ];
  const expectedProduct = {
    name: 'Reviewed leader card', playerAthlete: 'Alice|Bob', team: 'Wrong|Wrong', year: 1990,
  };
  const firstSubjectOnly = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      ...config,
      productIdentityOverrides: [{
        productId: 21, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
        sourcePlayerText: 'Alice', providerExternalId: 'alice', expectedProduct,
        allowEvidenceConflict: true, evidence: 'Reviewed first subject.',
      }],
    },
  });
  assert.equal(firstSubjectOnly.rows[0].disposition, 'catalog_year_conflict_review');

  const everySubject = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      ...config,
      productIdentityOverrides: [
        {
          productId: 21, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
          sourcePlayerText: 'Alice', providerExternalId: 'alice', expectedProduct,
          allowEvidenceConflict: true, evidence: 'Reviewed first subject.',
        },
        {
          productId: 21, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 2,
          sourcePlayerText: 'Bob', providerExternalId: 'bob', expectedProduct,
          allowEvidenceConflict: true, evidence: 'Reviewed second subject.',
        },
      ],
    },
  });
  assert.equal(everySubject.rows[0].disposition, 'reviewed_product_identity_override_candidate');
  assert.equal(everySubject.sourceBackedCandidateMappingRowCount, 2);
});

test('reviewed card contexts and narrow franchise spellings do not create false team conflicts', () => {
  const products = [
    { id: 30, category: 'Baseball', league: 'MLB', playerAthlete: 'Player One', team: 'National League', year: 2012, name: 'League leaders card' },
    { id: 31, category: 'Baseball', league: 'MLB', playerAthlete: 'Player Two', team: 'Los Angeles Angels', year: 2012, name: 'Franchise spelling card' },
  ];
  const providerRows = [
    { externalId: 'one', fullName: 'Player One', seasonYear: 2012, teamCode: 'LAA', teamName: 'Los Angeles Angels of Anaheim' },
    { externalId: 'two', fullName: 'Player Two', seasonYear: 2012, teamCode: 'LAA', teamName: 'Los Angeles Angels of Anaheim' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      ...config,
      teamContextNames: ['National League'],
      teamNameAliases: { 'los angeles angels': 'los angeles angels of anaheim' },
    },
  });
  assert.equal(coverage.sourceBackedCandidateProductCount, 2);
  assert.equal(coverage.rows.find((row) => row.productId === 30).evidence.team.status, 'card_context');
  assert.equal(coverage.rows.find((row) => row.productId === 31).evidence.team.status, 'consistent');
});

test('team evidence uses the player team from the card year rather than a later franchise', () => {
  const products = [
    { id: 40, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'St. Louis Rams', year: 2012, name: 'Historical city card' },
    { id: 41, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Los Angeles Rams', year: 2022, name: 'Current city card' },
    { id: 42, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Los Angeles Rams', year: 2012, name: 'Wrong historical city' },
  ];
  const providerRows = [
    { externalId: 'one', fullName: 'Player One', seasonYear: 2012, teamCode: 'RAM', teamName: 'STL' },
    { externalId: 'one', fullName: 'Player One', seasonYear: 2022, teamCode: 'RAM', teamName: 'LAR' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamCodeNames: {
        RAM: [
          { name: 'Los Angeles Rams', lastSeason: 1994 },
          { name: 'St. Louis Rams', firstSeason: 1995, lastSeason: 2015 },
          { name: 'Los Angeles Rams', firstSeason: 2016 },
        ],
        STL: ['St. Louis Rams'], LAR: ['Los Angeles Rams'],
      },
    },
  });
  assert.equal(coverage.rows.find((row) => row.productId === 40).evidence.team.status, 'consistent');
  assert.equal(coverage.rows.find((row) => row.productId === 41).evidence.team.status, 'consistent');
  assert.equal(coverage.rows.find((row) => row.productId === 42).disposition, 'catalog_team_conflict_review');
});

test('missing card-year team evidence never falls back to a later franchise', () => {
  const products = [{
    id: 50, category: 'Football', league: 'NFL', playerAthlete: 'Player One',
    team: 'Los Angeles Rams', year: 2015, name: 'Gap-year card',
  }];
  const providerRows = [
    { externalId: 'one', fullName: 'Player One', seasonYear: 2012, teamCode: 'STL' },
    { externalId: 'one', fullName: 'Player One', seasonYear: 2018, teamCode: 'LAR' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamCodeNames: { STL: ['St. Louis Rams'], LAR: ['Los Angeles Rams'] },
    },
  });
  assert.equal(coverage.rows[0].evidence.team.status, 'provider_team_year_unavailable');
  assert.equal(coverage.rows[0].evidence.catalogAttributeReviewRequired, true);
  assert.equal(coverage.rows[0].disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.sourceBackedCandidateProductCount, 1);
});

test('season-aware code aliases preserve historic team brands', () => {
  const products = [
    { id: 60, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Washington Redskins', year: 2015, name: 'Historic brand' },
    { id: 61, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Washington Commanders', year: 2015, name: 'Wrong modern brand' },
    { id: 62, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Washington Commanders', year: 2023, name: 'Current brand' },
  ];
  const providerRows = [
    { externalId: 'one', fullName: 'Player One', seasonYear: 2015, teamCode: 'WAS' },
    { externalId: 'one', fullName: 'Player One', seasonYear: 2023, teamCode: 'WAS' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({
    products,
    providerRows,
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamCodeNames: {
        WAS: [
          { name: 'Washington Redskins', lastSeason: 2019 },
          { name: 'Washington Football Team', firstSeason: 2020, lastSeason: 2021 },
          { name: 'Washington Commanders', firstSeason: 2022 },
        ],
      },
    },
  });
  assert.equal(coverage.rows.find((row) => row.productId === 60).disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 61).disposition, 'catalog_team_conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 62).disposition, 'source_exact_unique_candidate');
});

test('a stable provider franchise code takes priority over a changing display abbreviation', () => {
  const coverage = buildProSportsCatalogMappingCoverage({
    products: [
      { id: 65, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Baltimore Colts', year: 1983, name: 'Historic Colts' },
      { id: 66, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Baltimore Ravens', year: 1983, name: 'Wrong current Baltimore' },
      { id: 67, category: 'Football', league: 'NFL', playerAthlete: 'Player Two', team: 'St. Louis Rams', year: 2015, name: 'Historic Rams' },
      { id: 68, category: 'Football', league: 'NFL', playerAthlete: 'Player Two', team: 'Los Angeles Chargers', year: 2015, name: 'Malformed display code' },
    ],
    providerRows: [
      { externalId: 'one', fullName: 'Player One', seasonYear: 1983, teamCode: 'CLT', teamName: 'BAL' },
      { externalId: 'two', fullName: 'Player Two', seasonYear: 2015, teamCode: 'RAM', teamName: 'LAC' },
    ],
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamCodeNames: NFL_TEAM_CODE_NAMES,
    },
  });
  assert.equal(coverage.rows.find((row) => row.productId === 65).disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 66).disposition, 'catalog_team_conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 67).disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 68).disposition, 'catalog_team_conflict_review');
});

test('overlapping franchise-name ranges are rejected before mapping', () => {
  assert.throws(() => buildProSportsCatalogMappingCoverage({
    products: [],
    providerRows: [],
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamCodeNames: {
        TST: [
          { name: 'Team One', firstSeason: 2000 },
          { name: 'Team Two', lastSeason: 2010 },
        ],
      },
    },
  }), /overlapping franchise-name ranges/);
});

test('invalid provider seasons and aggregate team rows do not create team or career evidence', () => {
  const universe = buildProviderIdentityUniverse([
    { externalId: 'one', fullName: 'Player One', seasonYear: '', teamCode: 'LAR' },
    { externalId: 'one', fullName: 'Player One', seasonYear: 2005, teamCode: '2TM' },
  ], { category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference' });
  assert.equal(universe[0].firstSeason, 2005);
  assert.equal(universe[0].lastSeason, 2005);
  assert.deepEqual(universe[0].teamCodes, ['LAR']);
  assert.deepEqual(universe[0].teamObservations, []);

  const coverage = buildProSportsCatalogMappingCoverage({
    products: [
      { id: 70, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: '', year: 1990, name: 'Invalid season guard' },
      { id: 71, category: 'Football', league: 'NFL', playerAthlete: 'Player One', team: 'Los Angeles Rams', year: 2005, name: 'Aggregate team guard' },
    ],
    providerRows: [
      { externalId: 'one', fullName: 'Player One', seasonYear: '', teamCode: 'LAR' },
      { externalId: 'one', fullName: 'Player One', seasonYear: 2005, teamCode: '2TM' },
    ],
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamCodeNames: { LAR: ['Los Angeles Rams'] },
    },
  });
  assert.equal(coverage.rows.find((row) => row.productId === 70).disposition, 'catalog_year_conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 71).disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.rows.find((row) => row.productId === 71).evidence.catalogAttributeReviewRequired, true);
});

test('multi-subject team evidence is bound to the corresponding subject order', () => {
  const products = [
    { id: 80, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice|Bob', team: 'Beta|Alpha', year: 2020, name: 'Swapped teams' },
    { id: 81, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice|Bob', team: 'Alpha|Alpha', year: 2020, name: 'Partial teams' },
    { id: 82, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice|Bob', team: 'Alpha|Beta|Gamma', year: 2020, name: 'Unpaired set teams' },
  ];
  const providerRows = [
    { externalId: 'alice', fullName: 'Alice', seasonYear: 2020, teamName: 'Alpha' },
    { externalId: 'bob', fullName: 'Bob', seasonYear: 2020, teamName: 'Beta' },
  ];
  const coverage = buildProSportsCatalogMappingCoverage({ products, providerRows, config });
  assert.equal(coverage.rows.find((row) => row.productId === 80).evidence.team.status, 'conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 80).disposition, 'catalog_team_conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 81).evidence.team.status, 'partial');
  assert.equal(coverage.rows.find((row) => row.productId === 81).disposition, 'catalog_team_partial_conflict_review');
  assert.equal(coverage.rows.find((row) => row.productId === 82).evidence.team.status, 'subject_pairing_unavailable');
  assert.equal(coverage.rows.find((row) => row.productId === 82).evidence.catalogAttributeReviewRequired, true);
  assert.equal(coverage.rows.find((row) => row.productId === 82).disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.sourceBackedCandidateProductCount, 1);
});

test('product-fingerprinted catalog corrections can repair multi-subject fields without changing source identities', () => {
  const products = [{
    id: 90, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice|Bob',
    team: 'Alpha|Wrong Team', year: 2020, name: 'Reviewed multi-subject card',
  }];
  const providerRows = [
    { externalId: 'alice', fullName: 'Alice', seasonYear: 2020, teamName: 'Alpha' },
    { externalId: 'bob', fullName: 'Bob', seasonYear: 2020, teamName: 'Beta' },
  ];
  const reviewedConfig = {
    ...config,
    productCatalogCorrections: [{
      productId: 90, leagueCode: 'MLB', sourceName: 'baseball_reference',
      expectedProduct: {
        name: 'Reviewed multi-subject card', playerAthlete: 'Alice|Bob', team: 'Alpha|Wrong Team', year: 2020,
      },
      expectedCorrectedProduct: {
        name: 'Reviewed multi-subject card', playerAthlete: 'Alice|Bob', team: 'Alpha|Beta', year: 2020,
      },
      allowEvidenceConflict: true,
      evidence: 'Reviewed local card image.',
      proposedCatalogCorrections: { team: 'Alpha|Beta' },
    }],
  };
  const coverage = buildProSportsCatalogMappingCoverage({ products, providerRows, config: reviewedConfig });
  assert.equal(coverage.rows[0].disposition, 'source_exact_unique_candidate');
  assert.deepEqual(coverage.rows[0].proposedCatalogCorrections, { team: 'Alpha|Beta' });
  assert.equal(coverage.rows[0].evidence.reviewedCatalogCorrection, 'Reviewed local card image.');

  const drifted = buildProSportsCatalogMappingCoverage({
    products: [{ ...products[0], team: 'Drifted Team' }], providerRows, config: reviewedConfig,
  });
  assert.equal(drifted.rows[0].disposition, 'reviewed_catalog_correction_fingerprint_drift');
  assert.equal(drifted.sourceBackedCandidateProductCount, 0);
});

test('reviewed college-card contexts remain high confidence after their team correction lands', () => {
  const correction = {
    productId: 94, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: 'College quarterback card', playerAthlete: 'Player One', team: 'Modern Pro Team', year: 2020,
    },
    expectedCorrectedProduct: {
      name: 'College quarterback card', playerAthlete: 'Player One', team: 'College Team', year: 2020,
    },
    allowEvidenceConflict: true,
    evidence: 'Reviewed local college-card image.',
    proposedCatalogCorrections: { team: 'College Team' },
  };
  const providerRows = [{
    externalId: 'one', fullName: 'Player One', seasonYear: 2020, teamName: 'Source Pro Team',
  }];
  const correctedProduct = {
    id: 94, category: 'Football', league: 'NFL', playerAthlete: 'Player One',
    team: 'College Team', year: 2020, name: 'College quarterback card',
  };
  const coverage = buildProSportsCatalogMappingCoverage({
    products: [correctedProduct],
    providerRows,
    config: {
      category: 'Football', leagueCode: 'NFL', sourceName: 'pro_football_reference',
      teamContextNames: ['College Team'], productCatalogCorrections: [correction],
    },
  });
  assert.equal(coverage.rows[0].disposition, 'source_exact_unique_candidate');
  assert.equal(coverage.rows[0].evidence.team.status, 'card_context');
  assert.equal(coverage.rows[0].proposedCatalogCorrections, null);
});

test('a correction that adds a player is held before correction and maps every subject after the corrected fingerprint', () => {
  const providerRows = [
    { externalId: 'richard', fullName: 'J.R. Richard', seasonYear: 1980, teamName: 'Houston Astros' },
    { externalId: 'ryan', fullName: 'Nolan Ryan', seasonYear: 1980, teamName: 'Houston Astros' },
  ];
  const correction = {
    productId: 91, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: 'Strikeout leaders', playerAthlete: 'Nolan Ryan', team: 'Houston Astros|California Angels', year: 1980,
    },
    expectedCorrectedProduct: {
      name: 'Strikeout leaders', playerAthlete: 'J.R. Richard|Nolan Ryan', team: 'Houston Astros|California Angels', year: 1980,
    },
    allowEvidenceConflict: true,
    evidence: 'Reviewed 1979-stat card context.',
    proposedCatalogCorrections: { playerAthlete: 'J.R. Richard|Nolan Ryan' },
  };
  const pending = buildProSportsCatalogMappingCoverage({
    products: [{
      id: 91, category: 'Baseball', league: 'MLB', playerAthlete: 'Nolan Ryan',
      team: 'Houston Astros|California Angels', year: 1980, name: 'Strikeout leaders',
    }],
    providerRows,
    config: { ...config, productCatalogCorrections: [correction] },
  });
  assert.equal(pending.rows[0].disposition, 'catalog_subject_correction_pending_review');
  assert.equal(pending.rows[0].requiresCatalogCorrectionBeforeMapping, true);
  assert.deepEqual(pending.rows[0].proposedSubjects, []);
  assert.equal(pending.sourceBackedCandidateProductCount, 0);

  const corrected = buildProSportsCatalogMappingCoverage({
    products: [{
      id: 91, category: 'Baseball', league: 'MLB', playerAthlete: 'J.R. Richard|Nolan Ryan',
      team: 'Houston Astros|California Angels', year: 1980, name: 'Strikeout leaders',
    }],
    providerRows,
    config: { ...config, productCatalogCorrections: [correction] },
  });
  assert.equal(corrected.rows[0].disposition, 'source_exact_unique_candidate');
  assert.equal(corrected.rows[0].evidence.team.status, 'partial');
  assert.equal(corrected.rows[0].evidence.reviewedCatalogCorrection, 'Reviewed 1979-stat card context.');
  assert.equal(corrected.rows[0].proposedCatalogCorrections, null);
  assert.deepEqual(corrected.rows[0].proposedSubjects.map((subject) => subject.candidates[0].providerExternalId), ['richard', 'ryan']);
});

test('any player-subject list correction is held before the catalog source is corrected', () => {
  const correction = {
    productId: 92, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: 'Renamed subject card', playerAthlete: 'Alice|Bob', team: 'Alpha|Beta', year: 2020,
    },
    expectedCorrectedProduct: {
      name: 'Renamed subject card', playerAthlete: 'Alicia|Bob', team: 'Alpha|Beta', year: 2020,
    },
    evidence: 'Reviewed local card image.',
    proposedCatalogCorrections: { playerAthlete: 'Alicia|Bob' },
  };
  const coverage = buildProSportsCatalogMappingCoverage({
    products: [{
      id: 92, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice|Bob',
      team: 'Alpha|Beta', year: 2020, name: 'Renamed subject card',
    }],
    providerRows: [
      { externalId: 'alice', fullName: 'Alice', seasonYear: 2020, teamName: 'Alpha' },
      { externalId: 'bob', fullName: 'Bob', seasonYear: 2020, teamName: 'Beta' },
    ],
    config: { ...config, productCatalogCorrections: [correction] },
  });
  assert.equal(coverage.rows[0].disposition, 'catalog_subject_correction_pending_review');
  assert.equal(coverage.rows[0].requiresCatalogCorrectionBeforeMapping, true);
  assert.deepEqual(coverage.rows[0].proposedSubjects, []);
  assert.equal(coverage.sourceBackedCandidateProductCount, 0);
});

test('a corrected mixed set stays manual when a subject lacks verified provider identity evidence', () => {
  const correction = {
    productId: 95, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: 'Mixed set', playerAthlete: 'Luis Rodriguez', team: '', year: 2023,
    },
    expectedCorrectedProduct: {
      name: 'Mixed set', playerAthlete: 'Luis Rodriguez|Ivan Herrera|Alec Burleson', team: '', year: 2023,
    },
    holdMappingAfterCorrection: true,
    evidence: 'Local set image identifies three cards, but the first subject has no verified cache identity.',
    proposedCatalogCorrections: { playerAthlete: 'Luis Rodriguez|Ivan Herrera|Alec Burleson' },
  };
  const coverage = buildProSportsCatalogMappingCoverage({
    products: [{
      id: 95, category: 'Baseball', league: 'MLB',
      playerAthlete: 'Luis Rodriguez|Ivan Herrera|Alec Burleson', team: '', year: 2023, name: 'Mixed set',
    }],
    providerRows: [
      { externalId: 'older-luis', fullName: 'Luis Rodriguez', seasonYear: 2000, teamName: 'Older Team' },
      { externalId: 'herrera', fullName: 'Ivan Herrera', seasonYear: 2023, teamName: 'St. Louis Cardinals' },
      { externalId: 'burleson', fullName: 'Alec Burleson', seasonYear: 2023, teamName: 'St. Louis Cardinals' },
    ],
    config: { ...config, productCatalogCorrections: [correction] },
  });
  assert.equal(coverage.rows[0].disposition, 'catalog_identity_evidence_pending_review');
  assert.equal(coverage.rows[0].requiresProviderIdentityEvidenceBeforeMapping, true);
  assert.deepEqual(coverage.rows[0].proposedSubjects, []);
  assert.equal(coverage.sourceBackedCandidateProductCount, 0);
});

test('catalog corrections require an exact derived corrected fingerprint', () => {
  const product = [{
    id: 93, category: 'Baseball', league: 'MLB', playerAthlete: 'Alice',
    team: 'Alpha', year: 2020, name: 'Correction validation card',
  }];
  const baseCorrection = {
    productId: 93, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: 'Correction validation card', playerAthlete: 'Alice', team: 'Alpha', year: 2020,
    },
    expectedCorrectedProduct: {
      name: 'Correction validation card', playerAthlete: 'Alice', team: 'Beta', year: 2020,
    },
    evidence: 'Reviewed local card image.',
    proposedCatalogCorrections: { team: 'Beta' },
  };
  const build = (correction) => buildProSportsCatalogMappingCoverage({
    products: product,
    providerRows: [{ externalId: 'alice', fullName: 'Alice', seasonYear: 2020, teamName: 'Alpha' }],
    config: { ...config, productCatalogCorrections: [correction] },
  });
  const { expectedCorrectedProduct, ...missingPostFingerprint } = baseCorrection;
  assert.throws(() => build(missingPostFingerprint), /expectedCorrectedProduct/);
  assert.throws(() => build({
    ...baseCorrection,
    proposedCatalogCorrections: { description: 'Unsupported' },
  }), /unsupported catalog field/);
  assert.throws(() => build({
    ...baseCorrection,
    expectedCorrectedProduct: { ...baseCorrection.expectedCorrectedProduct, team: 'Gamma' },
  }), /must match the declared catalog correction/);
});
