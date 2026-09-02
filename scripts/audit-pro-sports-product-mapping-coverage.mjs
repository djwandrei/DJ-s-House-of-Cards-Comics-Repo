import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASEBALL_REFERENCE_SOURCE,
  BASEBALL_STAT_GROUPS,
  FOOTBALL_STAT_GROUPS,
  PRO_FOOTBALL_REFERENCE_SOURCE,
  stripHtml,
} from './lib/sports-reference-season-stats.mjs';
import { buildProSportsCatalogMappingCoverage } from './lib/pro-sports-product-mapping-coverage.mjs';
import {
  NFL_TEAM_CODE_NAMES,
  NFL_CARD_CONTEXT_TEAMS,
  MLB_CARD_CONTEXT_TEAMS,
  MLB_TEAM_NAME_ALIASES,
  REVIEWED_CATALOG_ALIAS_OVERRIDES,
  REVIEWED_PRODUCT_CATALOG_CORRECTIONS,
  REVIEWED_PRODUCT_IDENTITY_EXCLUSIONS,
  REVIEWED_PRODUCT_IDENTITY_OVERRIDES,
} from './lib/pro-sports-catalog-identity-overrides.mjs';

const ROOT = process.cwd();
const SPORT_CONFIGS = Object.freeze({
  mlb: Object.freeze({
    category: 'Baseball',
    leagueCode: 'MLB',
    sourceName: BASEBALL_REFERENCE_SOURCE,
    groups: BASEBALL_STAT_GROUPS,
    extension: 'shtml',
    aliasOverrides: REVIEWED_CATALOG_ALIAS_OVERRIDES,
    productIdentityOverrides: REVIEWED_PRODUCT_IDENTITY_OVERRIDES,
    productCatalogCorrections: REVIEWED_PRODUCT_CATALOG_CORRECTIONS,
    productIdentityExclusions: REVIEWED_PRODUCT_IDENTITY_EXCLUSIONS,
    teamContextNames: MLB_CARD_CONTEXT_TEAMS,
    teamNameAliases: MLB_TEAM_NAME_ALIASES,
  }),
  nfl: Object.freeze({
    category: 'Football',
    leagueCode: 'NFL',
    sourceName: PRO_FOOTBALL_REFERENCE_SOURCE,
    groups: FOOTBALL_STAT_GROUPS,
    extension: 'htm',
    aliasOverrides: REVIEWED_CATALOG_ALIAS_OVERRIDES,
    productIdentityOverrides: REVIEWED_PRODUCT_IDENTITY_OVERRIDES,
    productCatalogCorrections: REVIEWED_PRODUCT_CATALOG_CORRECTIONS,
    productIdentityExclusions: REVIEWED_PRODUCT_IDENTITY_EXCLUSIONS,
    teamCodeNames: NFL_TEAM_CODE_NAMES,
    teamContextNames: NFL_CARD_CONTEXT_TEAMS,
  }),
});

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
    sports: ['mlb', 'nfl'],
    productsPath: 'products.json',
    cacheRoot: 'outputs/sports-reference-history/cache',
    reportPath: 'outputs/pro-sports-product-mapping-coverage.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--sport=')) {
      const sport = argument.slice('--sport='.length).toLowerCase();
      if (!['mlb', 'nfl', 'both'].includes(sport)) throw new Error('--sport must be mlb, nfl, or both.');
      options.sports = sport === 'both' ? ['mlb', 'nfl'] : [sport];
    } else if (argument.startsWith('--products=')) options.productsPath = argument.slice('--products='.length);
    else if (argument.startsWith('--cache-root=')) options.cacheRoot = argument.slice('--cache-root='.length);
    else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export function extractProviderIdentityObservations(html, { seasonYear, extension }) {
  const cellExpression = /<(?:th|td)\b(?=[^>]*\bdata-stat=["'](?:name_display|player)["'])[^>]*>([\s\S]*?)<\/(?:th|td)>/i;
  const playerExpression = new RegExp(
    `<a\\b[^>]*href=["'][^"']*/players/[a-z0-9]/([^/"']+)\\.${extension}["'][^>]*>([\\s\\S]*?)<\\/a>`,
    'i',
  );
  const teamNames = new Map();
  const teamLinkExpression = new RegExp(
    `<a\\b[^>]*href=["'][^"']*/teams/([a-z0-9]{2,8})/${Number(seasonYear)}\\.${extension}["'][^>]*>([\\s\\S]*?)<\\/a>`,
    'gi',
  );
  const teamLinkInCellExpression = new RegExp(
    `<a\\b[^>]*href=["'][^"']*/teams/([a-z0-9]{2,8})/${Number(seasonYear)}\\.${extension}["'][^>]*>([\\s\\S]*?)<\\/a>`,
    'i',
  );
  for (const match of String(html).matchAll(teamLinkExpression)) {
    const teamCode = String(match[1] || '').trim().toUpperCase();
    const teamName = stripHtml(match[2]);
    if (teamCode && teamName && teamName.toUpperCase() !== teamCode) teamNames.set(teamCode, teamName);
  }
  const observations = new Map();
  let duplicateLinkCount = 0;
  for (const rowMatch of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const playerCell = rowMatch[1].match(cellExpression)?.[1] || '';
    const match = playerCell.match(playerExpression);
    if (!match) continue;
    const externalId = String(match[1] || '').trim();
    const fullName = stripHtml(match[2]).replace(/\s*[\*#†‡+]+\s*$/u, '').trim();
    if (!externalId || !fullName) continue;
    const teamCell = rowMatch[1].match(
      /<(?:th|td)\b(?=[^>]*\bdata-stat=["'](?:team_name_abbr|team_id|team)["'])[^>]*>([\s\S]*?)<\/(?:th|td)>/i,
    )?.[1] || '';
    const linkedTeam = teamCell.match(teamLinkInCellExpression);
    const teamText = stripHtml(teamCell);
    const teamCode = String(linkedTeam?.[1] || teamText).trim().toUpperCase();
    const teamName = teamNames.get(teamCode) || (teamText.toUpperCase() !== teamCode ? teamText : '');
    const key = `${externalId}\u0000${fullName}\u0000${teamCode}`;
    if (observations.has(key)) duplicateLinkCount += 1;
    else observations.set(key, { externalId, fullName, seasonYear, teamCode, teamName });
  }
  return { rows: [...observations.values()], duplicateLinkCount };
}

async function readProviderCache(cacheRoot, sport, config) {
  const sportRoot = path.join(cacheRoot, sport);
  const seasonEntries = (await fs.readdir(sportRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
  const providerRows = [];
  const files = [];
  let duplicateLinkCount = 0;
  for (const seasonEntry of seasonEntries) {
    const seasonYear = Number(seasonEntry.name);
    for (const statGroup of config.groups) {
      const cacheFile = path.join(sportRoot, seasonEntry.name, `${statGroup}.html`);
      try {
        const html = await fs.readFile(cacheFile, 'utf8');
        // Mapping coverage needs stable provider identities, not every stat
        // cell. Extracting linked player IDs directly avoids reparsing hundreds
        // of megabytes of full statistics tables on each reconciliation run.
        const parsed = extractProviderIdentityObservations(html, {
          seasonYear,
          extension: config.extension,
        });
        duplicateLinkCount += parsed.duplicateLinkCount;
        providerRows.push(...parsed.rows);
        files.push({ seasonYear, statGroup, rowCount: parsed.rows.length });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  const seasons = [...new Set(files.map((file) => file.seasonYear))].sort((left, right) => left - right);
  const completeSeasonCount = seasons.filter((seasonYear) => (
    config.groups.every((statGroup) => files.some((file) => file.seasonYear === seasonYear && file.statGroup === statGroup))
  )).length;
  return {
    providerRows,
    evidence: {
      cacheFileCount: files.length,
      providerRowCount: providerRows.length,
      duplicateLinkCount,
      firstSeason: seasons[0] ?? null,
      lastSeason: seasons.at(-1) ?? null,
      observedSeasonCount: seasons.length,
      completeSeasonCount,
      requiredStatGroups: config.groups,
      completeAcrossObservedRange: completeSeasonCount === seasons.length,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const productsPath = workspacePath(options.productsPath, 'Products path');
  const cacheRoot = workspacePath(options.cacheRoot, 'Cache root');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const products = JSON.parse(await fs.readFile(productsPath, 'utf8'));
  if (!Array.isArray(products)) throw new Error('Products source must be a JSON array.');
  const sports = {};
  for (const sport of options.sports) {
    const config = SPORT_CONFIGS[sport];
    const cache = await readProviderCache(cacheRoot, sport, config);
    sports[sport] = {
      cacheEvidence: cache.evidence,
      ...buildProSportsCatalogMappingCoverage({ products, providerRows: cache.providerRows, config }),
    };
  }
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'local_read_only_proposal',
    productsPath: path.relative(ROOT, productsPath).replace(/\\/g, '/'),
    cacheRoot: path.relative(ROOT, cacheRoot).replace(/\\/g, '/'),
    catalogProductCount: products.length,
    sports,
    publicationBoundary: {
      databaseWritesPerformed: false,
      workbookWritesPerformed: false,
      generatedCatalogWritesPerformed: false,
      requiresPrivateIdentityPreflight: true,
      providerExternalIdsAreNotCommerceAthleteIds: true,
    },
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    catalogProductCount: report.catalogProductCount,
    sports: Object.fromEntries(Object.entries(sports).map(([sport, result]) => [sport, {
      providerIdentityCount: result.providerIdentityCount,
      eligibleProductCount: result.eligibleProductCount,
      sourceBackedCandidateProductCount: result.sourceBackedCandidateProductCount,
      sourceBackedCandidateMappingRowCount: result.sourceBackedCandidateMappingRowCount,
      dispositionCounts: result.dispositionCounts,
      cacheEvidence: result.cacheEvidence,
    }])),
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
