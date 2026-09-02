import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNbaProductMappingReviewProposal } from '../build-nba-product-mapping-review-proposal.mjs';

function report(queue) {
  return {
    mode: 'public_read_only_review_queue',
    parity: { safeForCandidateIds: true, mismatchCount: 0 },
    queue,
  };
}

test('review proposal deduplicates aliases and preserves ordered multi-player mappings', () => {
  const candidate = (productId, productName, subjects) => ({
    productId,
    productName,
    sourcePlayerText: subjects.map((subject) => subject.text).join('|'),
    currentValues: { playerAthlete: subjects.map((subject) => subject.text).join('|'), team: 'Team', publicMappingStatus: 'empty' },
    disposition: 'analytics_normalized_identity_candidate',
    proposed: subjects.map((subject, index) => ({
      subjectOrder: index + 1,
      athleteId: subject.id,
      sourcePlayerText: subject.text,
    })),
    evidence: subjects.map((subject, index) => ({
      subjectOrder: index + 1,
      matchMethod: 'diacritic_punctuation_fold',
      candidates: [{ playerId: subject.id, playerName: subject.analyticsName }],
    })),
  });
  const result = buildNbaProductMappingReviewProposal(report([
    candidate(10, '2023-24 Card', [
      { id: 'a', text: 'Nikola Jokic', analyticsName: 'Nikola Jokić' },
      { id: 'b', text: 'Luka Doncic', analyticsName: 'Luka Dončić' },
    ]),
    candidate(11, '2023-24 Other', [
      { id: 'a', text: 'Nikola Jokic', analyticsName: 'Nikola Jokić' },
    ]),
  ]));
  assert.equal(result.summary.highConfidenceProductCount, 2);
  assert.equal(result.summary.highConfidenceMappingRowCount, 3);
  assert.equal(result.summary.uniqueAliasProposalCount, 2);
  assert.deepEqual(result.aliasProposals.find((item) => item.athleteId === 'a').productIds, [10, 11]);
  assert.deepEqual(result.highConfidenceProducts[0].proposedSubjects.map((item) => item.subjectOrder), [1, 2]);
  assert.equal(result.aliasProposals[0].proposedReviewState, 'needs_review');
});

test('review proposal retains medium-confidence suggestions outside write candidates', () => {
  const result = buildNbaProductMappingReviewProposal(report([{
    productId: 20,
    productName: 'Card',
    sourcePlayerText: 'Corey Joseph',
    team: 'Team',
    disposition: 'likely_identity_review_candidate',
    suggested: [{ subjectOrder: 1, athleteId: 'cory', reviewMethod: 'single_character_first_name' }],
  }]));
  assert.equal(result.summary.highConfidenceProductCount, 0);
  assert.equal(result.summary.manualReviewProductCount, 1);
  assert.equal(result.manualReviewProducts[0].suggestions[0].reviewMethod, 'single_character_first_name');
});

test('review proposal fails closed without proven identity parity', () => {
  assert.throws(() => buildNbaProductMappingReviewProposal({
    mode: 'public_read_only_review_queue',
    parity: { safeForCandidateIds: false, mismatchCount: 1 },
    queue: [],
  }), /identity parity/i);
});
