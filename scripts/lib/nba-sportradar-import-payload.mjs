import crypto from 'node:crypto';

export const SPORTRADAR_INGEST_METHOD_VERSION = 'sportradar_pbp_lineups_v1';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_POSSESSION_SOURCES = new Set([
  'provider_post_event_state',
  'inferred_staging_only',
  'inferred_period_opening_made_field_goal',
]);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function assertUuid(value, label) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new TypeError(`${label} must be a UUID.`);
  return id;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function noUndefined(value) {
  if (Array.isArray(value)) return value.map(noUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key, noUndefined(child)]));
}

function mergeTeam(target, candidate) {
  if (!candidate?.id) return;
  const id = assertUuid(candidate.id, 'provider team ID');
  const current = target.get(id) ?? { id };
  target.set(id, {
    ...current,
    id,
    srId: text(candidate.srId) || current.srId || '',
    reference: text(candidate.reference) || current.reference || '',
    alias: text(candidate.alias) || current.alias || '',
    market: text(candidate.market) || current.market || '',
    name: text(candidate.name) || current.name || '',
    country: text(candidate.country) || current.country || '',
  });
}

function mergePlayer(target, candidate) {
  if (!candidate?.id) return;
  const id = assertUuid(candidate.id, 'provider player ID');
  const current = target.get(id) ?? { id };
  target.set(id, {
    ...current,
    id,
    srId: text(candidate.srId) || current.srId || '',
    reference: text(candidate.reference) || current.reference || '',
    fullName: text(candidate.fullName) || current.fullName || '',
    firstName: text(candidate.firstName) || current.firstName || '',
    lastName: text(candidate.lastName) || current.lastName || '',
    position: text(candidate.position) || current.position || '',
    jerseyNumber: text(candidate.jerseyNumber) || current.jerseyNumber || '',
  });
}

function normalizedDocument(document, label) {
  assertObject(document, label);
  const resource = text(document.resource);
  if (!['schedule', 'summary', 'play_by_play', 'daily_changes'].includes(resource)) {
    throw new RangeError(`${label}.resource is unsupported.`);
  }
  const sha = text(document.contentSha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new TypeError(`${label}.contentSha256 must be a SHA-256 hash.`);
  const bytes = Number(document.contentBytes);
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError(`${label}.contentBytes must be positive.`);
  const encoding = text(document.contentEncoding) || 'gzip';
  if (!['gzip', 'identity'].includes(encoding)) throw new RangeError(`${label}.contentEncoding is unsupported.`);
  const sourceUrl = text(document.sourceUrl);
  if (!sourceUrl) throw new TypeError(`${label}.sourceUrl is required.`);
  const storageObjectPath = text(document.storageObjectPath);
  if (!storageObjectPath) throw new TypeError(`${label}.storageObjectPath is required.`);
  return noUndefined({
    id: assertUuid(document.id, `${label}.id`),
    resource,
    resourceKey: text(document.resourceKey) || resource,
    sourceUrl,
    storageBucket: text(document.storageBucket) || 'nba-sportradar-raw',
    storageObjectPath,
    contentSha256: sha,
    contentBytes: bytes,
    contentEncoding: encoding,
    sourceEtag: text(document.sourceEtag),
    sourceLastModified: text(document.sourceLastModified),
    sourceGeneratedAt: document.sourceGeneratedAt || null,
    receivedAt: document.receivedAt || null,
  });
}

function prepareAnalytics(analytics, pbp) {
  const source = assertObject(analytics, 'analytics');
  const build = assertObject(source.build, 'analytics.build');
  const methodVersion = text(build.methodVersion) || SPORTRADAR_INGEST_METHOD_VERSION;
  const inputSha256 = text(build.inputSha256) || sha256({
    methodVersion,
    events: pbp.events.map((event) => ({
      id: event.id,
      eventSequence: event.eventSequence,
      homePointsAfter: event.homePointsAfter,
      awayPointsAfter: event.awayPointsAfter,
      onCourt: event.onCourt,
    })),
  });
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) throw new TypeError('analytics.build.inputSha256 must be a SHA-256 hash.');
  const possessions = Array.isArray(source.possessions) ? source.possessions : [];
  return noUndefined({
    ...source,
    build: {
      ...build,
      methodVersion,
      inputSha256,
      eventCount: Number.isInteger(build.eventCount) ? build.eventCount : pbp.events.length,
      validSnapshotCount: Number.isInteger(build.validSnapshotCount)
        ? build.validSnapshotCount
        : pbp.validSnapshotCount,
      invalidSnapshotCount: Number.isInteger(build.invalidSnapshotCount)
        ? build.invalidSnapshotCount
        : pbp.invalidSnapshotCount,
    },
    lineups: Array.isArray(source.lineups) ? source.lineups : [],
    stints: Array.isArray(source.stints) ? source.stints : [],
    possessions: possessions.map((possession, index) => {
      const normalized = assertObject(possession, `analytics.possessions[${index}]`);
      const possessionSource = text(normalized.possessionSource) || 'provider_post_event_state';
      if (!SUPPORTED_POSSESSION_SOURCES.has(possessionSource)) {
        throw new RangeError(`analytics.possessions[${index}].possessionSource is unsupported.`);
      }
      return noUndefined({ ...normalized, possessionSource });
    }),
  });
}

