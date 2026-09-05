/**
 * Credential-safe, dependency-free helpers for Sportradar's NBA v8 REST feed.
 *
 * This module intentionally does not read environment variables or make a
 * request when it is imported.  Callers must supply an API key explicitly to
 * `fetchSportradarNbaJson`; the key is sent only to api.sportradar.com and is
 * never placed in a URL, an error message, or a returned object.
 *
 * The normalizers are conservative.  A malformed structural record raises an
 * error instead of being silently coerced into a source of five-player
 * analytics.  Incomplete on-court snapshots are retained as an auditable
 * event state, but are never labeled valid five-on-five.
 */

export const SPORTRADAR_NBA_SOURCE = 'sportradar_nba';
export const SPORTRADAR_NBA_API_VERSION = 'v8';
export const SPORTRADAR_NBA_API_HOST = 'api.sportradar.com';

export const SPORTRADAR_NBA_PHASE_CODES = Object.freeze({
  preseason: 'PRE',
  regular: 'REG',
  in_season_tournament: 'IST',
  play_in: 'PIT',
  playoffs: 'PST'
});

const ACCESS_LEVELS = new Set(['trial', 'production']);
const GAME_STATUSES = new Set([
  'scheduled',
  'created',
  'inprogress',
  'halftime',
  'complete',
  'closed',
  'cancelled',
  'postponed'
]);
// The provider exposes a few scheduling-only states that are intentionally
// not analytics-eligible and do not have a one-to-one local status column.
// Keep their original value in `providerStatus`, while giving the persistence
// layer a conservative compatible state.
const GAME_STATUS_STORAGE_MAP = Object.freeze({
  scheduled: 'scheduled',
  created: 'created',
  inprogress: 'inprogress',
  halftime: 'halftime',
  complete: 'complete',
  closed: 'closed',
  cancelled: 'cancelled',
  postponed: 'postponed',
  delayed: 'scheduled',
  timetbd: 'scheduled',
  ifnecessary: 'scheduled',
  unnecessary: 'cancelled'
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class SportradarNbaError extends Error {
  constructor(message, {
    code = 'SPORTRADAR_NBA_ERROR',
    status = null,
    retryable = false,
    providerLimit = null,
    retryAfterMs = null,
    cause,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SportradarNbaError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.providerLimit = providerLimit;
    this.retryAfterMs = retryAfterMs;
  }
}

export class SportradarNbaNormalizationError extends SportradarNbaError {
  constructor(message, options = {}) {
    super(message, { ...options, code: options.code ?? 'SPORTRADAR_NBA_INVALID_PAYLOAD' });
    this.name = 'SportradarNbaNormalizationError';
  }
}

function fail(message, code = 'SPORTRADAR_NBA_INVALID_PAYLOAD') {
  throw new SportradarNbaNormalizationError(message, { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonEmptyText(value, label) {
  const normalized = text(value);
  if (!normalized) fail(`${label} must be a non-empty string.`);
  return normalized;
}

function optionalText(value) {
  return text(value);
}

function normalizedUuid(value) {
  const candidate = text(value).toLowerCase();
  return UUID_PATTERN.test(candidate) ? candidate : '';
}

function requireUuid(value, label) {
  const id = normalizedUuid(value);
  if (!id) fail(`${label} must be a UUID.`);
  return id;
}

function optionalProviderId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return requireUuid(value, label);
}

function optionalFiniteNumber(value, label, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const candidate = typeof value === 'number'
    ? value
    : (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(String(value).trim()) ? Number(value) : Number.NaN);
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    fail(`${label} must be a finite number in the supported range.`);
  }
  return candidate;
}

function optionalInteger(value, label, { minimum = -Infinity, maximum = Infinity } = {}) {
  const candidate = optionalFiniteNumber(value, label, { minimum, maximum });
  if (candidate === null) return null;
  if (!Number.isSafeInteger(candidate)) fail(`${label} must be a safe integer.`);
  return candidate;
}

function optionalTimestamp(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const raw = text(value);
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be an ISO-compatible timestamp.`);
  return new Date(milliseconds).toISOString();
}

function optionalBoolean(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === false) return value;
  const normalized = text(value).toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  fail(`${label} must be a boolean.`);
}

function requiredPositiveInteger(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = optionalInteger(value, label, { minimum, maximum });
  if (normalized === null) fail(`${label} is required.`);
  return normalized;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function normalizeAccessLevel(value = 'production') {
  const accessLevel = text(value).toLowerCase();
  if (!ACCESS_LEVELS.has(accessLevel)) {
    throw new SportradarNbaError('Sportradar access level must be "trial" or "production".', {
      code: 'SPORTRADAR_NBA_INVALID_ACCESS_LEVEL'
    });
  }
  return accessLevel;
}

function normalizeLanguage(value = 'en') {
  const language = text(value);
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)) {
    throw new SportradarNbaError('Sportradar language must be a safe ISO language token.', {
      code: 'SPORTRADAR_NBA_INVALID_LANGUAGE'
    });
  }
  return language;
}

function normalizeSeasonStartYear(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1947 || year > 2200) {
    throw new SportradarNbaError('NBA season start year must be a supported integer.', {
      code: 'SPORTRADAR_NBA_INVALID_SEASON'
    });
  }
  return year;
}

function normalizeDateParts({ year, month, day }) {
  const normalizedYear = requiredPositiveInteger(year, 'date year', { minimum: 1947, maximum: 2200 });
  const normalizedMonth = requiredPositiveInteger(month, 'date month', { minimum: 1, maximum: 12 });
  const normalizedDay = requiredPositiveInteger(day, 'date day', { minimum: 1, maximum: 31 });
  const candidate = new Date(Date.UTC(normalizedYear, normalizedMonth - 1, normalizedDay));
  if (
    candidate.getUTCFullYear() !== normalizedYear
    || candidate.getUTCMonth() !== normalizedMonth - 1
    || candidate.getUTCDate() !== normalizedDay
  ) {
    throw new SportradarNbaError('Sportradar date must be a real calendar date.', {
      code: 'SPORTRADAR_NBA_INVALID_DATE'
    });
  }
  return {
    year: normalizedYear,
    month: String(normalizedMonth).padStart(2, '0'),
    day: String(normalizedDay).padStart(2, '0')
  };
}

function phaseCode(value) {
  const phase = text(value).toLowerCase();
  const code = SPORTRADAR_NBA_PHASE_CODES[phase];
  if (!code) {
    throw new SportradarNbaError('NBA season phase is not supported by the Sportradar NBA v8 schedule route.', {
      code: 'SPORTRADAR_NBA_INVALID_PHASE'
    });
  }
  return { phase, code };
}

function buildApiUrl(path, { accessLevel = 'production', language = 'en' } = {}) {
  const access = normalizeAccessLevel(accessLevel);
  const locale = normalizeLanguage(language);
  const safePath = String(path ?? '').replace(/^\/+/, '');
  if (!safePath || safePath.includes('..') || safePath.includes('?') || safePath.includes('#')) {
    throw new SportradarNbaError('Sportradar API path is invalid.', { code: 'SPORTRADAR_NBA_INVALID_PATH' });
  }
  return `https://${SPORTRADAR_NBA_API_HOST}/nba/${access}/${SPORTRADAR_NBA_API_VERSION}/${locale}/${safePath}`;
}

/** Build the documented NBA v8 season catalog URL. */
export function buildSportradarNbaSeasonsUrl(options = {}) {
  return buildApiUrl('league/seasons.json', options);
}

/** Build the documented NBA v8 season/phase schedule URL. */
export function buildSportradarNbaScheduleUrl({ seasonStartYear, seasonPhase, ...options } = {}) {
  const year = normalizeSeasonStartYear(seasonStartYear);
  const { code } = phaseCode(seasonPhase);
  return buildApiUrl(`games/${year}/${code}/schedule.json`, options);
}

/** Build the documented NBA v8 daily schedule URL. */
export function buildSportradarNbaDailyScheduleUrl({ year, month, day, ...options } = {}) {
  const date = normalizeDateParts({ year, month, day });
  return buildApiUrl(`games/${date.year}/${date.month}/${date.day}/schedule.json`, options);
}

/** Build the documented NBA v8 Game Summary URL. */
export function buildSportradarNbaSummaryUrl({ gameId, ...options } = {}) {
  return buildApiUrl(`games/${requireUuid(gameId, 'gameId')}/summary.json`, options);
}

/** Build the documented NBA v8 Play-by-Play URL. */
export function buildSportradarNbaPlayByPlayUrl({ gameId, ...options } = {}) {
  return buildApiUrl(`games/${requireUuid(gameId, 'gameId')}/pbp.json`, options);
}

/** Build the documented NBA v8 Daily Change Log URL. */
export function buildSportradarNbaDailyChangesUrl({ year, month, day, ...options } = {}) {
  const date = normalizeDateParts({ year, month, day });
  return buildApiUrl(`league/${date.year}/${date.month}/${date.day}/changes.json`, options);
}

/**
 * Return the only headers needed for an NBA v8 request.  API keys are passed
 * in a header rather than a query string so source URLs remain safe to store.
 */
export function createSportradarNbaHeaders(apiKey, extraHeaders = {}) {
  const key = text(apiKey);
  if (!key) {
    throw new SportradarNbaError('A non-empty Sportradar NBA API key is required to request provider data.', {
      code: 'SPORTRADAR_NBA_MISSING_API_KEY'
    });
  }
  if (!isPlainObject(extraHeaders)) {
    throw new SportradarNbaError('Extra headers must be an object.', {
      code: 'SPORTRADAR_NBA_INVALID_HEADERS'
    });
  }
  const headers = { Accept: 'application/json' };
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (String(name).toLowerCase() === 'x-api-key') continue;
    if (value !== undefined && value !== null) headers[name] = String(value);
  }
  headers['x-api-key'] = key;
  return Object.freeze(headers);
}

/** Parse a Retry-After value without making a request. */
export function retryAfterMilliseconds(value, now = Date.now()) {
  const raw = text(value);
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1000));
  const retryAt = Date.parse(raw);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
}

function assertSportradarApiUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new SportradarNbaError('Sportradar request URL is invalid.', { code: 'SPORTRADAR_NBA_INVALID_URL' });
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== SPORTRADAR_NBA_API_HOST
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !parsed.pathname.startsWith('/nba/')
  ) {
    throw new SportradarNbaError('Sportradar API key may only be sent to the documented NBA API origin.', {
      code: 'SPORTRADAR_NBA_UNSAFE_URL'
    });
  }
  return parsed.toString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedInteger(value, fallback, minimum, maximum, code) {
  const numeric = Number(value ?? fallback);
  if (!Number.isInteger(numeric) || numeric < minimum || numeric > maximum) {
    throw new SportradarNbaError(code, { code: 'SPORTRADAR_NBA_INVALID_REQUEST_OPTION' });
  }
  return numeric;
}

function retryableHttpStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function classifyProviderLimit(status, responseText) {
  if (status !== 429) return null;
  const text = String(responseText ?? '').toLowerCase();
  if (/\bquota\b[\s\S]{0,80}\b(exceed|exhaust|limit)/.test(text) || /\b(exceed|exhaust)\w*\b[\s\S]{0,80}\bquota\b/.test(text)) {
    return 'quota_exceeded';
  }
  if (/\bthrottl/.test(text) || /\brate[\s_-]*limit/.test(text)) return 'throttled';
  return 'rate_limited_unknown';
}

async function readProviderErrorText(response) {
  if (typeof response?.text !== 'function') return '';
  try {
    return String(await response.text()).slice(0, 4096);
  } catch {
    return '';
  }
}

/**
 * Fetch a JSON document from the official Sportradar NBA API.  The return
 * value deliberately includes ordinary HTTP provenance but never the key.
 * Tests may inject a fetch implementation and a sleep function; no network
 * call occurs until this function is explicitly invoked.
 */
export async function fetchSportradarNbaJson(url, {
  apiKey,
  fetchImpl = globalThis.fetch,
  maxAttempts = 3,
  requestDelayMs = 0,
  sleepImpl = sleep,
  signal,
  extraHeaders = {}
} = {}) {
  const sourceUrl = assertSportradarApiUrl(url);
  if (typeof fetchImpl !== 'function') {
    throw new SportradarNbaError('A fetch implementation is required for Sportradar requests.', {
      code: 'SPORTRADAR_NBA_MISSING_FETCH'
    });
  }
  if (typeof sleepImpl !== 'function') {
    throw new SportradarNbaError('A sleep implementation is required for retries.', {
      code: 'SPORTRADAR_NBA_INVALID_SLEEP'
    });
  }
  const attempts = boundedInteger(maxAttempts, 3, 1, 6, 'maxAttempts must be between 1 and 6.');
  const baseDelayMs = boundedInteger(requestDelayMs, 0, 0, 120000, 'requestDelayMs must be between 0 and 120000.');
  const headers = createSportradarNbaHeaders(apiKey, extraHeaders);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && baseDelayMs > 0) await sleepImpl(baseDelayMs);
    try {
      const response = await fetchImpl(sourceUrl, {
        method: 'GET',
        headers,
        signal
      });
      const status = Number(response?.status ?? 0);
      if (!response?.ok) {
        const retryable = retryableHttpStatus(status);
        const retryAfterMs = retryAfterMilliseconds(response?.headers?.get?.('retry-after'));
        if (retryable && attempt < attempts) {
          const retryDelay = Math.max(
            baseDelayMs,
            retryAfterMs,
            Math.min(120000, 1000 * (2 ** (attempt - 1)))
          );
          if (retryDelay > 0) await sleepImpl(retryDelay);
          continue;
        }
        const providerLimit = classifyProviderLimit(status, await readProviderErrorText(response));
        throw new SportradarNbaError(`Sportradar NBA request returned HTTP ${status || 'unknown'}.`, {
          code: 'SPORTRADAR_NBA_HTTP_ERROR',
          status: status || null,
          retryable,
          providerLimit,
          retryAfterMs,
        });
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new SportradarNbaError('Sportradar NBA response was not valid JSON.', {
          code: 'SPORTRADAR_NBA_INVALID_JSON',
          cause: error
        });
      }
      if (!isPlainObject(payload) && !Array.isArray(payload)) {
        throw new SportradarNbaError('Sportradar NBA JSON response must be an object or array.', {
          code: 'SPORTRADAR_NBA_INVALID_JSON'
        });
      }
      return {
        payload,
        sourceUrl,
        status,
        etag: text(response.headers?.get?.('etag')),
        lastModified: text(response.headers?.get?.('last-modified')),
        cacheControl: text(response.headers?.get?.('cache-control')),
        receivedAt: new Date().toISOString()
      };
    } catch (error) {
      lastError = error;
      if (error instanceof SportradarNbaError) {
        if (!error.retryable || attempt >= attempts) throw error;
      } else if (attempt >= attempts) {
        throw new SportradarNbaError('Sportradar NBA request failed before receiving a response.', {
          code: 'SPORTRADAR_NBA_NETWORK_ERROR',
          retryable: true,
          cause: error
        });
      }
      if (attempt < attempts) {
        const retryDelay = Math.max(baseDelayMs, Math.min(120000, 1000 * (2 ** (attempt - 1))));
        if (retryDelay > 0) await sleepImpl(retryDelay);
      }
    }
  }
  throw lastError ?? new SportradarNbaError('Sportradar NBA request failed.', { code: 'SPORTRADAR_NBA_REQUEST_FAILED' });
}

