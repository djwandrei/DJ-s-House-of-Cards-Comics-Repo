import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnalyticsIdentityRepairProposal } from '../build-pro-sports-analytics-identity-repair-proposal.mjs';

test('identity repair proposal deduplicates athletes while retaining affected products', () => {
  const subject = {
    markerOnlyNameDrift: true, analyticsAthleteId: 'athlete-1', providerExternalId: 'one',
    analyticsCanonicalName: 'Player One #', analyticsNormalizedName: 'player one #',
    providerCanonicalName: 'Player One', providerNormalizedName: 'player one',
  };
  const report = buildAnalyticsIdentityRepairProposal({
    mode: 'private_read_only_preflight',
    results: [
      { productId: 2, leagueCode: 'MLB', sourceName: 'baseball_reference', subjects: [subject] },
      { productId: 1, leagueCode: 'MLB', sourceName: 'baseball_reference', subjects: [subject] },
    ],
  }, 'abc');
  assert.equal(report.repairIdentityCount, 1);
  assert.equal(report.affectedProductCount, 2);
  assert.deepEqual(report.repairs[0].affectedProductIds, [1, 2]);
  assert.equal(report.targetBoundary.databaseWritesPerformed, false);
});

test('identity repair proposal rejects conflicting canonical-name repairs', () => {
  assert.throws(() => buildAnalyticsIdentityRepairProposal({
    mode: 'private_read_only_preflight',
    results: [
      { productId: 1, leagueCode: 'MLB', sourceName: 'baseball_reference', subjects: [{ markerOnlyNameDrift: true, analyticsAthleteId: 'athlete-1', providerExternalId: 'one', analyticsCanonicalName: 'Player #', analyticsNormalizedName: 'player #', providerCanonicalName: 'Player', providerNormalizedName: 'player' }] },
      { productId: 2, leagueCode: 'MLB', sourceName: 'baseball_reference', subjects: [{ markerOnlyNameDrift: true, analyticsAthleteId: 'athlete-1', providerExternalId: 'one', analyticsCanonicalName: 'Player #', analyticsNormalizedName: 'player #', providerCanonicalName: 'Other Player', providerNormalizedName: 'other player' }] },
    ],
  }), /Conflicting repair proposal/);
});
