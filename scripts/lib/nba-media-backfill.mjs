/**
 * Pure helpers for the Basketball Reference media backfill.
 *
 * Keeping candidate selection, URL validation, checkpoint transitions, and
 * request accounting here makes the safety-critical behavior unit-testable
 * without contacting Basketball Reference or the linked Supabase project.
 */

// This must match BASKETBALL_REFERENCE_SOURCE in nba-basketball-reference.mjs
// because it is the database identifier, not the human-readable label.
const SOURCE_NAME = 'basketball_reference';
const PLAYER_HOST = 'www.basketball-reference.com';
const TEAM_ASSET_HOST = 'cdn.ssref.net';
const VALID_PHASES = new Set(['regular', 'playoffs']);
const TERMINAL_CANDIDATE_STATUSES = new Set(['found', 'no-image']);

function sqlLiteral(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function normalizeWhitespace(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeExternalId(value) {
  const externalId = String(value ?? '').trim().toLowerCase();
  return /^[a-z0-9]{2,24}$/.test(externalId) ? externalId : '';
}

function normalizeTeamCode(value) {
  const teamCode = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(teamCode) ? teamCode : '';
}

function normalizeSeasonEndYear(value) {
  const seasonEndYear = Number(value);
  return Number.isInteger(seasonEndYear) && seasonEndYear >= 1947 && seasonEndYear <= 2200
    ? seasonEndYear
    : null;
}

function readBoolean(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function hasSafeUrlShape(url, expectedHost) {
  return url.protocol === 'https:'
    && url.hostname === expectedHost
    && url.port === ''
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === '';
}

function parseUrl(value) {
  try {
    return new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
}

/**
 * Produce a concise, deterministic alt string from source/database names.
 * Markup, control characters, provider footnote marks, and repeated suffixes
 * are removed before the human-readable media description is appended.
 */
export function normalizedMediaAltText(subjectType, rawName, fallbackCode = '') {
  const suffix = subjectType === 'player' ? 'headshot' : 'logo';
  const cleanedName = normalizeWhitespace(rawName)
    .replace(/[\*†‡]+$/u, '')
    .replace(/\s+(?:headshot|team logo|logo)$/i, '')
    .trim();
  const cleanedFallback = normalizeWhitespace(fallbackCode);
  const subjectName = (cleanedName || cleanedFallback || (subjectType === 'player' ? 'NBA player' : 'NBA team'))
    .slice(0, 120)
    .trim();
  return `${subjectName} ${suffix}`;
}

export function mediaCandidateKey(candidate) {
  if (candidate?.subjectType === 'player') return `player:${candidate.externalId}`;
  return `team:${candidate?.seasonEndYear}:${candidate?.teamCode}`;
}

/**
 * Normalize linked-query rows and de-duplicate them defensively. The SQL query
 * already emits one player across all selected regular/playoff rows, but this
 * second boundary prevents accidental duplicate HTTP requests if that query is
 * ever changed or the CLI returns repeated rows.
 */
export function normalizeMediaCandidateRows(rows) {
  const candidatesByKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const subjectType = String(row?.subject_type ?? '').trim().toLowerCase();
    let candidate;
    if (subjectType === 'player') {
      const externalId = normalizeExternalId(row.external_id);
      if (!externalId) continue;
      candidate = {
        subjectType,
        externalId,
        fullName: normalizeWhitespace(row.full_name) || externalId,
        seasonEndYear: null,
        teamCode: '',
        teamName: '',
      };
    } else if (subjectType === 'team') {
      const seasonEndYear = normalizeSeasonEndYear(row.season_end_year);
      const teamCode = normalizeTeamCode(row.team_code);
      if (!seasonEndYear || !teamCode) continue;
      candidate = {
        subjectType,
        externalId: '',
        fullName: '',
        seasonEndYear,
        teamCode,
        teamName: normalizeWhitespace(row.team_name) || teamCode,
      };
    } else {
      continue;
    }
    candidate.existingAssetUrl = String(row.existing_asset_url ?? '').trim();
    candidate.existingRightsConfirmed = readBoolean(row.existing_rights_confirmed);
    candidate.existingSourceName = String(row.existing_source_name ?? '').trim();
    candidate.existingSourceUrl = String(row.existing_source_url ?? '').trim();
    candidate.key = mediaCandidateKey(candidate);
    if (!candidatesByKey.has(candidate.key)) candidatesByKey.set(candidate.key, candidate);
  }
  return [...candidatesByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Build one read-only linked query for the entire requested range. Players are
 * selected with DISTINCT ON external ID, so regular-season rows, playoff rows,
 * multi-team aggregates, and traded-team stints cannot trigger repeat profile
 * requests. Teams deliberately remain distinct by team-season ID because
 * historic marks can change between seasons.
 */
export function buildMediaCandidateQuery({ start, end, phases, teamCode = '' }) {
  const seasonStart = normalizeSeasonEndYear(start);
  const seasonEnd = normalizeSeasonEndYear(end);
  if (!seasonStart || !seasonEnd || seasonEnd < seasonStart) throw new Error('Invalid media candidate season range.');
  const normalizedPhases = [...new Set((Array.isArray(phases) ? phases : []).map((phase) => String(phase).toLowerCase()))];
  if (!normalizedPhases.length || normalizedPhases.some((phase) => !VALID_PHASES.has(phase))) {
    throw new Error('Media candidates require regular and/or playoffs phases.');
  }
  const normalizedTeamCode = teamCode ? normalizeTeamCode(teamCode) : '';
  if (teamCode && !normalizedTeamCode) throw new Error('Invalid media candidate team code.');
  const phaseSql = normalizedPhases.map(sqlLiteral).join(', ');
  const teamFilter = normalizedTeamCode ? `\n    and stats.team_code = ${sqlLiteral(normalizedTeamCode)}` : '';

  return `
with scoped_stats as (
  select
    stats.player_id,
    stats.season_end_year,
    stats.season_phase,
    stats.team_season_id,
    stats.team_code,
    stats.is_multi_team_aggregate
  from public.nba_player_team_season_stats as stats
  where stats.season_end_year between ${seasonStart} and ${seasonEnd}
    and stats.season_phase in (${phaseSql})${teamFilter}
), player_candidates as (
  select distinct on (external_ids.external_id)
    'player'::text as subject_type,
    external_ids.external_id,
    players.full_name,
    null::smallint as season_end_year,
    null::text as team_code,
    null::text as team_name,
    players.id as player_id,
    null::uuid as team_season_id,
    'headshot'::text as asset_kind
  from scoped_stats
  join public.nba_player_external_ids as external_ids
    on external_ids.player_id = scoped_stats.player_id
   and external_ids.source_name = ${sqlLiteral(SOURCE_NAME)}
  join public.nba_players as players on players.id = scoped_stats.player_id
  order by external_ids.external_id, scoped_stats.season_end_year desc
), team_candidates as (
  select distinct
    'team'::text as subject_type,
    null::text as external_id,
    null::text as full_name,
    team_seasons.season_end_year,
    team_seasons.team_code,
    team_seasons.team_name,
    null::uuid as player_id,
    team_seasons.id as team_season_id,
    'team_logo'::text as asset_kind
  from scoped_stats
  join public.nba_team_seasons as team_seasons
    on team_seasons.id = scoped_stats.team_season_id
  where not scoped_stats.is_multi_team_aggregate
), candidates as (
  select * from player_candidates
  union all
  select * from team_candidates
)
select
  candidates.subject_type,
  candidates.external_id,
  candidates.full_name,
  candidates.season_end_year,
  candidates.team_code,
  candidates.team_name,
  existing_media.asset_url as existing_asset_url,
  existing_media.rights_confirmed as existing_rights_confirmed,
  existing_media.source_name as existing_source_name,
  existing_media.source_url as existing_source_url
from candidates
left join lateral (
  select media.asset_url, media.rights_confirmed, media.source_name, media.source_url
  from public.nba_media_assets as media
  where media.is_primary
    and media.rights_confirmed
    and media.asset_kind = candidates.asset_kind
    and (
      (candidates.subject_type = 'player' and media.player_id = candidates.player_id)
      or (candidates.subject_type = 'team' and media.team_season_id = candidates.team_season_id)
    )
  order by media.updated_at desc, media.id
  limit 1
) as existing_media on true
order by candidates.subject_type, candidates.external_id nulls last,
  candidates.season_end_year, candidates.team_code;
`;
}

/**
 * Fail closed on media URLs. A hostname suffix check is insufficient because
 * attacker-controlled hosts such as basketball-reference.com.example.test
 * would pass it. These rules require the exact provider host and exact,
 * subject-specific pathname with no credentials, port, query, or fragment.
 */
export function validatedBasketballReferenceMediaUrl(candidate, rawAssetUrl) {
  const url = parseUrl(rawAssetUrl);
  if (!url) return '';
  if (candidate?.subjectType === 'player') {
    const externalId = normalizeExternalId(candidate.externalId);
    if (!externalId || !hasSafeUrlShape(url, PLAYER_HOST)) return '';
    const expectedPath = new RegExp(`^/req/[A-Za-z0-9._-]+/images/headshots/${externalId}\\.jpg$`, 'i');
    return expectedPath.test(url.pathname) ? url.href : '';
  }
  if (candidate?.subjectType === 'team') {
    const teamCode = normalizeTeamCode(candidate.teamCode);
    const seasonEndYear = normalizeSeasonEndYear(candidate.seasonEndYear);
    if (!teamCode || !seasonEndYear || !hasSafeUrlShape(url, TEAM_ASSET_HOST)) return '';
    const expectedPath = new RegExp(`^/req/[A-Za-z0-9._-]+/tlogo/bbr/${teamCode}-${seasonEndYear}\\.png$`, 'i');
    return expectedPath.test(url.pathname) ? url.href : '';
  }
  return '';
}

export function hasConfirmedExistingMedia(candidate) {
  if (!candidate?.existingRightsConfirmed || !candidate.existingAssetUrl) return false;
  // A rights-confirmed primary from another provider belongs to that provider:
  // it is sufficient coverage and must never be replaced by this importer.
  // Basketball Reference-owned rows additionally need to pass the exact URL
  // rules so stale or malformed provider URLs can be repaired safely.
  if (candidate.existingSourceName !== SOURCE_NAME) return true;
  return Boolean(validatedBasketballReferenceMediaUrl(candidate, candidate.existingAssetUrl));
}

export function basketballReferenceMediaPageUrl(candidate) {
  if (candidate?.subjectType === 'player') {
    const externalId = normalizeExternalId(candidate.externalId);
    return externalId ? `https://${PLAYER_HOST}/players/${externalId[0]}/${externalId}.html` : '';
  }
  if (candidate?.subjectType === 'team') {
    const teamCode = normalizeTeamCode(candidate.teamCode);
    const seasonEndYear = normalizeSeasonEndYear(candidate.seasonEndYear);
    return teamCode && seasonEndYear ? `https://${PLAYER_HOST}/teams/${teamCode}/${seasonEndYear}.html` : '';
  }
  return '';
}

export function isExactBasketballReferenceMediaPageUrl(candidate, rawUrl) {
  const expected = basketballReferenceMediaPageUrl(candidate);
  const url = parseUrl(rawUrl);
  return Boolean(expected && url && hasSafeUrlShape(url, PLAYER_HOST) && url.href === expected);
}

/**
 * Player profile pages do not vary by requested season, so their cache key is
 * global. Team logo pages remain keyed by team code and season because the
 * provider intentionally serves era-specific artwork.
 */
export function mediaCacheRelativePath(candidate) {
  if (candidate?.subjectType === 'player') {
    const externalId = normalizeExternalId(candidate.externalId);
    if (!externalId) throw new Error('Cannot cache an invalid player candidate.');
    return `media/player/${externalId}.html`;
  }
  const teamCode = normalizeTeamCode(candidate?.teamCode);
  const seasonEndYear = normalizeSeasonEndYear(candidate?.seasonEndYear);
  if (!teamCode || !seasonEndYear) throw new Error('Cannot cache an invalid team-season candidate.');
  return `media/team/${seasonEndYear}-${teamCode}.html`;
}

export class MediaRequestLimitReachedError extends Error {
  constructor(limit) {
    super(`The media HTTP request limit (${limit}) was reached.`);
    this.name = 'MediaRequestLimitReachedError';
    this.code = 'MEDIA_REQUEST_LIMIT_REACHED';
    this.limit = limit;
  }
}

/** Count actual fetch attempts—not candidates and not successful assets. */
export function createMediaRequestBudget(limit) {
  const normalizedLimit = Number(limit);
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    throw new Error('The media HTTP request limit must be a positive integer.');
  }
  let used = 0;
  return Object.freeze({
    consume() {
      if (used >= normalizedLimit) throw new MediaRequestLimitReachedError(normalizedLimit);
      used += 1;
      return used;
    },
    snapshot() {
      return { limit: normalizedLimit, used, remaining: Math.max(0, normalizedLimit - used) };
    }
  });
}

export function blankMediaCheckpoint({ start, end, phases, teamCode = '' }) {
  const now = new Date().toISOString();
  return {
    version: 1,
    sourceName: SOURCE_NAME,
    seasonStart: Number(start),
    seasonEnd: Number(end),
    phases: [...phases],
    teamCode: normalizeTeamCode(teamCode),
    status: 'running',
    candidates: {},
    createdAt: now,
    updatedAt: now,
  };
}

export function isMatchingMediaCheckpoint(checkpoint, options) {
  return Boolean(checkpoint
    && checkpoint.version === 1
    && checkpoint.sourceName === SOURCE_NAME
    && checkpoint.seasonStart === Number(options.start)
    && checkpoint.seasonEnd === Number(options.end)
    && JSON.stringify(checkpoint.phases) === JSON.stringify(options.phases)
    && checkpoint.teamCode === normalizeTeamCode(options.teamCode)
    && checkpoint.candidates
    && typeof checkpoint.candidates === 'object');
}

export function shouldAttemptMediaCandidate(checkpoint, candidate) {
  const status = checkpoint?.candidates?.[mediaCandidateKey(candidate)]?.status;
  return !TERMINAL_CANDIDATE_STATUSES.has(status);
}

export function recordMediaCandidateStatus(checkpoint, candidate, status, details = {}) {
  if (!['found', 'no-image', 'retry'].includes(status)) throw new Error(`Invalid media checkpoint status: ${status}`);
  const key = mediaCandidateKey(candidate);
  const previous = checkpoint.candidates[key] ?? {};
  const metadata = { ...details };
  const attempted = metadata.attempted !== false;
  delete metadata.attempted;
  delete metadata.status;
  delete metadata.attempts;
  delete metadata.updatedAt;
  checkpoint.candidates[key] = {
    ...metadata,
    status,
    attempts: Number(previous.attempts ?? 0) + (attempted ? 1 : 0),
    updatedAt: new Date().toISOString(),
  };
  checkpoint.updatedAt = new Date().toISOString();
  return checkpoint.candidates[key];
}
