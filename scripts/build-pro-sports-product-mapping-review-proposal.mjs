import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_BACKED_CANDIDATE_DISPOSITIONS, splitProductSubjects } from './lib/pro-sports-product-mapping-coverage.mjs';

const ROOT = process.cwd();
const INTENTIONALLY_UNMAPPED_DISPOSITIONS = new Set([
  'intentionally_blank_team_lot',
  'intentionally_unmapped_catalog_misclassification',
]);

function workspacePath(relativePath, label) {
  const resolved = path.resolve(ROOT, String(relativePath || ''));
  const root = path.resolve(ROOT);
  const prefix = `${root}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== root.toLowerCase() && !resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}

export function optionsFromArgs(argv = []) {
  const options = {
    coveragePath: 'outputs/pro-sports-product-mapping-coverage.json',
    reportPath: 'outputs/pro-sports-product-mapping-review-proposal.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--coverage=')) options.coveragePath = argument.slice('--coverage='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function proposedProduct(row, leagueCode, sourceName) {
  const expectedSubjects = splitProductSubjects(row.currentValues?.playerAthlete);
  const orderedSubjects = [...(row.proposedSubjects || [])]
    .sort((left, right) => Number(left.subjectOrder) - Number(right.subjectOrder));
  if (orderedSubjects.length !== expectedSubjects.length) {
    throw new Error(`Product ${row.productId} does not resolve every current catalog subject.`);
  }
  const providerExternalIds = new Set();
  for (const [index, subject] of orderedSubjects.entries()) {
    if (Number(subject.subjectOrder) !== index + 1 || String(subject.sourcePlayerText || '') !== expectedSubjects[index]) {
      throw new Error(`Product ${row.productId} has a non-contiguous or mismatched subject order.`);
    }
    if (subject.candidateCount !== 1 || subject.candidates?.length !== 1) {
      throw new Error(`Product ${row.productId} does not have exactly one provider identity per subject.`);
    }
    const providerExternalId = String(subject.candidates[0]?.providerExternalId || '');
    if (!providerExternalId || providerExternalIds.has(providerExternalId)) {
      throw new Error(`Product ${row.productId} has duplicate or missing provider identities.`);
    }
    providerExternalIds.add(providerExternalId);
  }
  return {
    productId: Number(row.productId),
    productName: String(row.productName || ''),
    leagueCode,
    sourceName,
    currentValues: row.currentValues,
    evidence: row.evidence,
    confidence: 'high',
    disposition: row.disposition,
    catalogAttributeReviewRequired: row.evidence?.catalogAttributeReviewRequired === true,
    proposedCatalogCorrections: row.proposedCatalogCorrections || null,
    proposedSubjects: orderedSubjects.map((subject) => {
      const candidate = subject.candidates[0];
      return {
        subjectOrder: Number(subject.subjectOrder),
        sourcePlayerText: String(subject.sourcePlayerText || ''),
        matchMethod: String(subject.matchMethod || ''),
        providerExternalId: String(candidate.providerExternalId || ''),
        providerCanonicalName: String(candidate.providerCanonicalName || ''),
        providerObservedNames: candidate.providerObservedNames || [],
        providerFirstSeason: candidate.providerFirstSeason ?? null,
        providerLastSeason: candidate.providerLastSeason ?? null,
        overrideEvidence: subject.overrideEvidence || null,
        proposedCatalogCorrections: subject.proposedCatalogCorrections || null,
        proposedReviewState: 'needs_review',
      };
    }),
  };
}

function correctionChangesSubjectLayout(row) {
  const corrected = row.proposedCatalogCorrections?.playerAthlete;
  if (typeof corrected !== 'string') return false;
  const currentSubjects = splitProductSubjects(row.currentValues?.playerAthlete);
  const correctedSubjects = splitProductSubjects(corrected);
  return correctedSubjects.length !== currentSubjects.length
    || correctedSubjects.some((subject, index) => subject !== currentSubjects[index]);
}

function manualReviewProduct(row, leagueCode, extra = {}) {
  return {
    productId: Number(row.productId), productName: String(row.productName || ''),
    leagueCode, currentValues: row.currentValues || {
      playerAthlete: row.playerAthlete, team: row.team, year: row.year,
    },
    confidence: String(row.confidence || 'none'),
    disposition: String(row.disposition || ''),
    evidence: row.evidence,
    candidateSubjects: row.proposedSubjects || [],
    proposedCatalogCorrections: row.proposedCatalogCorrections || null,
    requiresCatalogCorrectionBeforeMapping: row.requiresCatalogCorrectionBeforeMapping === true,
    requiresProviderIdentityEvidenceBeforeMapping: row.requiresProviderIdentityEvidenceBeforeMapping === true,
    ...extra,
  };
}

export function buildProSportsMappingReviewProposal(coverage = {}, sourceHash = '') {
  if (coverage?.mode !== 'local_read_only_proposal' || !coverage?.sports) {
    throw new Error('Input is not a pro-sports mapping coverage report.');
  }
  const highConfidenceProducts = [];
  const manualReviewProducts = [];
  const intentionallyUnmappedProducts = [];
  const leagueCounts = {};
  for (const [sport, result] of Object.entries(coverage.sports)) {
    const leagueCode = String(result.leagueCode || '').toUpperCase();
    const sourceName = String(result.sourceName || '');
    const leagueHigh = [];
    const leagueManual = [];
    const leagueIntentional = [];
    for (const row of Array.isArray(result.rows) ? result.rows : []) {
      if (SOURCE_BACKED_CANDIDATE_DISPOSITIONS.has(row.disposition)) {
        if (correctionChangesSubjectLayout(row)) {
          leagueManual.push(manualReviewProduct(row, leagueCode, {
            confidence: 'review',
            disposition: 'catalog_subject_correction_pending_review',
            requiresCatalogCorrectionBeforeMapping: true,
          }));
        } else {
          leagueHigh.push(proposedProduct(row, leagueCode, sourceName));
        }
      } else if (INTENTIONALLY_UNMAPPED_DISPOSITIONS.has(row.disposition)) {
        leagueIntentional.push({
          productId: Number(row.productId), productName: String(row.productName || ''),
          leagueCode,
          currentValues: row.currentValues || {
            playerAthlete: row.playerAthlete, team: row.team, year: row.year,
          },
          disposition: row.disposition, evidence: row.evidence,
          proposedCatalogCorrections: row.proposedCatalogCorrections || null,
        });
      } else {
        leagueManual.push(manualReviewProduct(row, leagueCode));
      }
    }
    highConfidenceProducts.push(...leagueHigh);
    manualReviewProducts.push(...leagueManual);
    intentionallyUnmappedProducts.push(...leagueIntentional);
    leagueCounts[sport] = {
      leagueCode,
      highConfidenceProductCount: leagueHigh.length,
      highConfidenceMappingRowCount: leagueHigh.reduce((sum, row) => sum + row.proposedSubjects.length, 0),
      catalogAttributeReviewProductCount: leagueHigh.filter((row) => row.catalogAttributeReviewRequired).length,
      manualReviewProductCount: leagueManual.length,
      intentionallyUnmappedProductCount: leagueIntentional.length,
    };
  }
  highConfidenceProducts.sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.productId - right.productId);
  manualReviewProducts.sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.productId - right.productId);
  intentionallyUnmappedProducts.sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.productId - right.productId);
  const catalogAttributeReviewProducts = highConfidenceProducts.filter((product) => product.catalogAttributeReviewRequired)
    .map((product) => ({
      productId: product.productId,
      productName: product.productName,
      leagueCode: product.leagueCode,
      currentValues: product.currentValues,
      disposition: product.disposition,
      evidence: product.evidence,
      proposedSubjects: product.proposedSubjects,
    }));
  const catalogDataCorrectionCandidates = [
    ...highConfidenceProducts,
    ...manualReviewProducts,
    ...intentionallyUnmappedProducts,
  ].filter((product) => product.proposedCatalogCorrections).map((product) => ({
    productId: product.productId,
    productName: product.productName,
    leagueCode: product.leagueCode,
    currentValues: product.currentValues || null,
      proposedCatalogCorrections: product.proposedCatalogCorrections,
      evidence: product.evidence,
      disposition: product.disposition,
      requiresCatalogCorrectionBeforeMapping: product.requiresCatalogCorrectionBeforeMapping === true,
  })).sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.productId - right.productId);
  return {
    mode: 'proposal_only',
    sourceCoverageSha256: sourceHash,
    leagueCounts,
    highConfidenceProductCount: highConfidenceProducts.length,
    highConfidenceMappingRowCount: highConfidenceProducts
      .reduce((sum, row) => sum + row.proposedSubjects.length, 0),
    catalogAttributeReviewProductCount: catalogAttributeReviewProducts.length,
    manualReviewProductCount: manualReviewProducts.length,
    intentionallyUnmappedProductCount: intentionallyUnmappedProducts.length,
    catalogDataCorrectionCandidateCount: catalogDataCorrectionCandidates.length,
    highConfidenceProducts,
    catalogAttributeReviewProducts,
    manualReviewProducts,
    intentionallyUnmappedProducts,
    catalogDataCorrectionCandidates,
    requiredPrivateChecks: [
      'analytics provider external ID resolves to exactly one athlete',
      'analytics athlete has verified membership in the proposed league',
      'commerce athlete identity uses the same universal UUID',
      'commerce alias is unique within the proposed league',
      'remote product still matches the proposed catalog player, team, year, category, and league',
      'remote product has no active or review-state mapping rows',
      'catalog team fields marked for attribute review are not overwritten by the mapping workflow',
    ],
    publicationBoundary: {
      databasePayloadIncluded: false,
      databaseWritesPerformed: false,
      providerExternalIdsAreNotCommerceAthleteIds: true,
      reviewRequiredBeforeApply: true,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const coveragePath = workspacePath(options.coveragePath, 'Coverage path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const coverageText = await fs.readFile(coveragePath, 'utf8');
  const proposal = {
    generatedAt: new Date().toISOString(),
    coveragePath: path.relative(ROOT, coveragePath).replace(/\\/g, '/'),
    ...buildProSportsMappingReviewProposal(JSON.parse(coverageText), hashText(coverageText)),
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    highConfidenceProductCount: proposal.highConfidenceProductCount,
    highConfidenceMappingRowCount: proposal.highConfidenceMappingRowCount,
    catalogAttributeReviewProductCount: proposal.catalogAttributeReviewProductCount,
    manualReviewProductCount: proposal.manualReviewProductCount,
    intentionallyUnmappedProductCount: proposal.intentionallyUnmappedProductCount,
    catalogDataCorrectionCandidateCount: proposal.catalogDataCorrectionCandidateCount,
    leagueCounts: proposal.leagueCounts,
    reportPath: path.relative(ROOT, reportPath).replace(/\\/g, '/'),
  }, null, 2));
  return proposal;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
