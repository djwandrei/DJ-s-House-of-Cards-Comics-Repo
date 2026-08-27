/**
 * Pure helpers for the resumable Basketball Reference player-position import.
 *
 * A season stats table has one `Pos` value, while a Basketball Reference
 * player profile can list several actual career positions. These helpers keep
 * that profile evidence auditable and deliberately do not infer a position
 * from a player's size, scoring profile, or any other statistical proxy.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  BASKETBALL_REFERENCE_SOURCE,
  basketballReferencePlayerPageUrl,
} from './nba-basketball-reference.mjs';

export const POSITION_PROFILE_SOURCE_SCOPE = 'career_profile';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_PATTERN = /^[a-z0-9]{2,24}$/;
const ELIGIBLE_POSITION_CODES = Object.freeze(new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']));
const TERMINAL_FETCH_STATUSES = Object.freeze(new Set(['found', 'no_positions', 'not_found']));

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function normalizedPositionCodes(values) {
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const position = String(value ?? '').trim().toUpperCase();
    if (ELIGIBLE_POSITION_CODES.has(position)) seen.add(position);
  }
  return [...seen];
}

function boundedText(value, maximumLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

function profileHash({ sourcePositionText, eligiblePositions }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ sourcePositionText, eligiblePositions }))
    .digest('hex');
}

export function normalizePositionProfileExternalId(value) {
  const externalId = String(value ?? '').trim().toLowerCase();
  return EXTERNAL_ID_PATTERN.test(externalId) ? externalId : '';
}

export function positionProfileCacheFile(root, externalId) {
  const normalizedExternalId = normalizePositionProfileExternalId(externalId);
  if (!normalizedExternalId) throw new Error('A safe Basketball Reference external ID is required for a profile cache path.');
  return path.join(root, 'outputs', 'nba-basketball-reference-cache', 'position-profiles', `${normalizedExternalId}.html`);
}

/**
 * Build the read-only candidate query. The remote profile table itself is the
 * durable checkpoint: found, no-position, and not-found pages are terminal;
 * only missing or retry rows are revisited by normal scheduled runs.
 */
export function buildPositionProfileCandidateQuery({ limit = 100, includeTerminal = false } = {}) {
  const safeLimit = Number(limit);
  if (!Number.isInteger(safeLimit) || safeLimit < 1 || safeLimit > 500) {
    throw new Error('Position-profile candidate limit must be an integer from 1 through 500.');
  }
  const pendingFilter = includeTerminal
    ? ''
    : `\nwhere profile.player_id is null or profile.fetch_status = 'retry'`;
  return `
with imported_players as (
  select distinct on (external_ids.player_id)
    external_ids.player_id::text as player_id,
    lower(external_ids.external_id) as external_id,
    max(stats.season_end_year) over (partition by external_ids.player_id) as latest_season_end_year
  from public.nba_player_external_ids as external_ids
  join public.nba_player_team_season_stats as stats
    on stats.player_id = external_ids.player_id
  where external_ids.source_name = ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)}
    and lower(external_ids.external_id) ~ '^[a-z0-9]{2,24}$'
  order by external_ids.player_id, stats.season_end_year desc, external_ids.external_id
), candidates as (
  select
    imported_players.player_id,
    imported_players.external_id,
    imported_players.latest_season_end_year,
    profile.fetch_status as prior_status
  from imported_players
  left join public.nba_player_position_profiles as profile
    on profile.player_id::text = imported_players.player_id
   and profile.source_name = ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)}
   and profile.source_scope = ${sqlLiteral(POSITION_PROFILE_SOURCE_SCOPE)}${pendingFilter}
)
select player_id, external_id, latest_season_end_year, prior_status
from candidates
order by latest_season_end_year desc nulls last, external_id
limit ${safeLimit};
`;
}

/** Normalize linked-query output before it can determine a remote URL. */
export function normalizePositionProfileCandidateRows(rows) {
  const candidates = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const playerId = String(row?.player_id ?? '').trim().toLowerCase();
    const externalId = normalizePositionProfileExternalId(row?.external_id);
    if (!UUID_PATTERN.test(playerId) || !externalId) continue;
    const latestSeasonEndYear = Number(row?.latest_season_end_year);
    const priorStatus = String(row?.prior_status ?? '').trim().toLowerCase();
    const candidate = {
      playerId,
      externalId,
      latestSeasonEndYear: Number.isInteger(latestSeasonEndYear) ? latestSeasonEndYear : null,
      priorStatus: TERMINAL_FETCH_STATUSES.has(priorStatus) || priorStatus === 'retry' ? priorStatus : '',
    };
    // One external ID should map to one player. Keeping the first row makes a
    // malformed duplicate safe instead of issuing two profile requests.
    if (!candidates.has(candidate.externalId)) candidates.set(candidate.externalId, candidate);
  }
  return [...candidates.values()].sort((left, right) => (
    (right.latestSeasonEndYear ?? 0) - (left.latestSeasonEndYear ?? 0)
    || left.externalId.localeCompare(right.externalId)
  ));
}