function providerGameStatus(value) {
  const raw = nonEmptyText(value, 'game status').toLowerCase();
  const statusKey = raw.replace(/[\s_-]+/g, '');
  if (!Object.hasOwn(GAME_STATUS_STORAGE_MAP, statusKey)) fail(`Unsupported Sportradar game status: ${raw}.`);
  return raw;
}

function normalizeGameStatus(value) {
  const providerStatus = providerGameStatus(value);
  const status = GAME_STATUS_STORAGE_MAP[providerStatus.replace(/[\s_-]+/g, '')];
  if (!GAME_STATUSES.has(status)) fail(`Unsupported normalized game status: ${status}.`);
  return status;
}

function normalizeProviderTeam(value, label) {
  const team = requireObject(value, label);
  return {
    id: requireUuid(team.id, `${label}.id`),
    srId: optionalText(team.sr_id ?? team.srId),
    reference: optionalText(team.reference),
    alias: optionalText(team.alias),
    market: optionalText(team.market),
    name: optionalText(team.name),
    country: optionalText(team.country)
  };
}

function readTeamId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return optionalProviderId(value, label);
  const record = requireObject(value, label);
  return optionalProviderId(record.id ?? record.team_id ?? record.teamId, `${label}.id`);
}

function arrayOrEmpty(value, label) {
  if (value === undefined || value === null) return [];
  return requireArray(value, label);
}

