import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCandidateProducts,
  extractVerifiedMatches,
  isNbaCatalogProduct,
  matchesSearch,
  normalizeSearchText
} from '../../tools/player-card-matchups/player-card-matchups.js';

const products = [
  { id: 1, category: 'Basketball', league: 'NBA', sport: 'Basketball', playerAthlete: 'Stephen Curry', name: '2015 Prizm Stephen Curry', year: 2015 },
  { id: 2, category: 'Basketball', league: 'NBA', sport: 'Basketball', playerAthlete: 'Stephen Curry', name: '2022 Hoops Stephen Curry', year: 2022 },
  { id: 3, category: 'Basketball', league: 'NBA', sport: 'Basketball', playerAthlete: 'Michael Jordan', name: '1990 Fleer Michael Jordan', year: 1990 },
  { id: 4, category: 'Basketball', league: 'NBA', sport: 'Basketball', playerAthlete: 'Stephen Curry', name: 'Hidden Stephen Curry', saleStatus: 'hidden' },
  { id: 5, category: 'Baseball', league: 'MLB', playerAthlete: 'Stephen Curry', name: 'Wrong sport' }
];

test('matchup search normalization and token matching are deterministic', () => {
  assert.equal(normalizeSearchText("Derrick Rose Jr."), 'derrick rose jr');
  assert.equal(matchesSearch('Stephen Curry', 'curry'), true);
  assert.equal(matchesSearch('Stephen Curry', 'steph curry'), true);
  assert.equal(matchesSearch('Stephen Curry', 'jordan'), false);
});

test('candidate narrowing preserves only buyer-safe NBA catalog products', () => {
  assert.equal(isNbaCatalogProduct(products[0]), true);
  assert.equal(isNbaCatalogProduct(products[3]), false);
  assert.equal(isNbaCatalogProduct(products[4]), false);
  assert.deepEqual(buildCandidateProducts(products, 'curry').map((product) => product.id), [2, 1]);
});

test('verified extraction rejects title-only and wrong-product payloads', () => {
  const payload = {
    schemaVersion: 1,
    provider: 'NBA',
    productId: 1,
    players: [{
      mapping: { reviewState: 'auto_verified', subjectRole: 'subject' },
      player: { athleteId: 'athlete-1', name: 'Stephen Curry', primaryPosition: 'G' },
      seasons: []
    }]
  };
  assert.equal(extractVerifiedMatches(payload, products[0], 'Curry').length, 1);
  assert.equal(extractVerifiedMatches(payload, products[0], 'Jordan').length, 0);
  assert.equal(extractVerifiedMatches(payload, products[2], 'Curry').length, 0);
  assert.equal(extractVerifiedMatches({ ...payload, players: [{ ...payload.players[0], mapping: { reviewState: 'unresolved' } }] }, products[0], 'Curry').length, 0);
});
