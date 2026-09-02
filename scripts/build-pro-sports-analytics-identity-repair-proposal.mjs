import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();

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
    preflightPath: 'outputs/pro-sports-product-mapping-private-preflight.json',
    reportPath: 'outputs/pro-sports-analytics-identity-repair-proposal.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--preflight=')) options.preflightPath = argument.slice('--preflight='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function buildAnalyticsIdentityRepairProposal(preflight = {}, sourceHash = '') {
  if (preflight?.mode !== 'private_read_only_preflight') {
    throw new Error('Input is not a private preflight report.');
  }
  const repairsByAthlete = new Map();
  for (const product of preflight.results || []) {
    for (const subject of product.subjects || []) {
      if (!subject.markerOnlyNameDrift) continue;
      const repair = {
        leagueCode: String(product.leagueCode || ''),
        sourceName: String(product.sourceName || ''),
        athleteId: String(subject.analyticsAthleteId || ''),
        providerExternalId: String(subject.providerExternalId || ''),
        currentCanonicalName: String(subject.analyticsCanonicalName || ''),
        currentNormalizedName: String(subject.analyticsNormalizedName || ''),
        proposedCanonicalName: String(subject.providerCanonicalName || ''),
        normalizedName: String(subject.providerNormalizedName || ''),
        affectedProductIds: [],
        sourceEvidence: 'provider display marker only',
        confidence: 'exact',
        disposition: 'ready_for_analytics_identity_repair_review',
      };
      if (!repair.athleteId || !repair.currentNormalizedName || !repair.proposedCanonicalName || !repair.normalizedName) {
        throw new Error(`Marker repair for product ${product.productId} lacks an athlete or proposed name.`);
      }
      const prior = repairsByAthlete.get(repair.athleteId);
      if (prior && (prior.currentCanonicalName !== repair.currentCanonicalName
        || prior.currentNormalizedName !== repair.currentNormalizedName
        || prior.proposedCanonicalName !== repair.proposedCanonicalName
        || prior.normalizedName !== repair.normalizedName
        || prior.sourceName !== repair.sourceName
        || prior.providerExternalId !== repair.providerExternalId)) {
        throw new Error(`Conflicting repair proposal for athlete ${repair.athleteId}.`);
      }
      const target = prior || repair;
      target.affectedProductIds.push(Number(product.productId));
      repairsByAthlete.set(repair.athleteId, target);
    }
  }
  const repairs = [...repairsByAthlete.values()].map((repair) => ({
    ...repair,
    affectedProductIds: [...new Set(repair.affectedProductIds)].sort((left, right) => left - right),
    requiredReadback: {
      athletesCanonicalName: repair.proposedCanonicalName,
      previousNormalizedName: repair.currentNormalizedName,
      normalizedName: repair.normalizedName,
      leagueAliasWithoutDisplayMarker: repair.proposedCanonicalName,
      leagueProfileFullName: repair.proposedCanonicalName,
    },
  })).sort((left, right) => left.leagueCode.localeCompare(right.leagueCode)
    || left.proposedCanonicalName.localeCompare(right.proposedCanonicalName));
  return {
    mode: 'proposal_only',
    sourcePreflightSha256: sourceHash,
    sourceProposalSha256: String(preflight.proposalSha256 || ''),
    repairIdentityCount: repairs.length,
    affectedProductCount: new Set(repairs.flatMap((repair) => repair.affectedProductIds)).size,
    repairs,
    targetBoundary: {
      targetProject: 'sports_analytics_extra',
      tablesRequiringReviewedRepair: ['athletes', 'athlete_aliases', 'mlb_players'],
      databaseWritesPerformed: false,
      applyPayloadIncluded: false,
      postRepairPrivatePreflightRequired: true,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const preflightPath = workspacePath(options.preflightPath, 'Preflight path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const sourceText = await fs.readFile(preflightPath, 'utf8');
  const report = {
    generatedAt: new Date().toISOString(),
    preflightPath: path.relative(ROOT, preflightPath).replace(/\\/g, '/'),
    ...buildAnalyticsIdentityRepairProposal(
      JSON.parse(sourceText), crypto.createHash('sha256').update(sourceText).digest('hex'),
    ),
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    repairIdentityCount: report.repairIdentityCount,
    affectedProductCount: report.affectedProductCount,
    reportPath: path.relative(ROOT, reportPath).replace(/\\/g, '/'),
  }, null, 2));
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
