import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProSportsMappingReviewProposal } from '../build-pro-sports-product-mapping-review-proposal.mjs';

function coverageRow(overrides = {}) {
  return {
    productId: 10,
    productName: 'Card',
    disposition: 'source_exact_unique_candidate',
    confidence: 'high',
    currentValues: { playerAthlete: 'Player One', team: 'Team', year: 2020 },
    evidence: { source: 'baseball_reference' },
    proposedSubjects: [{
      subjectOrder: 1,
      sourcePlayerText: 'Player One',
      matchMethod: 'provider_name_exact',
      candidateCount: 1,
      candidates: [{
        providerExternalId: 'player01', providerCanonicalName: 'Player One',
        providerObservedNames: ['Player One'], providerFirstSeason: 2010, providerLastSeason: 2020,
      }],
    }],
    ...overrides,
  };
}

test('review proposal retains only exact unique and career-disambiguated products as high confidence', () => {
  const proposal = buildProSportsMappingReviewProposal({
    mode: 'local_read_only_proposal',
    sports: {
      mlb: {
        leagueCode: 'MLB', sourceName: 'baseball_reference',
        rows: [
          coverageRow(),
          coverageRow({ productId: 11, disposition: 'source_exact_career_disambiguated_candidate' }),
          coverageRow({ productId: 12, disposition: 'source_normalized_unique_candidate' }),
          coverageRow({ productId: 14, disposition: 'ambiguous_provider_identity', confidence: 'none' }),
          coverageRow({ productId: 13, disposition: 'intentionally_blank_team_lot', proposedSubjects: [] }),
        ],
      },
    },
  }, 'abc');
  assert.equal(proposal.highConfidenceProductCount, 3);
  assert.equal(proposal.highConfidenceMappingRowCount, 3);
  assert.equal(proposal.manualReviewProductCount, 1);
  assert.equal(proposal.intentionallyUnmappedProductCount, 1);
  assert.equal(proposal.highConfidenceProducts[0].proposedSubjects[0].providerExternalId, 'player01');
  assert.equal(proposal.highConfidenceProducts[0].proposedSubjects[0].proposedReviewState, 'needs_review');
  assert.equal(proposal.publicationBoundary.databasePayloadIncluded, false);
});

test('review proposal fails closed when a high-confidence subject lacks one unique provider identity', () => {
  assert.throws(() => buildProSportsMappingReviewProposal({
    mode: 'local_read_only_proposal',
    sports: { mlb: { leagueCode: 'MLB', sourceName: 'baseball_reference', rows: [coverageRow({
      proposedSubjects: [{
        subjectOrder: 1,
        sourcePlayerText: 'Player One',
        candidateCount: 2,
        candidates: [{}, {}],
      }],
    })] } },
  }, 'abc'), /exactly one provider identity/);
});

test('review proposal retains reviewed override candidates and keeps field corrections proposal-only', () => {
  const proposal = buildProSportsMappingReviewProposal({
    mode: 'local_read_only_proposal',
    sports: { nfl: { leagueCode: 'NFL', sourceName: 'pro_football_reference', rows: [coverageRow({
      productId: 25,
      disposition: 'reviewed_product_identity_override_candidate',
      proposedCatalogCorrections: { team: 'New Orleans Saints' },
      proposedSubjects: [{
        subjectOrder: 1, sourcePlayerText: 'Player One', matchMethod: 'reviewed_product_identity_override',
        candidateCount: 1, candidates: [{ providerExternalId: 'thomas', providerCanonicalName: 'Michael Thomas' }],
      }],
    })] } },
  }, 'abc');
  assert.equal(proposal.highConfidenceProductCount, 1);
  assert.equal(proposal.catalogDataCorrectionCandidateCount, 1);
  assert.deepEqual(proposal.catalogDataCorrectionCandidates[0].proposedCatalogCorrections, { team: 'New Orleans Saints' });
  assert.equal(proposal.publicationBoundary.databaseWritesPerformed, false);
});

test('identity-ready products with unverified team attributes stay visible in a separate review queue', () => {
  const proposal = buildProSportsMappingReviewProposal({
    mode: 'local_read_only_proposal',
    sports: { mlb: { leagueCode: 'MLB', sourceName: 'baseball_reference', rows: [coverageRow({
      evidence: {
        source: 'baseball_reference',
        team: { status: 'provider_team_year_unavailable' },
        catalogAttributeReviewRequired: true,
      },
    })] } },
  }, 'abc');
  assert.equal(proposal.highConfidenceProductCount, 1);
  assert.equal(proposal.catalogAttributeReviewProductCount, 1);
  assert.equal(proposal.catalogAttributeReviewProducts[0].productId, 10);
  assert.equal(proposal.catalogAttributeReviewProducts[0].evidence.team.status, 'provider_team_year_unavailable');
  assert.equal(proposal.leagueCounts.mlb.catalogAttributeReviewProductCount, 1);
});

test('a correction that adds card subjects is held until the catalog source is corrected and regenerated', () => {
  const proposal = buildProSportsMappingReviewProposal({
    mode: 'local_read_only_proposal',
    sports: { mlb: { leagueCode: 'MLB', sourceName: 'baseball_reference', rows: [coverageRow({
      proposedCatalogCorrections: { playerAthlete: 'Player Zero|Player One' },
    })] } },
  }, 'abc');
  assert.equal(proposal.highConfidenceProductCount, 0);
  assert.equal(proposal.manualReviewProductCount, 1);
  assert.equal(proposal.manualReviewProducts[0].disposition, 'catalog_subject_correction_pending_review');
  assert.equal(proposal.manualReviewProducts[0].requiresCatalogCorrectionBeforeMapping, true);
  assert.equal(proposal.catalogDataCorrectionCandidateCount, 1);
});

test('a same-count player substitution is held until the catalog source is corrected and regenerated', () => {
  const proposal = buildProSportsMappingReviewProposal({
    mode: 'local_read_only_proposal',
    sports: { mlb: { leagueCode: 'MLB', sourceName: 'baseball_reference', rows: [coverageRow({
      proposedCatalogCorrections: { playerAthlete: 'Player Two' },
    })] } },
  }, 'abc');
  assert.equal(proposal.highConfidenceProductCount, 0);
  assert.equal(proposal.manualReviewProductCount, 1);
  assert.equal(proposal.manualReviewProducts[0].disposition, 'catalog_subject_correction_pending_review');
  assert.equal(proposal.manualReviewProducts[0].requiresCatalogCorrectionBeforeMapping, true);
});