function objectOrEmpty(value, label) {
  if (value === undefined || value === null) return {};
  return requireObject(value, label);
}

function readSnapshotSide(onCourt, side) {
  if (!isPlainObject(onCourt) || !Object.hasOwn(onCourt, side)) {
    return { present: false, rawPlayers: [] };
  }
  const rawSide = onCourt[side];
  if (Array.isArray(rawSide)) return { present: true, rawPlayers: rawSide };
  if (isPlainObject(rawSide) && Array.isArray(rawSide.players)) return { present: true, rawPlayers: rawSide.players };
  return { present: true, rawPlayers: null };
}

function snapshotPlayerId(value) {
  if (typeof value === 'string') return normalizedUuid(value);
  if (!isPlainObject(value)) return '';
  return normalizedUuid(value.id ?? value.player_id ?? value.playerId ?? value.player?.id);
}

/**
 * Classify a provider on-court snapshot.  Only exactly five distinct UUIDs
 * per side, with no cross-team duplicate, can be valid five-on-five.
 */
export function normalizeOnCourtSnapshot(value) {
  const home = readSnapshotSide(value, 'home');
  const away = readSnapshotSide(value, 'away');
  if (!home.present && !away.present) {
    return { homePlayerIds: [], awayPlayerIds: [], snapshotStatus: 'missing' };
  }
  if (!home.present || !away.present || home.rawPlayers === null || away.rawPlayers === null) {
    return { homePlayerIds: [], awayPlayerIds: [], snapshotStatus: 'missing' };
  }

  const rawPlayers = { home: home.rawPlayers, away: away.rawPlayers };
  const resolved = {
    home: rawPlayers.home.map(snapshotPlayerId),
    away: rawPlayers.away.map(snapshotPlayerId)
  };
  const homePlayerIds = resolved.home.filter(Boolean);
  const awayPlayerIds = resolved.away.filter(Boolean);

  if (resolved.home.some((id) => !id) || resolved.away.some((id) => !id)) {
    return { homePlayerIds, awayPlayerIds, snapshotStatus: 'unresolved_player' };
  }
  if (rawPlayers.home.length !== 5 || rawPlayers.away.length !== 5) {
    return { homePlayerIds, awayPlayerIds, snapshotStatus: 'invalid_count' };
  }
  if (new Set(homePlayerIds).size !== homePlayerIds.length || new Set(awayPlayerIds).size !== awayPlayerIds.length) {
    return { homePlayerIds, awayPlayerIds, snapshotStatus: 'duplicate_player' };
  }
  if (homePlayerIds.some((id) => awayPlayerIds.includes(id))) {
    return { homePlayerIds, awayPlayerIds, snapshotStatus: 'cross_team_duplicate' };
  }
  return { homePlayerIds, awayPlayerIds, snapshotStatus: 'valid_five_on_five' };
}

/**
 * Convert Sportradar's `clock_decimal` (preferred) or `clock` notation into
 * milliseconds remaining in the period.  It accepts MM:SS(.sss),
 * HH:MM:SS(.sss), and a non-negative decimal seconds fallback.
 */
export function parseSportradarClockMilliseconds(clockDecimal, clock) {
  for (const input of [clockDecimal, clock]) {
    if (input === undefined || input === null || input === '') continue;
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0) return Math.round(input * 1000);
    const value = text(input);
    if (!value) continue;
    if (/^\d+(?:\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
    const match = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,9}))?$/);
    if (!match) continue;
    const hours = match[1] === undefined ? 0 : Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (minutes > 59 || seconds > 59) continue;
    const fractionalMs = Number(`0.${match[4] ?? ''}`) * 1000;
    return Math.round((((hours * 60) + minutes) * 60 + seconds) * 1000 + fractionalMs);
  }
  return null;
}

