import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fitWeightedRidgeRapm, RAPM_MODEL_VERSION } from './lib/nba-rapm.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    archiveDir: null,
    seasonStartYear: 2025,
    outputDir: null,
    validationReport: null,
    rapmLambda: 100,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inline] = token.split(/=(.*)/s, 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--archive-dir') options.archiveDir = path.resolve(value);
    else if (name === '--season') options.seasonStartYear = Number.parseInt(value, 10);
    else if (name === '--output-dir') options.outputDir = path.resolve(value);
    else if (name === '--validation-report') options.validationReport = path.resolve(value);
    else if (name === '--rapm-lambda') options.rapmLambda = Number(value);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.archiveDir) throw new Error('--archive-dir is required.');
  if (!Number.isInteger(options.seasonStartYear) || options.seasonStartYear < 1947) throw new Error('--season must be a valid NBA season start year.');
  if (!Number.isFinite(options.rapmLambda) || options.rapmLambda <= 0) throw new Error('--rapm-lambda must be greater than zero.');
  if (!options.outputDir) options.outputDir = path.join(options.archiveDir, '..', 'scout-analytics', String(options.seasonStartYear));
  return options;
}

const OPTIONS = parseArgs(process.argv.slice(2));
const SEASON = String(OPTIONS.seasonStartYear);
const SEASON_DIR = path.join(OPTIONS.archiveDir, SEASON);
const GAMES_DIR = path.join(SEASON_DIR, 'games');
const MANIFEST_PATH = path.join(SEASON_DIR, 'manifest.json');
const VALIDATION_PATH = OPTIONS.validationReport
  || path.join(OPTIONS.archiveDir, '..', 'validation', 'rerun-20260831', 'checkpoint-validation-report.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sortedUnique(ids) {
  return [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id ?? '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function exactLineup(lineupId, lineups) {
  const ids = sortedUnique(lineups.get(lineupId)?.playerIds);
  return ids.length === 5 ? ids : null;
}

function playerName(id, players) {
  const player = players.get(id);
  return player?.fullName || player?.reference || id;
}

function teamName(team) {
  return team?.fullName || [team?.market, team?.name].filter(Boolean).join(' ') || team?.alias || team?.id || null;
}

function createAggregate() {
  return {
    games: 0,
    lastGameId: null,
    offensivePossessions: 0,
    defensivePossessions: 0,
    pointsFor: 0,
    pointsAgainst: 0,
  };
}

function addAggregate(aggregate, row) {
  if (aggregate.lastGameId !== row.gameId) {
    aggregate.games += 1;
    aggregate.lastGameId = row.gameId;
  }
  if (row.isOffense) {
    aggregate.offensivePossessions += 1;
    aggregate.pointsFor += row.pointsFor;
  } else {
    aggregate.defensivePossessions += 1;
    aggregate.pointsAgainst += row.pointsAgainst;
  }
}

function metric(aggregate) {
  const offensiveRating = aggregate.offensivePossessions > 0
    ? 100 * aggregate.pointsFor / aggregate.offensivePossessions
    : null;
  const defensiveRating = aggregate.defensivePossessions > 0
    ? 100 * aggregate.pointsAgainst / aggregate.defensivePossessions
    : null;
  return {
    games: aggregate.games,
    pointsFor: aggregate.pointsFor,
    pointsAgainst: aggregate.pointsAgainst,
    offensivePossessions: aggregate.offensivePossessions,
    defensivePossessions: aggregate.defensivePossessions,
    totalPossessions: aggregate.offensivePossessions + aggregate.defensivePossessions,
    offensiveRating: round(offensiveRating),
    defensiveRating: round(defensiveRating),
    netRating: offensiveRating === null || defensiveRating === null ? null : round(offensiveRating - defensiveRating),
    plusMinusPer100: aggregate.offensivePossessions + aggregate.defensivePossessions > 0
      ? round(200 * (aggregate.pointsFor - aggregate.pointsAgainst) / (aggregate.offensivePossessions + aggregate.defensivePossessions))
      : null,
  };
}

const CONTEXTS = ['all', 'clutch_v1', 'provider_fastbreak_v1', 'non_provider_fastbreak', 'unclassified'];

function contextMap() {
  return new Map(CONTEXTS.map((context) => [context, createAggregate()]));
}

function scoreStateForTeam(homeState, side) {
  const state = String(homeState ?? '').trim().toLowerCase();
  if (!state || state === 'unknown') return 'unclassified';
  if (side === 'home') return state;
  if (state === 'tied') return 'tied';
  if (state.startsWith('ahead_')) return state.replace('ahead_', 'trailing_');
  if (state.startsWith('trailing_')) return state.replace('trailing_', 'ahead_');
  return 'unclassified';
}

function possessionContexts(possession, side) {
  const contexts = ['all'];
  if (possession.isClutchV1 === true) contexts.push('clutch_v1');
  const transition = String(possession.transitionContext ?? '').trim().toLowerCase();
  contexts.push(CONTEXTS.includes(transition) ? transition : 'unclassified');
  contexts.push(`score_state:${scoreStateForTeam(possession.homeScoreStateV1, side)}`);
  return contexts;
}

function aggregateEntry(entry, contexts, row) {
  for (const context of contexts) {
    if (!entry.has(context)) entry.set(context, createAggregate());
    addAggregate(entry.get(context), row);
  }
}

function createComboEntry(teamId, team) {
  return { teamId, team, playerIds: null, size: null, contexts: new Map() };
}

function combinationIds(ids, size, start = 0, prefix = [], output = []) {
  if (prefix.length === size) {
    output.push(prefix);
    return output;
  }
  for (let index = start; index <= ids.length - (size - prefix.length); index += 1) {
    combinationIds(ids, size, index + 1, [...prefix, ids[index]], output);
  }
  return output;
}

function combosForLineup(ids) {
  const result = [];
  for (let size = 2; size <= 5; size += 1) combinationIds(ids, size, 0, [], result);
  return result;
}

function comboKey(teamId, ids) {
  return `${teamId}~${ids.length}~${ids.join('|')}`;
}

function wowyKey(teamId, a, b) {
  return `${teamId}~${a}~${b}`;
}

function wowyCell(ids, a, b) {
  const aOn = ids.includes(a);
  const bOn = ids.includes(b);
  if (aOn && bOn) return 'a_on_b_on';
  if (aOn) return 'a_on_b_off';
  if (bOn) return 'a_off_b_on';
  return 'a_off_b_off';
}

function outputContexts(map) {
  const result = {};
  for (const [context, aggregate] of map.entries()) result[context] = metric(aggregate);
  return result;
}

function sortBy(...selectors) {
  return (left, right) => {
    for (const selector of selectors) {
      const comparison = String(selector(left)).localeCompare(String(selector(right)));
      if (comparison !== 0) return comparison;
    }
    return 0;
  };
}

function compactRecord(record, filename) {
  const game = record.game ?? {};
  const maps = {
    teams: new Map((record.teams ?? []).map((team) => [team.id, team])),
    players: new Map((record.players ?? []).map((player) => [player.id, player])),
    lineups: new Map((record.lineups ?? []).map((lineup) => [lineup.id, lineup])),
  };
  const homeIds = String(game.homeProviderTeamId ?? '');
  const awayIds = String(game.awayProviderTeamId ?? '');
  return {
    filename,
    record,
    game,
    maps,
    homeTeam: teamName(maps.teams.get(homeIds)) || homeIds,
    awayTeam: teamName(maps.teams.get(awayIds)) || awayIds,
  };
}

async function loadRecords() {
  const entries = (await fs.readdir(GAMES_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json.gz'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = [];
  for (const entry of entries) {
    const filePath = path.join(GAMES_DIR, entry.name);
    const normalized = JSON.parse(gunzipSync(await fs.readFile(filePath)).toString('utf8'));
    records.push(compactRecord(normalized, entry.name));
  }
  records.sort((left, right) => String(left.game.scheduledAt ?? '').localeCompare(String(right.game.scheduledAt ?? '')));
  return records;
}

async function derive() {
  const [manifestRaw, validationRaw, records] = await Promise.all([
    fs.readFile(MANIFEST_PATH, 'utf8'),
    fs.readFile(VALIDATION_PATH, 'utf8'),
    loadRecords(),
  ]);
  const manifest = JSON.parse(manifestRaw);
  const validation = JSON.parse(validationRaw);
  const validationSeason = validation.seasons.find((season) => season.seasonStartYear === OPTIONS.seasonStartYear);
  const eligibleRecords = records.filter(({ record }) => record.analytics?.eligibleForPublication === true);
  const comboMap = new Map();
  const playerOnOffMap = new Map();
  const wowyMap = new Map();
  const teamGames = new Map();
  const playerNames = new Map();
  const teamNames = new Map();
  const rapmGroups = new Map();
  const counters = {
    archivesDiscovered: records.length,
    archivesEligible: eligibleRecords.length,
    archivesIneligible: records.filter(({ record }) => record.analytics?.coverageStatus === 'ineligible').length,
    archivesPartial: records.filter(({ record }) => record.analytics?.coverageStatus === 'partial').length,
    pseudoPlayerRowsExcludedAllArchives: records.reduce((total, { record }) => total + finite(record.source?.skippedSummaryPlayerRows), 0),
    eventsInEligibleArchives: 0,
    stintsInEligibleArchives: 0,
    possessionsInEligibleArchives: 0,
    exactLineupPossessions: 0,
    excludedPossessions: 0,
    excludedPossessionsMidLineupChange: 0,
    excludedPossessionsMissingLineup: 0,
    excludedPossessionsInvalidTeam: 0,
    rapmGroupedObservations: 0,
    pseudoPlayerRowsExcluded: 0,
    contextPossessions: {
      all: 0,
      clutch_v1: 0,
      provider_fastbreak_v1: 0,
      non_provider_fastbreak: 0,
      unclassified: 0,
      scoreStateUnclassified: 0,
    },
  };

  function rememberNames(record) {
    for (const team of record.teams ?? []) teamNames.set(team.id, teamName(team) || team.id);
    for (const player of record.players ?? []) playerNames.set(player.id, playerName(player.id, new Map((record.players ?? []).map((item) => [item.id, item]))));
  }

  for (const { record, game, maps, filename, homeTeam, awayTeam } of eligibleRecords) {
    rememberNames(record);
    counters.eventsInEligibleArchives += record.events?.length ?? 0;
    counters.stintsInEligibleArchives += record.stints?.length ?? 0;
    counters.possessionsInEligibleArchives += record.possessions?.length ?? 0;
    counters.pseudoPlayerRowsExcluded += finite(record.source?.skippedSummaryPlayerRows);

    const homeTeamId = String(game.homeProviderTeamId ?? '');
    const awayTeamId = String(game.awayProviderTeamId ?? '');
    for (const teamId of [homeTeamId, awayTeamId]) {
      if (!teamGames.has(teamId)) teamGames.set(teamId, { teamId, team: teamNames.get(teamId) || teamId, games: 0, pointsFor: 0, pointsAgainst: 0, possessionsFor: 0, possessionsAgainst: 0 });
      const team = teamGames.get(teamId);
      team.games += 1;
      if (teamId === homeTeamId) {
        team.pointsFor += finite(game.homePoints);
        team.pointsAgainst += finite(game.awayPoints);
      } else {
        team.pointsFor += finite(game.awayPoints);
        team.pointsAgainst += finite(game.homePoints);
      }
    }

    const appearedPlayersByTeam = new Map([[homeTeamId, new Set()], [awayTeamId, new Set()]]);
    for (const lineup of record.lineups ?? []) {
      const ids = exactLineup(lineup.id, maps.lineups);
      if (!ids || !appearedPlayersByTeam.has(lineup.providerTeamId)) continue;
      ids.forEach((id) => appearedPlayersByTeam.get(lineup.providerTeamId).add(id));
    }

    for (const possession of record.possessions ?? []) {
      if (possession.hasLineupChangeMidPossession === true) {
        counters.excludedPossessions += 1;
        counters.excludedPossessionsMidLineupChange += 1;
        continue;
      }
      const homePlayerIds = exactLineup(possession.homeLineupId, maps.lineups);
      const awayPlayerIds = exactLineup(possession.awayLineupId, maps.lineups);
      if (!homePlayerIds || !awayPlayerIds) {
        counters.excludedPossessions += 1;
        counters.excludedPossessionsMissingLineup += 1;
        continue;
      }
      const offenseTeamId = String(possession.offenseProviderTeamId ?? '');
      const defenseTeamId = String(possession.defenseProviderTeamId ?? '');
      if (![homeTeamId, awayTeamId].includes(offenseTeamId) || ![homeTeamId, awayTeamId].includes(defenseTeamId) || offenseTeamId === defenseTeamId) {
        counters.excludedPossessions += 1;
        counters.excludedPossessionsInvalidTeam += 1;
        continue;
      }
      counters.exactLineupPossessions += 1;
      const gameId = String(game.providerGameId || filename);
      const points = finite(possession.offensePoints);
      const baseRow = { gameId, pointsFor: points, isOffense: true };
      const rapmKey = `${gameId}~${homePlayerIds.join('|')}~${awayPlayerIds.join('|')}`;
      let rapmGroup = rapmGroups.get(rapmKey);
      if (!rapmGroup) {
        rapmGroup = {
          gameId,
          stintOrdinal: rapmGroups.size + 1,
          homePlayerIds,
          awayPlayerIds,
          homePoints: 0,
          awayPoints: 0,
          homeOffensivePossessions: 0,
          awayOffensivePossessions: 0,
          eligible: true,
        };
        rapmGroups.set(rapmKey, rapmGroup);
      }
      if (offenseTeamId === homeTeamId) {
        rapmGroup.homePoints += points;
        rapmGroup.homeOffensivePossessions += 1;
      } else {
        rapmGroup.awayPoints += points;
        rapmGroup.awayOffensivePossessions += 1;
      }
      const sides = [
        { teamId: homeTeamId, side: 'home', ids: homePlayerIds },
        { teamId: awayTeamId, side: 'away', ids: awayPlayerIds },
      ];
      const transition = String(possession.transitionContext ?? '').trim().toLowerCase();
      counters.contextPossessions.all += 1;
      if (CONTEXTS.includes(transition)) counters.contextPossessions[transition] += 1;
      else counters.contextPossessions.unclassified += 1;
      if (possession.isClutchV1 === true) counters.contextPossessions.clutch_v1 += 1;

      for (const side of sides) {
        const isOffense = side.teamId === offenseTeamId;
        const row = {
          ...baseRow,
          isOffense,
          pointsFor: isOffense ? points : 0,
          pointsAgainst: isOffense ? 0 : points,
        };
        const contexts = possessionContexts(possession, side.side);
        const scoreContext = contexts.find((context) => context.startsWith('score_state:'));
        if (scoreContext === 'score_state:unclassified') counters.contextPossessions.scoreStateUnclassified += 1;
        const lineups = combosForLineup(side.ids);
        for (const ids of lineups) {
          const key = comboKey(side.teamId, ids);
          let entry = comboMap.get(key);
          if (!entry) {
            entry = createComboEntry(side.teamId, teamNames.get(side.teamId) || side.teamId);
            entry.playerIds = ids;
            entry.size = ids.length;
            comboMap.set(key, entry);
          }
          aggregateEntry(entry.contexts, contexts, row);
        }

        const appeared = [...(appearedPlayersByTeam.get(side.teamId) ?? [])].sort((a, b) => a.localeCompare(b));
        for (const playerId of appeared) {
          const key = `${side.teamId}~${playerId}`;
          let entry = playerOnOffMap.get(key);
          if (!entry) {
            entry = { teamId: side.teamId, team: teamNames.get(side.teamId) || side.teamId, playerId, contexts: { on: new Map(), off: new Map() } };
            playerOnOffMap.set(key, entry);
          }
          aggregateEntry(entry.contexts[side.ids.includes(playerId) ? 'on' : 'off'], contexts, row);
        }

        for (let left = 0; left < appeared.length; left += 1) {
          for (let right = left + 1; right < appeared.length; right += 1) {
            const a = appeared[left];
            const b = appeared[right];
            const key = wowyKey(side.teamId, a, b);
            let entry = wowyMap.get(key);
            if (!entry) {
              entry = { teamId: side.teamId, team: teamNames.get(side.teamId) || side.teamId, a, b, cells: new Map() };
              wowyMap.set(key, entry);
            }
            const cell = wowyCell(side.ids, a, b);
            if (!entry.cells.has(cell)) entry.cells.set(cell, new Map());
            aggregateEntry(entry.cells.get(cell), contexts, row);
          }
        }

        if (isOffense) {
          const team = teamGames.get(side.teamId);
          team.possessionsFor += 1;
        } else {
          const team = teamGames.get(side.teamId);
          team.possessionsAgainst += 1;
        }
      }
    }
  }

  const rapmInput = [...rapmGroups.values()];
  counters.rapmGroupedObservations = rapmInput.length;
  const rapm = fitWeightedRidgeRapm(rapmInput, {
    lambda: OPTIONS.rapmLambda,
    seasonEndYear: OPTIONS.seasonStartYear + 1,
    seasonPhase: 'regular_and_playoffs_exact_pbp_groups',
  });
  const rapmPlayers = rapm.players
    .map((row) => ({ ...row, playerName: playerNames.get(row.providerPlayerId) || row.providerPlayerId }))
    .sort(sortBy((row) => row.playerName, (row) => row.providerPlayerId));

  const comboRows = [...comboMap.values()]
    .map((entry) => ({
      teamId: entry.teamId,
      team: entry.team,
      size: entry.size,
      semantics: entry.size === 5 ? 'exact_five_player_lineup' : 'shared_floor_co_presence_combination',
      playerIds: entry.playerIds,
      players: entry.playerIds.map((id) => playerNames.get(id) || id),
      contexts: outputContexts(entry.contexts),
    }))
    .sort(sortBy((row) => row.team, (row) => row.size, (row) => row.playerIds.join('|')));

  const playerOnOffRows = [...playerOnOffMap.values()]
    .map((entry) => ({
      teamId: entry.teamId,
      team: entry.team,
      playerId: entry.playerId,
      player: playerNames.get(entry.playerId) || entry.playerId,
      scope: 'same-game-player-appearance',
      on: outputContexts(entry.contexts.on),
      off: outputContexts(entry.contexts.off),
      onOffNetRating: entry.contexts.on.has('all') && entry.contexts.off.has('all')
        ? round((metric(entry.contexts.on.get('all')).netRating ?? 0) - (metric(entry.contexts.off.get('all')).netRating ?? 0))
        : null,
    }))
    .sort(sortBy((row) => row.team, (row) => row.player));

  const wowyRows = [...wowyMap.values()]
    .map((entry) => ({
      teamId: entry.teamId,
      team: entry.team,
      playerAId: entry.a,
      playerA: playerNames.get(entry.a) || entry.a,
      playerBId: entry.b,
      playerB: playerNames.get(entry.b) || entry.b,
      semantics: 'descriptive_shared_floor_wowy',
      cells: Object.fromEntries([...entry.cells.entries()].map(([cell, contexts]) => [cell, outputContexts(contexts)])),
    }))
    .sort(sortBy((row) => row.team, (row) => row.playerA, (row) => row.playerB));

  const teamRows = [...teamGames.values()].map((team) => ({
    ...team,
    note: 'Points are from the provider game summary; possession counts are exact eligible PBP possessions.',
  })).sort(sortBy((row) => row.team));

  const output = {
    schemaVersion: 1,
    provider: 'Sportradar NBA v8 licensed local archive',
    scope: {
      seasonStartYear: OPTIONS.seasonStartYear,
      seasonEndYear: OPTIONS.seasonStartYear + 1,
      archiveDirectory: path.relative(process.cwd(), OPTIONS.archiveDir),
      eligibility: 'eligibleForPublication=true only',
      rawArchivePreserved: true,
      networkAccess: 'not used',
      supabaseWrites: 'none',
    },
    provenance: {
      manifestSha256: sha256(manifestRaw),
      validationReportSha256: sha256(validationRaw),
      validatorVersion: validation.validatorVersion,
      reconstructionMethodVersions: validationSeason?.totals?.reconstructionMethodVersionCounts ?? {},
      validationPassed: validation.passed === true,
      reconstructionReplayMatchedGames: validationSeason?.totals?.reconstructionReplayMatchedGames ?? null,
    },
    coverage: counters,
    quality: {
      validationErrors: validationSeason?.dataQuality?.analyticsValidationErrorsByCategory ?? {},
      validationWarnings: validationSeason?.dataQuality?.analyticsValidationWarningsByCategory ?? {},
      excludedArchives: counters.archivesIneligible + counters.archivesPartial,
      exclusionPolicy: 'partial and ineligible archives are retained in the raw checkpoint but excluded from Scout aggregates',
    },
    analyticsAvailability: {
      exactTwoToFivePlayerLineups: { status: 'available', rows: comboRows.length, exactFiveSemantics: 'exact_five_player_lineup', twoToFourSemantics: 'shared_floor_co_presence_combination' },
      onOff: { status: 'available', rows: playerOnOffRows.length, scope: 'same-game player appearance' },
      wowy: { status: 'available', rows: wowyRows.length, caveat: 'descriptive four-cell shared-floor partitions, not causal teammate effects' },
      offensiveDefensiveRatingsPer100: { status: 'available', source: 'exact PBP possession transitions' },
      teammateOpponentAdjustment: { status: 'available', method: RAPM_MODEL_VERSION, source: 'grouped exact five-on-five PBP possessions' },
      regularizedAdjustedPlusMinus: { status: 'available', method: RAPM_MODEL_VERSION, lambda: OPTIONS.rapmLambda, playerRows: rapmPlayers.length },
      clutch: { status: 'available', definition: 'archive isClutchV1 flag' },
      transition: { status: 'available', contexts: ['provider_fastbreak_v1', 'non_provider_fastbreak', 'unclassified'] },
      halfCourt: { status: 'proxy_only', proxy: 'non_provider_fastbreak', caveat: 'standard NBA v8 PBP does not verify every non-fastbreak possession as half court' },
      scoreState: { status: 'available', contexts: ['tied', 'ahead_1_5', 'ahead_6_10', 'ahead_11_15', 'ahead_16_plus', 'trailing_1_5', 'trailing_6_10', 'trailing_11_15', 'trailing_16_plus', 'unclassified'] },
      unseenCombinationPrediction: { status: 'not_fitted', caveat: 'RAPM coefficients can support a future projection layer, but no calibrated unseen-lineup prediction is claimed here' },
      confidenceIntervals: { status: 'not_available', caveat: 'The current deterministic ridge pipeline does not estimate uncertainty intervals' },
      videoPlayTypesShotsDefenderTrackingInjuriesContracts: { status: 'not_in_archive', caveat: 'Requires separately licensed/enriched sources' },
    },
    teams: teamRows,
    lineupsAndCombinations: comboRows,
    playerOnOff: playerOnOffRows,
    wowy: wowyRows,
    rapm: {
      modelVersion: rapm.modelVersion,
      seasonEndYear: rapm.seasonEndYear,
      seasonPhase: rapm.seasonPhase,
      lambda: rapm.lambda,
      observationCount: rapm.observationCount,
      gameCount: rapm.gameCount,
      excludedStintCount: rapm.excludedStintCount,
      inputSha256: rapm.inputSha256,
      inputMode: 'grouped_exact_lineup_possessions',
      sourceExactLineupPossessions: counters.exactLineupPossessions,
      interceptPer100: round(rapm.interceptPer100),
      players: rapmPlayers,
    },
  };

  await fs.mkdir(OPTIONS.outputDir, { recursive: true });
  const outputPath = path.join(OPTIONS.outputDir, `nba-scout-analytics-${OPTIONS.seasonStartYear}-${String(OPTIONS.seasonStartYear + 1).slice(-2)}.json`);
  const summaryPath = path.join(OPTIONS.outputDir, 'README.md');
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  const outputHash = await fileSha256(outputPath);
  const summary = `# NBA Scout analytics — ${OPTIONS.seasonStartYear}-${String(OPTIONS.seasonStartYear + 1).slice(-2)}\n\n` +
    `Generated from the preserved local Sportradar archive. No API request and no Supabase write was made.\n\n` +
    `- Source archives: ${counters.archivesDiscovered}; eligible: ${counters.archivesEligible}; excluded from aggregates: ${counters.archivesIneligible + counters.archivesPartial}.\n` +
    `- Eligible events/stints/possessions: ${counters.eventsInEligibleArchives}/${counters.stintsInEligibleArchives}/${counters.possessionsInEligibleArchives}.\n` +
    `- Exact-lineup possessions used: ${counters.exactLineupPossessions}; excluded: ${counters.excludedPossessions}.\n` +
    `- Pseudo-player summary rows excluded: ${counters.pseudoPlayerRowsExcludedAllArchives} across the archive; ${counters.pseudoPlayerRowsExcluded} occurred in eligible games.\n` +
    `- Combination rows: ${comboRows.length}; player on/off rows: ${playerOnOffRows.length}; WOWY pair rows: ${wowyRows.length}.\n` +
    `- RAPM grouped exact-PBP observations/games/player rows: ${rapm.observationCount}/${rapm.gameCount}/${rapmPlayers.length}; model: ${rapm.modelVersion}; lambda: ${rapm.lambda}.\n` +
    `- RAPM source mode: grouped exact-lineup possessions; stored stint point subtotals are not used when the archive validator flags score non-reconciliation.\n` +
    `- Half-court status: proxy only; the archive labels provider fast break/non-provider fast break, not verified half court.\n` +
    `- JSON SHA-256: ${outputHash}\n`;
  await fs.writeFile(summaryPath, summary, 'utf8');
  process.stdout.write(JSON.stringify({ outputPath, summaryPath, outputHash, coverage: counters, rapm: { observationCount: rapm.observationCount, gameCount: rapm.gameCount, playerRows: rapmPlayers.length }, rows: { combinations: comboRows.length, onOff: playerOnOffRows.length, wowy: wowyRows.length } }, null, 2) + '\n');
}

derive().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
