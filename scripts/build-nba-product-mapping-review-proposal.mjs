import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inferNbaSeasonContext,
  normalizeCatalogPlayerName,
} from './lib/nba-product-player-mapping.mjs';

const ROOT = process.cwd();
const HIGH_CONFIDENCE_DISPOSITIONS = new Set([
  'analytics_exact_identity_candidate',
  'analytics_normalized_identity_candidate',
]);

function workspacePath(relativePath, label) {
  const resolved = path.resolve(ROOT, String(relativePath || ''));
  const root = path.resolve(ROOT);
  const prefix = `${root}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== root.toLowerCase()
    && !resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}

export function optionsFromArgs(argv = []) {
  const options = {
    candidatePath: 'outputs/nba-product-mapping-analytics-candidates.json',
    reportPath: 'outputs/nba-product-mapping-review-proposal.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--candidates=')) {
      options.candidatePath = argument.slice('--candidates='.length);
    } else if (argument.startsWith('--report=')) {
      options.reportPath = argument.slice('--report='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function cleanEvidenceCandidates(item, subjectOrder) {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  const subject = evidence.find((entry) => Number(entry?.subjectOrder) === subjectOrder);
  return Array.isArray(subject?.candidates) ? subject.candidates : [];
}

function proposalSubject(item, subject) {
  const subjectOrder = Number(subject?.subjectOrder);
  const candidates = cleanEvidenceCandidates(item, subjectOrder);
  const analyticsName = candidates.find((candidate) => (
    String(candidate?.playerId || '') === String(subject?.athleteId || '')
  ))?.playerName || '';
  const evidence = (Array.isArray(item?.evidence) ? item.evidence : [])
    .find((entry) => Number(entry?.subjectOrder) === subjectOrder) || {};
  return {
    subjectOrder,
    sourcePlayerText: String(subject?.sourcePlayerText || '').trim(),
    proposedAthleteId: String(subject?.athleteId || '').trim(),
    analyticsPlayerName: String(analyticsName || '').trim(),
    identityMatchMethod: String(evidence?.matchMethod || ''),
  };
}

export function buildNbaProductMappingReviewProposal(candidateReport = {}) {
  if (candidateReport?.mode !== 'public_read_only_review_queue') {
    throw new Error('Candidate input is not a public read-only review queue.');
  }
  if (!candidateReport?.parity?.safeForCandidateIds
    || Number(candidateReport?.parity?.mismatchCount) !== 0) {
    throw new Error('Cross-project identity parity is not safe for mapping proposals.');
  }

  const queue = Array.isArray(candidateReport?.queue) ? candidateReport.queue : [];
  const highConfidenceProducts = [];
  const manualReviewProducts = [];
  const aliasEvidence = new Map();

  for (const item of queue) {
    if (HIGH_CONFIDENCE_DISPOSITIONS.has(String(item?.disposition || ''))) {
      const subjects = (Array.isArray(item?.proposed) ? item.proposed : [])
        .map((subject) => proposalSubject(item, subject))
        .sort((left, right) => left.subjectOrder - right.subjectOrder);
      if (!subjects.length || subjects.some((subject, index) => (
        subject.subjectOrder !== index + 1
          || !subject.sourcePlayerText
          || !subject.proposedAthleteId
      ))) {
        throw new Error(`High-confidence product ${item?.productId} has an incomplete subject proposal.`);
      }
      if (new Set(subjects.map((subject) => subject.proposedAthleteId)).size !== subjects.length) {
        throw new Error(`High-confidence product ${item?.productId} repeats an athlete subject.`);
      }

      highConfidenceProducts.push({
        productId: Number(item?.productId),
        productName: String(item?.productName || ''),
        currentValues: item?.currentValues || {
          playerAthlete: String(item?.sourcePlayerText || ''),
          team: String(item?.team || ''),
          publicMappingStatus: 'empty',
        },
        confidence: 'high_review_candidate',
        disposition: String(item?.disposition || ''),
        proposedSeasonContext: inferNbaSeasonContext(item?.productName),
        proposedSubjects: subjects,
        requiredNextAction: 'verify_commerce_alias_then_create_mapping',
      });

      for (const subject of subjects) {
        const normalizedAlias = normalizeCatalogPlayerName(subject.sourcePlayerText);
        const key = `${subject.proposedAthleteId}:${normalizedAlias}`;
        const existing = aliasEvidence.get(key) || {
          athleteId: subject.proposedAthleteId,
          leagueCode: 'NBA',
          alias: subject.sourcePlayerText,
          normalizedAlias,
          aliasType: 'catalog_override',
          proposedReviewState: 'needs_review',
          sourceName: 'public_nba_analytics_player_pool',
          analyticsPlayerNames: new Set(),
          productIds: new Set(),
        };
        if (subject.analyticsPlayerName) existing.analyticsPlayerNames.add(subject.analyticsPlayerName);
        existing.productIds.add(Number(item.productId));
        aliasEvidence.set(key, existing);
      }
    } else if (item?.disposition === 'likely_identity_review_candidate') {
      manualReviewProducts.push({
        productId: Number(item?.productId),
        productName: String(item?.productName || ''),
        currentValues: item?.currentValues || {
          playerAthlete: String(item?.sourcePlayerText || ''),
          team: String(item?.team || ''),
          publicMappingStatus: 'empty',
        },
        confidence: 'medium_review_candidate',
        disposition: 'likely_identity_review_candidate',
        suggestions: Array.isArray(item?.suggested) ? item.suggested : [],
        requiredNextAction: 'manually_verify_identity_then_alias',
      });
    }
  }

  const aliasProposals = [...aliasEvidence.values()]
    .map((entry) => ({
      ...entry,
      analyticsPlayerNames: [...entry.analyticsPlayerNames].sort(),
      productIds: [...entry.productIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => (
      left.normalizedAlias.localeCompare(right.normalizedAlias)
      || left.athleteId.localeCompare(right.athleteId)
    ));
  highConfidenceProducts.sort((left, right) => left.productId - right.productId);
  manualReviewProducts.sort((left, right) => left.productId - right.productId);

  return {
    mode: 'proposal_only',
    policy: 'private-preflight-required-before-alias-or-mapping-write',
    summary: {
      highConfidenceProductCount: highConfidenceProducts.length,
      highConfidenceMappingRowCount: highConfidenceProducts
        .reduce((total, product) => total + product.proposedSubjects.length, 0),
      uniqueAliasProposalCount: aliasProposals.length,
      manualReviewProductCount: manualReviewProducts.length,
    },
    requiredPrivatePreflight: [
      'remote_product_is_current_visible_nba_product',
      'athlete_identity_is_active',
      'athlete_nba_membership_is_verified',
      'normalized_alias_is_unique_within_nba',
      'product_has_no_active_or_review_mapping_rows',
    ],
    aliasProposals,
    highConfidenceProducts,
    manualReviewProducts,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const candidatePath = workspacePath(options.candidatePath, 'Candidate path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const candidateText = await fs.readFile(candidatePath, 'utf8');
  const proposal = buildNbaProductMappingReviewProposal(JSON.parse(candidateText));
  const report = {
    generatedAt: new Date().toISOString(),
    candidatePath: path.relative(ROOT, candidatePath).replace(/\\/g, '/'),
    candidateSha256: crypto.createHash('sha256').update(candidateText).digest('hex'),
    ...proposal,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ...report.summary,
    reportPath: path.relative(ROOT, reportPath).replace(/\\/g, '/'),
  }, null, 2));
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