function normalizeEvent(value, period, eventIndex) {
  const event = requireObject(value, `period ${period.sequence} event ${eventIndex + 1}`);
  const eventId = requireUuid(event.id, `period ${period.sequence} event ${eventIndex + 1}.id`);
  const eventSequence = optionalInteger(event.sequence, `event ${eventId}.sequence`, { minimum: 0 });
  const eventNumber = optionalInteger(event.number, `event ${eventId}.number`, { minimum: 0 });
  const clockRemainingMs = parseSportradarClockMilliseconds(event.clock_decimal ?? event.clockDecimal, event.clock);
  const qualifiers = arrayOrEmpty(event.qualifiers, `event ${eventId}.qualifiers`);
  const statistics = arrayOrEmpty(event.statistics, `event ${eventId}.statistics`);
  const location = objectOrEmpty(event.location, `event ${eventId}.location`);
  const onCourt = normalizeOnCourtSnapshot(event.on_court ?? event.onCourt);
  return {
    id: eventId,
    periodSequence: period.sequence,
    periodNumber: period.number,
    periodType: period.type,
    eventNumber,
    eventSequence,
    clock: optionalText(event.clock),
    clockDecimal: optionalText(event.clock_decimal ?? event.clockDecimal),
    clockRemainingMs,
    homePointsAfter: optionalInteger(event.home_points ?? event.homePoints, `event ${eventId}.home_points`, { minimum: 0 }),
    awayPointsAfter: optionalInteger(event.away_points ?? event.awayPoints, `event ${eventId}.away_points`, { minimum: 0 }),
    eventType: optionalText(event.event_type ?? event.eventType ?? event.type),
    attempt: optionalText(event.attempt),
    attributionTeamId: readTeamId(event.attribution ?? event.attribution_team ?? event.attributionTeam, `event ${eventId}.attribution`),
    possessionTeamId: readTeamId(event.possession ?? event.possession_team ?? event.possessionTeam, `event ${eventId}.possession`),
    qualifiers,
    statistics,
    location,
    createdByProviderAt: optionalTimestamp(event.created ?? event.created_at ?? event.createdAt, `event ${eventId}.created`),
    updatedByProviderAt: optionalTimestamp(event.updated ?? event.updated_at ?? event.updatedAt, `event ${eventId}.updated`),
    wallClockAt: optionalTimestamp(event.wall_clock ?? event.wallClock, `event ${eventId}.wall_clock`),
    isRescinded: optionalBoolean(event.rescinded ?? event.is_rescinded ?? event.isRescinded ?? event.deleted, `event ${eventId}.rescinded`) ?? false,
    onCourt
  };
}

function normalizeDeletedEvent(value, index) {
  const event = requireObject(value, `deleted_events[${index}]`);
  const id = requireUuid(event.id ?? event.event_id ?? event.eventId, `deleted_events[${index}].id`);
  return {
    id,
    eventSequence: optionalInteger(event.sequence ?? event.event_sequence ?? event.eventSequence, `deleted_events[${index}].sequence`, { minimum: 0 }),
    deletedAt: optionalTimestamp(event.deleted_at ?? event.deletedAt ?? event.updated_at, `deleted_events[${index}].deleted_at`)
  };
}