export function positionProfileRecordFromParsed({ candidate, profile }) {
  const playerId = String(candidate?.playerId ?? '').trim().toLowerCase();
  const externalId = normalizePositionProfileExternalId(candidate?.externalId);
  if (!UUID_PATTERN.test(playerId) || !externalId) throw new Error('A valid player profile candidate is required.');
  const eligiblePositions = normalizedPositionCodes(profile?.positions);
  const sourcePositionText = boundedText(profile?.positionText, 500);
  const sourceUrl = basketballReferencePlayerPageUrl(externalId);
  const fetchStatus = eligiblePositions.length ? 'found' : 'no_positions';
  return {
    playerId,
    externalId,
    sourceUrl,
    sourcePositionText,
    eligiblePositions,
    fetchStatus,
    sourceHash: profileHash({ sourcePositionText, eligiblePositions }),
    lastError: '',
  };
}

export function positionProfileFailureRecord({ candidate, error }) {
  const playerId = String(candidate?.playerId ?? '').trim().toLowerCase();
  const externalId = normalizePositionProfileExternalId(candidate?.externalId);
  if (!UUID_PATTERN.test(playerId) || !externalId) throw new Error('A valid player profile candidate is required.');
  const status = Number(error?.status);
  const fetchStatus = status === 404 || status === 410 ? 'not_found' : 'retry';
  return {
    playerId,
    externalId,
    sourceUrl: basketballReferencePlayerPageUrl(externalId),
    sourcePositionText: '',
    eligiblePositions: [],
    fetchStatus,
    sourceHash: '',
    lastError: boundedText(error?.message ?? error, 1200),
  };
}

function normalizedWriteRecord(record) {
  const playerId = String(record?.playerId ?? '').trim().toLowerCase();
  const externalId = normalizePositionProfileExternalId(record?.externalId);
  const fetchStatus = String(record?.fetchStatus ?? '').trim().toLowerCase();
  const eligiblePositions = normalizedPositionCodes(record?.eligiblePositions);
  if (!UUID_PATTERN.test(playerId) || !externalId) throw new Error('Position-profile writes require valid player and external IDs.');
  if (!['found', 'no_positions', 'not_found', 'retry'].includes(fetchStatus)) {
    throw new Error('Position-profile writes require a supported fetch status.');
  }
  if ((fetchStatus === 'found') !== (eligiblePositions.length > 0)) {
    throw new Error('Found position profiles require positions; all other statuses require none.');
  }
  return {
    playerId,
    sourceUrl: basketballReferencePlayerPageUrl(externalId),
    sourcePositionText: boundedText(record?.sourcePositionText, 500),
    eligiblePositions,
    fetchStatus,
    sourceHash: boundedText(record?.sourceHash, 128),
    lastError: boundedText(record?.lastError, 1200),
  };
}

/** Build one idempotent, transaction-safe batch upsert for fetched profiles. */
export function buildPositionProfileUpsertSql(records) {
  const normalizedRecords = (Array.isArray(records) ? records : []).map(normalizedWriteRecord);
  if (!normalizedRecords.length) throw new Error('At least one position-profile record is required for an upsert.');
  const values = normalizedRecords.map((record) => {
    const positions = record.eligiblePositions.length
      ? `array[${record.eligiblePositions.map(sqlLiteral).join(', ')}]::text[]`
      : "'{}'::text[]";
    return `(
  ${sqlLiteral(record.playerId)}::uuid,
  ${sqlLiteral(BASKETBALL_REFERENCE_SOURCE)},
  ${sqlLiteral(POSITION_PROFILE_SOURCE_SCOPE)},
  ${sqlLiteral(record.sourceUrl)},
  ${sqlLiteral(record.sourcePositionText)},
  ${positions},
  ${sqlLiteral(record.fetchStatus)},
  ${sqlLiteral(record.sourceHash)},
  now(),
  ${sqlLiteral(record.lastError)}
)`;
  }).join(',\n');
  return `
insert into public.nba_player_position_profiles (
  player_id,
  source_name,
  source_scope,
  source_url,
  source_position_text,
  eligible_positions,
  fetch_status,
  source_hash,
  source_fetched_at,
  last_error
)
values
${values}
on conflict (player_id, source_name, source_scope) do update
set
  source_url = excluded.source_url,
  source_position_text = excluded.source_position_text,
  eligible_positions = excluded.eligible_positions,
  fetch_status = excluded.fetch_status,
  source_hash = excluded.source_hash,
  source_fetched_at = excluded.source_fetched_at,
  last_error = excluded.last_error,
  updated_at = now();
`;
}
