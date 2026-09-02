import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnalyticsPreflightSql,
  evaluateProSportsPrivatePreflight,
  parseSupabaseCliJson,
  stripProviderDisplayMarkers,
} from '../audit-pro-sports-product-mapping-private-preflight.mjs';

const proposal = {
  mode: 'proposal_only',
  highConfidenceProducts: [{
    productId: 10, leagueCode: 'MLB', sourceName: 'baseball_reference',
    currentValues: { playerAthlete: 'Player One', team: 'Team', year: 2020 },
    proposedSubjects: [{ subjectOrder: 1, sourcePlayerText: 'Player One', providerExternalId: 'one', providerCanonicalName: 'Player One' }],
  }],
};

test('analytics SQL is read-only and resolves provider IDs through verified identity tables', () => {
  const sql = buildAnalyticsPreflightSql([{ leagueCode: 'MLB', sourceName: 'baseball_reference', externalId: 'one', providerCanonicalName: 'Player One' }]);
  assert.match(sql, /public\.athlete_external_ids/);
  assert.match(sql, /membership_status/);
  assert.doesNotMatch(sql, /normalize_athlete_name/);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|drop|truncate)\b/i);
});

test('private preflight distinguishes identity-copy readiness from mapping readiness', () => {
  const analytics = { identities: [{
    league_code: 'MLB', source_name: 'baseball_reference', external_id: 'one', provider_name: 'Player One',
    athlete_id: '00000000-0000-0000-0000-000000000001', canonical_name: 'Player One', normalized_name: 'player one',
    identity_status: 'active', membership_status: 'verified', provider_verified_alias_count: 1,
    canonical_verified_alias_count: 1,
  }] };
  const commerceBase = { products: [{
    product_id: 10, remote_product_id: 10, category: 'Baseball', league: 'MLB',
    player_athlete: 'Player One', team: 'Team', year: 2020, is_deleted: false,
    sale_status: 'available', active_mapping_count: 0,
  }], identities: [], leagues: [{ league_code: 'MLB', is_active: null }] };
  let result = evaluateProSportsPrivatePreflight(proposal, analytics, commerceBase);
  assert.deepEqual(result.dispositionCounts, { ready_for_identity_copy_review: 1 });
  result = evaluateProSportsPrivatePreflight(proposal, analytics, {
    ...commerceBase,
    identities: [{
      league_code: 'MLB', athlete_id: '00000000-0000-0000-0000-000000000001', identity_status: 'active',
      membership_status: 'verified', conflicting_alias_count: 0, provider_verified_alias_count: 1,
    }],
    leagues: [{ league_code: 'MLB', is_active: true }],
  });
  assert.deepEqual(result.dispositionCounts, { ready_for_mapping_review: 1 });
});

test('CLI JSON parser ignores status text around the response envelope', () => {
  const parsed = parseSupabaseCliJson('Initialising login role...\n{"rows":[{"payload":{"ok":true}}]}\nUpdate available');
  assert.equal(parsed.rows[0].payload.ok, true);
});

test('provider display-marker drift is isolated for source repair', () => {
  assert.equal(stripProviderDisplayMarkers('Mickey Mantle #'), 'Mickey Mantle');
  const result = evaluateProSportsPrivatePreflight(proposal, { identities: [{
    league_code: 'MLB', source_name: 'baseball_reference', external_id: 'one', provider_name: 'Player One',
    athlete_id: '00000000-0000-0000-0000-000000000001', canonical_name: 'Player One #', normalized_name: 'player one #',
    identity_status: 'active', membership_status: 'verified', provider_verified_alias_count: 0,
    canonical_verified_alias_count: 1,
  }] }, { products: [{
    product_id: 10, remote_product_id: 10, category: 'Baseball', league: 'MLB',
    player_athlete: 'Player One', team: 'Team', year: 2020, is_deleted: false,
    sale_status: 'available', active_mapping_count: 0,
  }], identities: [], leagues: [{ league_code: 'MLB', is_active: null }] });
  assert.deepEqual(result.dispositionCounts, { ready_for_analytics_identity_repair_review: 1 });
  assert.equal(result.results[0].subjects[0].markerOnlyNameDrift, true);
});