/** Order PBP strictly by provider sequence, then period/number/ID for ties. */
export function compareSportradarPbpEvents(left, right) {
  const numeric = (value) => (Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER);
  return numeric(left?.eventSequence) - numeric(right?.eventSequence)
    || numeric(left?.periodSequence) - numeric(right?.periodSequence)
    || numeric(left?.eventNumber) - numeric(right?.eventNumber)
    || String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

export function sortSportradarPbpEvents(events) {
  return [...requireArray(events, 'events')].sort(compareSportradarPbpEvents);
}

function payloadGameId(payload, label) {
  const root = requireObject(payload, label);
  return requireUuid(root.id ?? root.game?.id ?? root.game_id, `${label}.id`);
}

function assertExpectedGameId(gameId, expectedGameId) {
  if (expectedGameId === undefined || expectedGameId === null || expectedGameId === '') return;
  if (gameId !== requireUuid(expectedGameId, 'expectedGameId')) {
    fail('Provider response game ID does not match the requested game ID.', 'SPORTRADAR_NBA_GAME_ID_MISMATCH');
  }
}

/**
 * Normalize a full NBA v8 PBP response.  Deleted events remain explicit and
 * matching live events are marked rescinded; callers can safely upsert that
 * state without inferring deletions from absent events.
 */
export function normalizeSportradarPlayByPlay(payload, { expectedGameId } = {}) {
  const root = requireObject(payload, 'play-by-play payload');
  const gameId = payloadGameId(root, 'play-by-play payload');
  assertExpectedGameId(gameId, expectedGameId);
  const periods = requireArray(root.periods, 'play-by-play payload.periods');
  const events = [];
  const normalizedPeriods = [];
  const periodSequences = new Set();

  for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
    const rawPeriod = requireObject(periods[periodIndex], `periods[${periodIndex}]`);
    const sequence = requiredPositiveInteger(rawPeriod.sequence ?? (periodIndex + 1), `periods[${periodIndex}].sequence`);
    const number = requiredPositiveInteger(rawPeriod.number ?? sequence, `periods[${periodIndex}].number`);
    if (periodSequences.has(sequence)) fail(`Duplicate period sequence ${sequence}.`);
    periodSequences.add(sequence);
    const period = { sequence, number, type: optionalText(rawPeriod.type ?? rawPeriod.period_type ?? rawPeriod.periodType) };
    const rawEvents = requireArray(rawPeriod.events, `periods[${periodIndex}].events`);
    normalizedPeriods.push({ ...period, eventCount: rawEvents.length });
    for (let eventIndex = 0; eventIndex < rawEvents.length; eventIndex += 1) {
      events.push(normalizeEvent(rawEvents[eventIndex], period, eventIndex));
    }
  }

  const duplicateEventIds = new Set();
  const seenEventIds = new Set();
  for (const event of events) {
    if (seenEventIds.has(event.id)) duplicateEventIds.add(event.id);
    seenEventIds.add(event.id);
  }
  if (duplicateEventIds.size) fail(`Duplicate PBP event ID ${[...duplicateEventIds][0]}.`);

  const rawDeletedEvents = arrayOrEmpty(root.deleted_events ?? root.deletedEvents, 'play-by-play payload.deleted_events');
  const deletedEvents = rawDeletedEvents.map(normalizeDeletedEvent);
  const deletedIds = new Set();
  for (const event of deletedEvents) {
    if (deletedIds.has(event.id)) fail(`Duplicate deleted event ID ${event.id}.`);
    deletedIds.add(event.id);
  }
  for (const event of events) {
    if (deletedIds.has(event.id)) event.isRescinded = true;
  }
  const sortedEvents = sortSportradarPbpEvents(events);

  return {
    source: SPORTRADAR_NBA_SOURCE,
    apiVersion: SPORTRADAR_NBA_API_VERSION,
    gameId,
    providerStatus: root.status === undefined || root.status === null || root.status === '' ? '' : providerGameStatus(root.status),
    status: root.status === undefined || root.status === null || root.status === '' ? '' : normalizeGameStatus(root.status),
    coverage: optionalText(root.coverage),
    trackOnCourt: optionalBoolean(root.track_on_court ?? root.trackOnCourt, 'play-by-play payload.track_on_court') ?? false,
    sourceGeneratedAt: optionalTimestamp(root.generated_at ?? root.generatedAt, 'play-by-play payload.generated_at'),
    providerUpdatedAt: optionalTimestamp(root.updated ?? root.updated_at ?? root.updatedAt, 'play-by-play payload.updated'),
    periods: normalizedPeriods,
    events: sortedEvents,
    deletedEvents,
    validSnapshotCount: sortedEvents.filter((event) => event.onCourt.snapshotStatus === 'valid_five_on_five').length,
    invalidSnapshotCount: sortedEvents.filter((event) => event.onCourt.snapshotStatus !== 'valid_five_on_five').length
  };
}

function statisticContainers(record) {
  const statistics = isPlainObject(record.statistics) ? record.statistics : {};
  return [
    record,
    statistics,
    isPlainObject(statistics.total) ? statistics.total : {},
    isPlainObject(record.totals) ? record.totals : {}
  ];
}

function unwrapStatistic(value) {
  if (isPlainObject(value)) return firstDefined(value.value, value.total, value.amount);
  return value;
}

function statisticValue(record, aliases) {
  for (const container of statisticContainers(record)) {
    for (const alias of aliases) {
      if (Object.hasOwn(container, alias)) return unwrapStatistic(container[alias]);
    }
  }
  return undefined;
}

function nullableStatisticNumber(record, aliases, label, bounds = {}) {
  return optionalFiniteNumber(statisticValue(record, aliases), label, bounds);
}

function nullableStatisticInteger(record, aliases, label, bounds = {}) {
  return optionalInteger(statisticValue(record, aliases), label, bounds);
}

/** Convert a provider minutes value (number or MM:SS) to decimal minutes. */
export function parseSportradarMinutes(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) fail('minutes must be a non-negative number.');
    return value;
  }
  const raw = text(value);
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const milliseconds = parseSportradarClockMilliseconds(raw, null);
  if (milliseconds === null) fail('minutes must be a number or MM:SS clock.');
  return milliseconds / 60000;
}

function nullableStatisticBoolean(record, aliases, label) {
  return optionalBoolean(statisticValue(record, aliases), label);
}