/**
 * Turn provider-normalized Schedule, Summary, PBP, and derived lineup facts
 * into the single JSON shape consumed by the private ingest RPC. No name-based
 * identity merge occurs: every player key remains the provider UUID.
 */
export function buildSportradarIngestPayload({
  run,
  scheduleGame,
  summary,
  playByPlay,
  documents,
  analytics,
} = {}) {
  assertObject(run, 'run');
  assertObject(scheduleGame, 'scheduleGame');
  assertObject(summary, 'summary');
  assertObject(playByPlay, 'playByPlay');
  const gameId = assertUuid(scheduleGame.id, 'scheduleGame.id');
  if (assertUuid(summary.gameId, 'summary.gameId') !== gameId
    || assertUuid(playByPlay.gameId, 'playByPlay.gameId') !== gameId) {
    throw new Error('Schedule, summary, and PBP must describe the same game ID.');
  }
  if (!Array.isArray(documents) || !documents.length) throw new TypeError('documents must be a non-empty array.');
  const normalizedDocuments = documents.map((document, index) => normalizedDocument(document, `documents[${index}]`));
  const summaryDocument = normalizedDocuments.find((document) => document.resource === 'summary');
  const pbpDocument = normalizedDocuments.find((document) => document.resource === 'play_by_play');
  if (!summaryDocument || !pbpDocument) throw new Error('Both summary and play_by_play source documents are required.');

  const providerTeams = new Map();
  mergeTeam(providerTeams, scheduleGame.home);
  mergeTeam(providerTeams, scheduleGame.away);
  mergeTeam(providerTeams, summary.home);
  mergeTeam(providerTeams, summary.away);
  const homeProviderTeamId = assertUuid(summary.home.id, 'summary.home.id');
  const awayProviderTeamId = assertUuid(summary.away.id, 'summary.away.id');
  if (homeProviderTeamId !== assertUuid(scheduleGame.home.id, 'scheduleGame.home.id')
    || awayProviderTeamId !== assertUuid(scheduleGame.away.id, 'scheduleGame.away.id')) {
    throw new Error('Schedule and summary home/away provider teams must match.');
  }

  const providerPlayers = new Map();
  for (const player of summary.players ?? []) mergePlayer(providerPlayers, player);
  for (const event of playByPlay.events ?? []) {
    for (const playerId of [...(event.onCourt?.homePlayerIds ?? []), ...(event.onCourt?.awayPlayerIds ?? [])]) {
      mergePlayer(providerPlayers, { id: playerId });
    }
  }

  const normalizedAnalytics = prepareAnalytics(analytics, playByPlay);
  return noUndefined({
    run: {
      id: assertUuid(run.id, 'run.id'),
      accessLevel: text(run.accessLevel),
      apiVersion: text(run.apiVersion) || 'v8',
      licenseReference: text(run.licenseReference),
      rightsConfirmed: run.rightsConfirmed === true,
      requestedSeasonStart: Number(run.requestedSeasonStart),
      requestedSeasonEnd: Number(run.requestedSeasonEnd),
      requestedPhase: text(run.requestedPhase),
      startedAt: run.startedAt || null,
    },
    game: {
      id: gameId,
      reference: summary.reference || scheduleGame.reference || '',
      srId: summary.srId || scheduleGame.srId || '',
      seasonStartYear: scheduleGame.seasonStartYear,
      seasonEndYear: scheduleGame.seasonEndYear,
      seasonPhase: scheduleGame.seasonPhase,
      scheduledAt: summary.scheduledAt || scheduleGame.scheduledAt || null,
      status: summary.status,
      coverage: summary.coverage || scheduleGame.coverage || '',
      trackOnCourt: summary.trackOnCourt === true && scheduleGame.trackOnCourt === true,
      homeProviderTeamId,
      awayProviderTeamId,
      homePoints: summary.home.points ?? scheduleGame.homePoints ?? null,
      awayPoints: summary.away.points ?? scheduleGame.awayPoints ?? null,
      providerUpdatedAt: summary.providerUpdatedAt || playByPlay.providerUpdatedAt || scheduleGame.providerUpdatedAt || null,
      sourceEtag: pbpDocument.sourceEtag,
      sourceLastModified: pbpDocument.sourceLastModified,
    },
    providerTeams: [...providerTeams.values()].sort((left, right) => left.id.localeCompare(right.id)),
    providerPlayers: [...providerPlayers.values()].sort((left, right) => left.id.localeCompare(right.id)),
    documents: normalizedDocuments,
    playByPlayDocumentId: pbpDocument.id,
    gameTeamStats: (summary.teams ?? []).map((team) => noUndefined({
      providerTeamId: team.id,
      possessions: team.possessions,
      opponentPossessions: team.opponentPossessions,
      offensiveRating: team.offensiveRating,
      defensiveRating: team.defensiveRating,
      points: team.points,
      pointsAgainst: team.pointsAgainst,
      fastBreakPoints: team.fastBreakPoints,
      sourceDocumentId: summaryDocument.id,
    })),
    gamePlayerStats: (summary.players ?? []).map((player) => noUndefined({
      providerPlayerId: player.id,
      providerTeamId: player.providerTeamId,
      minutesPlayed: player.minutesPlayed,
      plusMinus: player.plusMinus,
      offensiveRating: player.offensiveRating,
      defensiveRating: player.defensiveRating,
      isStarter: player.isStarter,
      isActive: player.isActive,
      isOnCourt: player.isOnCourt,
      sourceDocumentId: summaryDocument.id,
    })),
    events: (playByPlay.events ?? []).map((event) => noUndefined({
      id: event.id,
      periodSequence: event.periodSequence,
      periodNumber: event.periodNumber,
      periodType: event.periodType,
      eventNumber: event.eventNumber,
      eventSequence: event.eventSequence,
      clockRemainingMs: event.clockRemainingMs,
      homePointsAfter: event.homePointsAfter,
      awayPointsAfter: event.awayPointsAfter,
      eventType: event.eventType,
      attributionTeamId: event.attributionTeamId,
      possessionTeamId: event.possessionTeamId,
      qualifiers: event.qualifiers,
      statistics: event.statistics,
      location: event.location,
      createdAt: event.createdByProviderAt,
      updatedAt: event.updatedByProviderAt,
      wallClockAt: event.wallClockAt,
      isRescinded: event.isRescinded === true,
      snapshot: {
        homePlayerIds: event.onCourt?.homePlayerIds ?? [],
        awayPlayerIds: event.onCourt?.awayPlayerIds ?? [],
        status: event.onCourt?.snapshotStatus ?? 'missing',
      },
    })),
    deletedEventIds: (playByPlay.deletedEvents ?? []).map((event) => event.id),
    analytics: normalizedAnalytics,
  });
}
