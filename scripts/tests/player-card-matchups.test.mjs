import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCandidateProducts,
  createStaticCatalogFallbackLoader,
  extractVerifiedMatches,
  getCandidateBatch,
  getResultWindow,
  getStaticCatalogFallbackUrl,
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

test('candidate batches are explicit without silently dropping later matches', () => {
  const manyCandidates = Array.from({ length: 30 }, (_, index) => ({
    id: index + 10,
    category: 'Basketball',
    league: 'NBA',
    sport: 'Basketball',
    playerAthlete: 'Stephen Curry',
    name: `Curry card ${index + 1}`,
    year: 2000 + index
  }));
  const candidates = buildCandidateProducts(manyCandidates, 'curry');
  assert.equal(candidates.length, 30);
  assert.deepEqual(getCandidateBatch(candidates, 0, 24).map((product) => product.id).length, 24);
  assert.deepEqual(getCandidateBatch(candidates, 24, 24).map((product) => product.id).length, 6);
  assert.deepEqual(getCandidateBatch(candidates, 30, 24), []);
});

test('result windows retain every confirmed product and expose the remaining page', () => {
  const window = getResultWindow([
    { product: { id: 2, year: 2022 }, player: { athleteId: 'athlete-2', name: 'Stephen Curry' } },
    { product: { id: 1, year: 2021 }, player: { athleteId: 'athlete-1', name: 'Stephen Curry' } },
    { product: { id: 1, year: 2021 }, player: { athleteId: 'athlete-3', name: 'Ayesha Curry' } }
  ], 1);
  assert.equal(window.total, 2);
  assert.equal(window.visible.length, 1);
  assert.equal(window.remaining, 1);
  assert.equal(window.all[1].product.id, 1);
  assert.equal(window.all[1].player.name, 'Ayesha Curry');
});

test('static fallback uses the current shared catalog version and basketball segment', () => {
  assert.equal(
    getStaticCatalogFallbackUrl({ versionedProductAsset: (path) => `/resolved/${path}?v=current` }),
    '/resolved/products-basketball.json?v=current'
  );
  assert.equal(getStaticCatalogFallbackUrl({}), '../../products-basketball.json');
});

test('static basketball fallback is cached for the page lifetime by versioned URL', async () => {
  const requests = [];
  const loadStaticCatalog = createStaticCatalogFallbackLoader(async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => [{ id: 1 }] };
  });
  const DJ = { versionedProductAsset: (path) => `/catalog/${path}?v=reviewed` };
  const [first, second] = await Promise.all([loadStaticCatalog(DJ), loadStaticCatalog(DJ)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/catalog/products-basketball.json?v=reviewed');
  assert.equal(requests[0].options.cache, 'force-cache');
  assert.equal(first, second);
  assert.deepEqual(first, [{ id: 1 }]);
});

test('a failed static fallback request is not retained as a broken cache entry', async () => {
  let requests = 0;
  const loadStaticCatalog = createStaticCatalogFallbackLoader(async () => {
    requests += 1;
    if (requests === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => [] };
  });
  await assert.rejects(loadStaticCatalog({}), /503/);
  await Promise.resolve();
  assert.deepEqual(await loadStaticCatalog({}), []);
  assert.equal(requests, 2);
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