// The Summary endpoint is fetched separately from play-by-play and supplies
// the authoritative per-game box score.  Preserve a deliberately narrow,
// canonical subset that can later be reconciled against PBP-derived totals.
// Keeping the source label and the provider-present fields prevents absent
// statistics from being mistaken for zeroes during a backfill or validation.
const OFFICIAL_BOX_SCORE_FIELDS = [
  ['points', ['points']],
  ['fieldGoalsMade', ['field_goals_made', 'fieldGoalsMade']],
  ['fieldGoalAttempts', ['field_goals_att', 'field_goals_attempted', 'fieldGoalsAtt', 'fieldGoalsAttempted']],
  ['twoPointMakes', ['two_points_made', 'twoPointsMade']],
  ['twoPointAttempts', ['two_points_att', 'two_points_attempted', 'twoPointsAtt', 'twoPointsAttempted']],
  ['threePointersMade', ['three_points_made', 'threePointersMade']],
  ['threePointAttempts', ['three_points_att', 'three_points_attempted', 'threePointsAtt', 'threePointsAttempted']],
  ['freeThrowsMade', ['free_throws_made', 'freeThrowsMade']],
  ['freeThrowAttempts', ['free_throws_att', 'free_throws_attempted', 'freeThrowsAtt', 'freeThrowsAttempted']],
  ['offensiveRebounds', ['offensive_rebounds', 'offensiveRebounds']],
  ['defensiveRebounds', ['defensive_rebounds', 'defensiveRebounds']],
  ['rebounds', ['rebounds', 'total_rebounds', 'totalRebounds']],
  ['assists', ['assists']],
  ['steals', ['steals']],
  ['blocks', ['blocks']],
  ['turnovers', ['turnovers']],
  ['personalFouls', ['personal_fouls', 'personalFouls']],
];

function normalizeOfficialBoxScore(record, label) {
  const fields = {};
  const availableFields = [];
  for (const [field, aliases] of OFFICIAL_BOX_SCORE_FIELDS) {
    const raw = statisticValue(record, aliases);
    if (raw !== undefined && raw !== null && raw !== '') availableFields.push(field);
    fields[field] = nullableStatisticInteger(record, aliases, `${label}.${field}`, { minimum: 0 });
  }
  return {
    source: 'summary_endpoint',
    availableFields,
    fields,
  };
}

function normalizeSummaryPlayer(value, team, index) {
  const player = requireObject(value, `summary ${team.id} players[${index}]`);
  const id = requireUuid(player.id, `summary player ${index}.id`);
  const firstName = optionalText(player.first_name ?? player.firstName);
  const lastName = optionalText(player.last_name ?? player.lastName);
  const fullName = optionalText(player.full_name ?? player.fullName ?? player.name)
    || [firstName, lastName].filter(Boolean).join(' ');
  const minutesValue = statisticValue(player, ['minutes', 'minutes_played', 'minutesPlayed']);
  return {
    id,
    providerTeamId: team.id,
    srId: optionalText(player.sr_id ?? player.srId),
    reference: optionalText(player.reference),
    fullName,
    firstName,
    lastName,
    position: optionalText(player.position),
    jerseyNumber: optionalText(player.jersey_number ?? player.jerseyNumber),
    minutesPlayed: parseSportradarMinutes(minutesValue),
    plusMinus: nullableStatisticInteger(player, ['plus_minus', 'plusMinus'], `summary player ${id}.plus_minus`),
    offensiveRating: nullableStatisticNumber(player, ['offensive_rating', 'offensiveRating', 'off_rating'], `summary player ${id}.offensive_rating`),
    defensiveRating: nullableStatisticNumber(player, ['defensive_rating', 'defensiveRating', 'def_rating'], `summary player ${id}.defensive_rating`),
    isStarter: nullableStatisticBoolean(player, ['starter', 'is_starter', 'isStarter'], `summary player ${id}.starter`),
    isActive: nullableStatisticBoolean(player, ['active', 'is_active', 'isActive'], `summary player ${id}.active`),
    isOnCourt: nullableStatisticBoolean(player, ['on_court', 'is_on_court', 'isOnCourt'], `summary player ${id}.on_court`),
    officialBoxScore: normalizeOfficialBoxScore(player, `summary player ${id}.official_box_score`),
  };
}

function normalizeSummaryTeam(value, side, root) {
  const team = normalizeProviderTeam(value, `summary ${side}`);
  const opponent = side === 'home' ? root.away : root.home;
  const points = nullableStatisticInteger(value, ['points', 'score'], `summary ${side}.points`, { minimum: 0 })
    ?? optionalInteger(root[`${side}_points`], `summary ${side}_points`, { minimum: 0 });
  const opponentPoints = nullableStatisticInteger(opponent ?? {}, ['points', 'score'], `summary ${side} opponent points`, { minimum: 0 })
    ?? optionalInteger(root[side === 'home' ? 'away_points' : 'home_points'], `summary ${side} opponent points`, { minimum: 0 });
  const rawPlayers = value.players === undefined || value.players === null ? [] : requireArray(value.players, `summary ${side}.players`);
  return {
    ...team,
    possessions: nullableStatisticNumber(value, ['possessions'], `summary ${side}.possessions`, { minimum: 0 }),
    opponentPossessions: nullableStatisticNumber(value, ['opponent_possessions', 'opponentPossessions'], `summary ${side}.opponent_possessions`, { minimum: 0 }),
    offensiveRating: nullableStatisticNumber(value, ['offensive_rating', 'offensiveRating', 'off_rating'], `summary ${side}.offensive_rating`),
    defensiveRating: nullableStatisticNumber(value, ['defensive_rating', 'defensiveRating', 'def_rating'], `summary ${side}.defensive_rating`),
    points,
    pointsAgainst: opponentPoints,
    fastBreakPoints: nullableStatisticInteger(value, ['fast_break_points', 'fastbreak_points', 'fastBreakPoints'], `summary ${side}.fast_break_points`, { minimum: 0 }),
    players: rawPlayers.map((player, index) => normalizeSummaryPlayer(player, team, index))
  };
}

