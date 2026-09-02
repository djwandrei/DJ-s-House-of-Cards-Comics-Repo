import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabaseApiHeaders } from './build-nba-product-player-mappings.mjs';
import {
  normalizeCatalogPlayerName,
  splitCatalogPlayerNames,
} from './lib/nba-product-player-mapping.mjs';

const ROOT = process.cwd();
const MINIMUM_PARITY_SAMPLE = 10;
const GENERATIONAL_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

function isIntentionalTeamLot(status) {
  const team = String(status?.team || '').trim();
  const productName = String(status?.productName || '').toLowerCase();
  return Boolean(team)
    && /\b(?:base|sp|insert)\s*\+\s*(?:sp\s*\+\s*)?insert\s+lot\b/.test(productName)
    && /\(x\d+\)/.test(productName);
}

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

function configValue(configText, name) {
  return configText.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1] || '';
}

export function optionsFromArgs(argv = []) {
  const options = {
    liveStatusPath: 'outputs/nba-product-mapping-live-status-all.json',
    reportPath: 'outputs/nba-product-mapping-analytics-candidates.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--live-status=')) {
      options.liveStatusPath = argument.slice('--live-status='.length);
    } else if (argument.startsWith('--report=')) {
      options.reportPath = argument.slice('--report='.length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

export function foldIdentityName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .replace(/[’'`.]/g, '')
    .replace(/[-_/]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function analyticsIdentityIndexes(rows = []) {
  const exact = new Map();
  const folded = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const playerId = String(row?.player_id || '').trim();
    const playerName = String(row?.player_name || '').trim();
    const normalizedName = normalizeCatalogPlayerName(playerName);
    if (!playerId || !normalizedName) continue;
    const exactCandidates = exact.get(normalizedName) || new Map();
    exactCandidates.set(playerId, playerName);
    exact.set(normalizedName, exactCandidates);
    const foldedName = foldIdentityName(playerName);
    const foldedCandidates = folded.get(foldedName) || new Map();
    foldedCandidates.set(playerId, playerName);
    folded.set(foldedName, foldedCandidates);
  }
  return { exact, folded };
}

function mapCandidates(candidates) {
  return [...(candidates?.entries() || [])]
    .map(([playerId, playerName]) => ({ playerId, playerName }))
    .sort((left, right) => left.playerId.localeCompare(right.playerId));
}

function resolveIdentityCandidates(indexes, sourceText) {
  const exactCandidates = mapCandidates(
    indexes.exact.get(normalizeCatalogPlayerName(sourceText))
  );
  if (exactCandidates.length) {
    return { matchMethod: 'exact_public_name', candidates: exactCandidates };
  }
  return {
    matchMethod: 'diacritic_punctuation_fold',
    candidates: mapCandidates(indexes.folded.get(foldIdentityName(sourceText))),
  };
}

function levenshteinDistance(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= a.length; leftIndex += 1) {
    let previousDiagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= b.length; rightIndex += 1) {
      const previousAbove = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        previousDiagonal + (a[leftIndex - 1] === b[rightIndex - 1] ? 0 : 1)
      );
      previousDiagonal = previousAbove;
    }
  }
  return row[b.length];
}

function withoutGenerationalSuffix(value) {
  const tokens = foldIdentityName(value).split(' ').filter(Boolean);
  const hasSuffix = tokens.length > 1 && GENERATIONAL_SUFFIXES.has(tokens[tokens.length - 1]);
  return {
    hasSuffix,
    tokens: hasSuffix ? tokens.slice(0, -1) : tokens,
  };
}

function likelyIdentityCandidates(indexes, sourceText) {
  const source = withoutGenerationalSuffix(sourceText);
  if (source.hasSuffix) {
    const suffixCandidates = mapCandidates(indexes.folded.get(source.tokens.join(' ')));
    if (suffixCandidates.length) {
      return { reviewMethod: 'generational_suffix_removed', candidates: suffixCandidates };
    }
  }

  const suggestions = new Map();
  for (const [foldedName, candidates] of indexes.folded.entries()) {
    const candidate = withoutGenerationalSuffix(foldedName);
    if (source.tokens.length !== candidate.tokens.length || source.tokens.length < 2) continue;
    if (source.tokens.slice(1).join(' ') !== candidate.tokens.slice(1).join(' ')) continue;
    if (levenshteinDistance(source.tokens[0], candidate.tokens[0]) !== 1) continue;
    for (const [playerId, playerName] of candidates.entries()) {
      suggestions.set(playerId, playerName);
    }
  }
  return {
    reviewMethod: suggestions.size ? 'single_character_first_name' : '',
    candidates: mapCandidates(suggestions),
  };
}

export function assessCrossProjectIdentityParity(liveStatuses = [], analyticsRows = []) {
  const indexes = analyticsIdentityIndexes(analyticsRows);
  const checked = [];
  const mismatches = [];
  for (const status of Array.isArray(liveStatuses) ? liveStatuses : []) {
    if (status?.status !== 'mapped') continue;
    for (const mapping of Array.isArray(status?.mappings) ? status.mappings : []) {
      const resolution = resolveIdentityCandidates(indexes, mapping?.name);
      if (resolution.candidates.length !== 1) continue;
      const analyticsPlayerId = resolution.candidates[0].playerId;
      const comparison = {
        productId: Number(status.productId),
        playerName: String(mapping?.name || ''),
        analyticsPlayerId,
        nbaPlayerId: String(mapping?.nbaPlayerId || ''),
        athleteId: String(mapping?.athleteId || ''),
      };
      checked.push(comparison);
      if (analyticsPlayerId !== comparison.nbaPlayerId
        || analyticsPlayerId !== comparison.athleteId) {
        mismatches.push(comparison);
      }
    }
  }
  return {
    minimumRequiredSample: MINIMUM_PARITY_SAMPLE,
    checkedMappingCount: checked.length,
    mismatchCount: mismatches.length,
    safeForCandidateIds: checked.length >= MINIMUM_PARITY_SAMPLE && mismatches.length === 0,
    mismatches,
  };
}

export function buildAnalyticsIdentityCandidateQueue(liveStatuses = [], analyticsRows = []) {
  const indexes = analyticsIdentityIndexes(analyticsRows);
  const parity = assessCrossProjectIdentityParity(liveStatuses, analyticsRows);
  const queue = [];
  for (const status of Array.isArray(liveStatuses) ? liveStatuses : []) {
    if (status?.status !== 'empty') continue;
    const subjects = splitCatalogPlayerNames(status?.sourcePlayerText);
    if (!subjects.length) {
      const intentionalTeamLot = isIntentionalTeamLot(status);
      queue.push({
        productId: Number(status?.productId),
        productName: String(status?.productName || ''),
        sourcePlayerText: '',
        team: String(status?.team || ''),
        currentValues: {
          playerAthlete: '',
          team: String(status?.team || ''),
          publicMappingStatus: 'empty',
        },
        confidence: intentionalTeamLot ? 'high' : 'none',
        source: 'public_nba_analytics_player_pool',
        disposition: intentionalTeamLot ? 'intentionally_blank_team_lot' : 'missing_player_text',
        nextAction: intentionalTeamLot
          ? 'no_player_mapping_required'
          : 'fill_player_attribute_before_identity_review',
        proposed: null,
        evidence: [],
      });
      continue;
    }
    const evidence = subjects.map((sourceText, indexValue) => {
      const resolution = resolveIdentityCandidates(indexes, sourceText);
      const reviewResolution = resolution.candidates.length
        ? { reviewMethod: '', candidates: [] }
        : likelyIdentityCandidates(indexes, sourceText);
      return {
        subjectOrder: indexValue + 1,
        sourceText,
        normalizedName: normalizeCatalogPlayerName(sourceText),
        foldedName: foldIdentityName(sourceText),
        matchMethod: resolution.matchMethod,
        candidates: resolution.candidates,
        reviewMethod: reviewResolution.reviewMethod,
        reviewCandidates: reviewResolution.candidates,
      };
    });
    const hasAmbiguous = evidence.some((subject) => subject.candidates.length > 1);
    const hasUnseen = evidence.some((subject) => subject.candidates.length === 0);
    const resolvedIds = evidence
      .filter((subject) => subject.candidates.length === 1)
      .map((subject) => subject.candidates[0].playerId);
    const repeatedAthlete = new Set(resolvedIds).size !== resolvedIds.length;
    const exactComplete = !hasAmbiguous && !hasUnseen && !repeatedAthlete;
    const likelyIds = evidence
      .map((subject) => subject.candidates.length === 1
        ? subject.candidates[0].playerId
        : (subject.reviewCandidates.length === 1 ? subject.reviewCandidates[0].playerId : ''));
    const likelyComplete = !exactComplete
      && likelyIds.every(Boolean)
      && new Set(likelyIds).size === likelyIds.length;
    const exactPublicNames = exactComplete
      && evidence.every((subject) => subject.matchMethod === 'exact_public_name');
    const disposition = exactComplete
      ? (parity.safeForCandidateIds
        ? (exactPublicNames
          ? 'analytics_exact_identity_candidate'
          : 'analytics_normalized_identity_candidate')
        : 'identity_namespace_unverified')
      : (likelyComplete
        ? 'likely_identity_review_candidate'
        : (hasAmbiguous
          ? 'ambiguous_analytics_name'
          : (repeatedAthlete ? 'duplicate_athlete_subject' : 'unseen_analytics_name')));
    const nextAction = exactComplete && parity.safeForCandidateIds
      ? 'verify_commerce_alias_then_create_mapping'
      : (likelyComplete
        ? 'manually_verify_identity_then_alias'
        : (hasAmbiguous
          ? 'resolve_identity_ambiguity'
          : 'research_identity_or_correct_catalog_attribute'));
    queue.push({
      productId: Number(status?.productId),
      productName: String(status?.productName || ''),
      sourcePlayerText: String(status?.sourcePlayerText || ''),
      team: String(status?.team || ''),
      currentValues: {
        playerAthlete: String(status?.sourcePlayerText || ''),
        team: String(status?.team || ''),
        publicMappingStatus: 'empty',
      },
      confidence: exactComplete && parity.safeForCandidateIds
        ? 'high_review_candidate'
        : (likelyComplete ? 'medium_review_candidate' : 'none'),
      source: 'public_nba_analytics_player_pool',
      disposition,
      nextAction,
      proposed: exactComplete && parity.safeForCandidateIds
        ? evidence.map((subject) => ({
          subjectOrder: subject.subjectOrder,
          athleteId: subject.candidates[0].playerId,
          sourcePlayerText: subject.sourceText,
        }))
        : null,
      suggested: likelyComplete
        ? evidence.map((subject) => ({
          subjectOrder: subject.subjectOrder,
          athleteId: subject.candidates.length === 1
            ? subject.candidates[0].playerId
            : subject.reviewCandidates[0].playerId,
          sourcePlayerText: subject.sourceText,
          reviewMethod: subject.candidates.length === 1
            ? subject.matchMethod
            : subject.reviewMethod,
        }))
        : null,
      evidence,
    });
  }
  return { parity, queue };
}

async function fetchAllAnalyticsPlayers(projectUrl, publishableKey) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      select: 'player_id,player_name,season_end_year,season_phase,team_code',
      order: 'player_id.asc,season_end_year.asc,season_phase.asc,team_code.asc',
      limit: '1000',
      offset: String(offset),
    });
    const response = await fetch(`${projectUrl}/rest/v1/nba_lineup_player_pool?${query}`, {
      headers: supabaseApiHeaders(publishableKey),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Analytics player read failed: ${response.status} ${responseText.slice(0, 500)}`);
    }
    const page = responseText ? JSON.parse(responseText) : [];
    if (!Array.isArray(page)) throw new Error('Analytics player view did not return a row array.');
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const liveStatusPath = workspacePath(options.liveStatusPath, 'Live status path');
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const [configText, liveStatus] = await Promise.all([
    fs.readFile(path.join(ROOT, 'backend-config.js'), 'utf8'),
    fs.readFile(liveStatusPath, 'utf8').then(JSON.parse),
  ]);
  const projectUrl = configValue(configText, 'analyticsSupabaseUrl').replace(/\/+$/, '');
  const publishableKey = configValue(configText, 'analyticsSupabasePublishableKey');
  if (!projectUrl || !publishableKey) {
    throw new Error('backend-config.js must contain the browser-safe analytics URL and publishable key.');
  }
  const analyticsRows = await fetchAllAnalyticsPlayers(projectUrl, publishableKey);
  const result = buildAnalyticsIdentityCandidateQueue(liveStatus?.statuses, analyticsRows);
  const dispositionCounts = result.queue.reduce((counts, item) => {
    counts[item.disposition] = (counts[item.disposition] || 0) + 1;
    return counts;
  }, {});
  const uniqueAnalyticsPlayers = new Set(analyticsRows.map((row) => String(row.player_id || ''))).size;
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'public_read_only_review_queue',
    policy: 'exact-catalog-player-text-to-public-analytics-identity',
    liveStatusPath: path.relative(ROOT, liveStatusPath).replace(/\\/g, '/'),
    analyticsRowCount: analyticsRows.length,
    uniqueAnalyticsPlayerCount: uniqueAnalyticsPlayers,
    reviewedEmptyProductCount: result.queue.length,
    dispositionCounts,
    ...result,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    analyticsRowCount: report.analyticsRowCount,
    uniqueAnalyticsPlayerCount: report.uniqueAnalyticsPlayerCount,
    reviewedEmptyProductCount: report.reviewedEmptyProductCount,
    dispositionCounts,
    parity: report.parity,
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