/**
 * Normalize the summary fields used for provider validation: team possessions
 * and ratings plus player minutes, plus-minus, and ratings.  This does not
 * invent any missing statistic; null remains null for later reconciliation.
 */
export function normalizeSportradarSummary(payload, { expectedGameId } = {}) {
  const root = requireObject(payload, 'summary payload');
  const gameId = payloadGameId(root, 'summary payload');
  assertExpectedGameId(gameId, expectedGameId);
  requireObject(root.home, 'summary payload.home');
  requireObject(root.away, 'summary payload.away');
  const home = normalizeSummaryTeam(root.home, 'home', root);
  const away = normalizeSummaryTeam(root.away, 'away', root);
  if (home.id === away.id) fail('Summary home and away team IDs must differ.');
  const players = [...home.players, ...away.players];
  const playerIds = new Set();
  for (const player of players) {
    if (playerIds.has(player.id)) fail(`Duplicate summary player ID ${player.id}.`);
    playerIds.add(player.id);
  }

  return {
    source: SPORTRADAR_NBA_SOURCE,
    apiVersion: SPORTRADAR_NBA_API_VERSION,
    gameId,
    reference: optionalText(root.reference),
    srId: optionalText(root.sr_id ?? root.srId),
    providerStatus: providerGameStatus(root.status),
    status: normalizeGameStatus(root.status),
    scheduledAt: optionalTimestamp(root.scheduled, 'summary payload.scheduled'),
    coverage: optionalText(root.coverage),
    trackOnCourt: optionalBoolean(root.track_on_court ?? root.trackOnCourt, 'summary payload.track_on_court') ?? false,
    providerUpdatedAt: optionalTimestamp(root.updated ?? root.updated_at ?? root.updatedAt, 'summary payload.updated'),
    sourceGeneratedAt: optionalTimestamp(root.generated_at ?? root.generatedAt, 'summary payload.generated_at'),
    home,
    away,
    teams: [home, away],
    players
  };
}

function normalizeScheduleGame(value, seasonStartYear, seasonPhase, index) {
  const game = requireObject(value, `schedule games[${index}]`);
  const id = requireUuid(game.id, `schedule games[${index}].id`);
  const home = normalizeProviderTeam(game.home, `schedule game ${id}.home`);
  const away = normalizeProviderTeam(game.away, `schedule game ${id}.away`);
  if (home.id === away.id) fail(`Schedule game ${id} has identical home and away teams.`);
  return {
    id,
    srId: optionalText(game.sr_id ?? game.srId),
    reference: optionalText(game.reference),
    seasonStartYear,
    seasonEndYear: seasonStartYear + 1,
    seasonPhase,
    scheduledAt: optionalTimestamp(game.scheduled, `schedule game ${id}.scheduled`),
    providerStatus: providerGameStatus(game.status),
    status: normalizeGameStatus(game.status),
    coverage: optionalText(game.coverage),
    trackOnCourt: optionalBoolean(game.track_on_court ?? game.trackOnCourt, `schedule game ${id}.track_on_court`) ?? false,
    home,
    away,
    homePoints: optionalInteger(game.home_points ?? game.home?.points, `schedule game ${id}.home_points`, { minimum: 0 }),
    awayPoints: optionalInteger(game.away_points ?? game.away?.points, `schedule game ${id}.away_points`, { minimum: 0 }),
    providerUpdatedAt: optionalTimestamp(game.updated ?? game.updated_at ?? game.updatedAt, `schedule game ${id}.updated`)
  };
}

/** Normalize a season/phase schedule and reject duplicate or malformed games. */
export function normalizeSportradarSchedule(payload, { seasonStartYear, seasonPhase } = {}) {
  const root = requireObject(payload, 'schedule payload');
  const startYear = normalizeSeasonStartYear(seasonStartYear);
  const { phase } = phaseCode(seasonPhase);
  const games = requireArray(root.games, 'schedule payload.games').map((game, index) => (
    normalizeScheduleGame(game, startYear, phase, index)
  ));
  const gameIds = new Set();
  for (const game of games) {
    if (gameIds.has(game.id)) fail(`Duplicate schedule game ID ${game.id}.`);
    gameIds.add(game.id);
  }
  return {
    source: SPORTRADAR_NBA_SOURCE,
    apiVersion: SPORTRADAR_NBA_API_VERSION,
    seasonStartYear: startYear,
    seasonEndYear: startYear + 1,
    seasonPhase: phase,
    sourceGeneratedAt: optionalTimestamp(root.generated_at ?? root.generatedAt, 'schedule payload.generated_at'),
    games
  };
}
