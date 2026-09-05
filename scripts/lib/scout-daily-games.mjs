/**
 * Private compiler for the public-facing Scout Daily Games catalog.
 *
 * It accepts validated Scout O/D inputs, produces a public board with only
 * source-identifying player context, and keeps rankings in a separate sealed
 * outcome payload. The caller must never publish the input Scout values.
 */

export const SCOUT_DAILY_GAME_CONTRACT_VERSION = 1;
export const SCOUT_DAILY_GAME_MODEL_VERSION = 'scout-daily-games-v1';
export const SCOUT_DAILY_GAME_KINDS = Object.freeze(['fix-the-five', 'draft-night']);
export const SCOUT_DAILY_GAME_FAMILIES = Object.freeze([
  'team-season',
  'franchise-window',
  'multi-season-pool',
]);
export const SCOUT_DAILY_GAME_SEASONS = Object.freeze([2024, 2025, 2026]);

const GAME_SEASON_SET = new Set(SCOUT_DAILY_GAME_SEASONS);
const SLOT_ORDER = Object.freeze(['G', 'G', 'F', 'F', 'C']);
const OBJECTIVES = Object.freeze([
  Object.freeze({
    id: 'balanced',
    label: 'Two-way balance',
    description: 'The Scout model gives equal weight to its offense and defense components.',
  }),
  Object.freeze({
    id: 'offense',
    label: 'Offensive edge',
    description: 'The Scout model ranks the disclosed board by its offensive component.',
  }),
  Object.freeze({
    id: 'defense',
    label: 'Defensive edge',
    description: 'The Scout model ranks the disclosed board by points-prevented impact.',
  }),
]);
const ALLOWED_POSITION_TOKENS = new Set(['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']);
const PUBLIC_STAT_KEYS = Object.freeze([
  'games', 'minutes', 'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'efgPct', 'threePct',
]);
const PRIVATE_KEY_PATTERN = /(?:offen[sc]|defen[sc]|rapm|impact|coefficient|scout(?:score|value|impact)|rawscore)/i;

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function requireIdentifier(value, label) {
  const id = requireText(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function requireFinite(value, label) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    throw new Error(`${label} must be finite.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite.`);
  return number;
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableCompare(left, right) {
  return String(left).localeCompare(String(right));
}

function seededOrder(values, seed) {
  return values.slice().sort((left, right) => (
    stableHash(`${seed}:${left.id || left.playerId || left}`) - stableHash(`${seed}:${right.id || right.playerId || right}`)
    || stableCompare(left.id || left.playerId || left, right.id || right.playerId || right)
  ));
}

function normalizeDailySeed(value) {
  const seed = requireText(value, 'Daily seed');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seed)) throw new Error('Daily seed must use YYYY-MM-DD.');
  const date = new Date(`${seed}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== seed) {
    throw new Error('Daily seed is not a calendar date.');
  }
  return seed;
}

function seasonLabel(seasonEndYear) {
  const endYear = Number(seasonEndYear);
  return `${endYear - 1}\u2013${String(endYear).slice(-2)}`;
}

function normalizePositions(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(/[\s,\/|-]+/);
  const positions = [...new Set(values.map((item) => String(item).trim().toUpperCase()).filter(Boolean))];
  if (!positions.length || positions.some((position) => !ALLOWED_POSITION_TOKENS.has(position))) {
    throw new Error('Every Scout game player needs a supported source-listed position.');
  }
  return positions;
}

function canFillSlot(player, slot) {
  const positions = new Set(player.positions);
  if (slot === 'G') return positions.has('G') || positions.has('PG') || positions.has('SG');
  if (slot === 'F') return positions.has('F') || positions.has('SF') || positions.has('PF');
  return positions.has('C');
}

function publicStatsFor(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(PUBLIC_STAT_KEYS.flatMap((key) => {
    const raw = source[key];
    if (raw === null || raw === undefined || raw === '') return [];
    const number = Number(raw);
    return Number.isFinite(number) && number >= 0 ? [[key, round(number)]] : [];
  }));
}

function normalizePlayer(raw, scope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Scout scope ${scope.id} has an invalid player.`);
  const sourceSeasonEndYear = Number(raw.sourceSeasonEndYear);
  if (!Number.isInteger(sourceSeasonEndYear) || !scope.seasonEndYears.includes(sourceSeasonEndYear)) {
    throw new Error(`Scout player ${raw.playerId || '(unknown)'} is outside ${scope.id}'s model scope.`);
  }
  const scout = raw.scout;
  if (!scout || typeof scout !== 'object' || Array.isArray(scout)) {
    throw new Error(`Scout player ${raw.playerId || '(unknown)'} is missing private Scout evidence.`);
  }
  return Object.freeze({
    id: requireIdentifier(raw.playerId, 'Scout player ID'),
    name: requireText(raw.name, 'Scout player name'),
    positions: Object.freeze(normalizePositions(raw.positions)),
    teamCode: requireIdentifier(raw.teamCode, 'Scout player team code').toUpperCase(),
    teamName: requireText(raw.teamName, 'Scout player team name'),
    franchiseId: requireIdentifier(raw.franchiseId || raw.teamCode, 'Scout player franchise ID').toUpperCase(),
    sourceSeasonEndYear,
    sourceStats: Object.freeze(publicStatsFor(raw.publicStats)),
    // These values stay in the private compiler input. Do not copy them into
    // the output board, a cPanel file, browser storage, or a URL.
    scout: Object.freeze({
      offense: requireFinite(scout.offense, 'Scout offense value'),
      defense: requireFinite(scout.defense, 'Scout defense value'),
    }),
  });
}

function normalizeScope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('A Scout game scope must be an object.');
  if (raw.status !== 'ready') return null;
  const id = requireIdentifier(raw.id, 'Scout scope ID');
  const model = raw.model;
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw new Error(`${id} is missing model metadata.`);
  if (model.calibration?.status !== 'validated' || model.calibration?.allComponentsImproved !== true) {
    throw new Error(`${id} has not passed the Scout O/D calibration gate.`);
  }
  const seasonEndYears = [...new Set((Array.isArray(model.seasonEndYears) ? model.seasonEndYears : []).map(Number))]
    .sort((left, right) => left - right);
  if (!seasonEndYears.length || seasonEndYears.some((year) => !GAME_SEASON_SET.has(year))) {
    throw new Error(`${id} must cover only 2023\u201324 through 2025\u201326 Scout seasons.`);
  }
  const scope = {
    id,
    model: Object.freeze({
      publicLabel: requireText(model.publicLabel || 'Validated Scout O/D model', 'Scout public model label'),
      seasonEndYears: Object.freeze(seasonEndYears),
      calibration: Object.freeze({ status: 'validated', allComponentsImproved: true }),
    }),
    seasonEndYears: Object.freeze(seasonEndYears),
  };
  const players = Array.isArray(raw.players) ? raw.players.map((player) => normalizePlayer(player, scope)) : [];
  if (!players.length) throw new Error(`${id} has no Scout-eligible players.`);
  return Object.freeze({ ...scope, players: Object.freeze(players) });
}

function canonicalPlayers(players) {
  const byId = new Map();
  for (const player of players) {
    const current = byId.get(player.id);
    const currentMinutes = Number(current?.sourceStats?.minutes || 0);
    const candidateMinutes = Number(player.sourceStats?.minutes || 0);
    if (!current
      || player.sourceSeasonEndYear > current.sourceSeasonEndYear
      || (player.sourceSeasonEndYear === current.sourceSeasonEndYear && candidateMinutes > currentMinutes)
      || (player.sourceSeasonEndYear === current.sourceSeasonEndYear && candidateMinutes === currentMinutes && stableCompare(player.teamCode, current.teamCode) < 0)) {
      byId.set(player.id, player);
    }
  }
  return [...byId.values()].sort((left, right) => stableCompare(left.id, right.id));
}

function sourceDescriptor(scope, family, players, detail) {
  const seasons = [...new Set(players.map((player) => player.sourceSeasonEndYear))].sort((left, right) => left - right);
  const seasonText = seasons.map(seasonLabel).join(', ');
  const descriptor = {
    id: `${scope.id}-${family}-${requireIdentifier(detail.id, 'Scout source ID')}`.toLowerCase(),
    scopeId: scope.id,
    family,
    model: scope.model,
    seasonEndYears: Object.freeze(seasons),
    players: Object.freeze(canonicalPlayers(players)),
    label: detail.label,
    description: detail.description,
  };
  if (!descriptor.players.length) throw new Error(`${descriptor.id} has no distinct players.`);
  if (family === 'team-season' && seasons.length !== 1) throw new Error(`${descriptor.id} must be a single team-season.`);
  if ((family === 'franchise-window' || family === 'multi-season-pool') && seasons.length < 2) {
    throw new Error(`${descriptor.id} needs multiple source seasons.`);
  }
  return Object.freeze(descriptor);
}

function buildSources(scope) {
  const sources = [];
  const byTeamSeason = new Map();
  const byFranchise = new Map();
  for (const player of scope.players) {
    const teamKey = `${player.teamCode}:${player.sourceSeasonEndYear}`;
    if (!byTeamSeason.has(teamKey)) byTeamSeason.set(teamKey, []);
    byTeamSeason.get(teamKey).push(player);
    if (!byFranchise.has(player.franchiseId)) byFranchise.set(player.franchiseId, []);
    byFranchise.get(player.franchiseId).push(player);
  }
  for (const [key, players] of byTeamSeason) {
    const first = players[0];
    sources.push(sourceDescriptor(scope, 'team-season', players, {
      id: key.replace(':', '-'),
      label: `${first.teamName} ${seasonLabel(first.sourceSeasonEndYear)}`,
      description: `One franchise, one roster, one ${seasonLabel(first.sourceSeasonEndYear)} source season.`,
    }));
  }
  if (scope.seasonEndYears.length > 1) {
    for (const [franchiseId, players] of byFranchise) {
      const seasons = new Set(players.map((player) => player.sourceSeasonEndYear));
      if (seasons.size < 2) continue;
      const label = players[0]?.teamName || franchiseId;
      sources.push(sourceDescriptor(scope, 'franchise-window', players, {
        id: franchiseId,
        label: `${label} franchise window`,
        description: `${label} players drawn across ${[...seasons].sort((left, right) => left - right).map(seasonLabel).join(', ')}.`,
      }));
    }
    const poolSeasons = new Set(scope.players.map((player) => player.sourceSeasonEndYear));
    if (poolSeasons.size > 1) {
      sources.push(sourceDescriptor(scope, 'multi-season-pool', scope.players, {
        id: 'league-pool',
        label: 'Multi-season Scout pool',
        description: `A randomized pool spanning ${[...poolSeasons].sort((left, right) => left - right).map(seasonLabel).join(', ')}.`,
      }));
    }
  }
  return sources;
}

function publicPlayer(player) {
  return Object.freeze({
    id: player.id,
    name: player.name,
    positions: player.positions,
    source: Object.freeze({
      teamCode: player.teamCode,
      teamName: player.teamName,
      seasonEndYear: player.sourceSeasonEndYear,
      seasonLabel: seasonLabel(player.sourceSeasonEndYear),
    }),
    stats: player.sourceStats,
  });
}

function publicSource(source) {
  return Object.freeze({
    family: source.family,
    label: source.label,
    description: source.description,
    seasonEndYears: source.seasonEndYears,
    seasonLabels: Object.freeze(source.seasonEndYears.map(seasonLabel)),
    model: Object.freeze({
      label: source.model.publicLabel,
      seasonEndYears: source.model.seasonEndYears,
      scoring: 'Validated Scout O/D model determines rank. Public historical stats explain the lineup context only.',
    }),
  });
}

function objectiveFor(seed) {
  return OBJECTIVES[stableHash(`${seed}:objective`) % OBJECTIVES.length];
}

function scoutScore(player, objective) {
  if (objective.id === 'offense') return player.scout.offense;
  if (objective.id === 'defense') return player.scout.defense;
  return (player.scout.offense + player.scout.defense) / 2;
}

function pickPlayersForSlot(players, slot, count, used, seed) {
  const candidates = seededOrder(
    canonicalPlayers(players.filter((player) => !used.has(player.id) && canFillSlot(player, slot))),
    seed,
  );
  if (candidates.length < count) return null;
  const selected = candidates.slice(0, count);
  selected.forEach((player) => used.add(player.id));
  return selected;
}

function relativeScores(rows) {
  const values = rows.map((row) => row.privateScore);
  const highest = Math.max(...values);
  const lowest = Math.min(...values);
  return rows.map((row) => ({
    ...row,
    roundScore: highest === lowest ? 100 : Math.round(((row.privateScore - lowest) / (highest - lowest)) * 100),
  }));
}

function rankRows(rows, tieKey) {
  const ranked = rows.slice().sort((left, right) => (
    right.privateScore - left.privateScore
    || stableCompare(tieKey(left), tieKey(right))
  ));
  return relativeScores(ranked).map((row, index) => ({ ...row, rank: index + 1, isBest: index === 0 }));
}

function createFixChallenge(source, dailySeed, index) {
  const objective = objectiveFor(`${dailySeed}:fix:${index}:${source.id}`);
  const used = new Set();
  const lineup = [];
  for (let slotIndex = 0; slotIndex < SLOT_ORDER.length; slotIndex += 1) {
    const slot = SLOT_ORDER[slotIndex];
    const players = pickPlayersForSlot(source.players, slot, 1, used, `${dailySeed}:fix:${source.id}:lineup:${slotIndex}`);
    if (!players) return null;
    lineup.push(players[0]);
  }
  const firstReplacementIndex = stableHash(`${dailySeed}:fix:${source.id}:replace`) % SLOT_ORDER.length;
  const replacementOrder = Array.from({ length: SLOT_ORDER.length }, (_, offset) => (
    (firstReplacementIndex + offset) % SLOT_ORDER.length
  ));
  let replacementIndex = null;
  let candidates = null;
  for (const candidateIndex of replacementOrder) {
    const candidateSlot = SLOT_ORDER[candidateIndex];
    const possible = pickPlayersForSlot(source.players, candidateSlot, 3, used, `${dailySeed}:fix:${source.id}:candidates:${candidateIndex}`);
    if (possible) {
      replacementIndex = candidateIndex;
      candidates = possible;
      break;
    }
  }
  if (replacementIndex === null || !candidates) return null;
  const replacementSlot = SLOT_ORDER[replacementIndex];
  const challengeId = `fix-${dailySeed}-${index + 1}-${stableHash(source.id).toString(36)}`.toLowerCase();
  const baseline = lineup.filter((_, lineupIndex) => lineupIndex !== replacementIndex);
  const ranked = rankRows(candidates.map((candidate) => ({
    candidate,
    privateScore: [...baseline, candidate].reduce((total, player) => total + scoutScore(player, objective), 0),
  })), (row) => row.candidate.id);
  return Object.freeze({
    publicChallenge: Object.freeze({
      id: challengeId,
      title: `${objective.label}: repair the ${replacementSlot === 'G' ? 'guard' : replacementSlot === 'F' ? 'wing' : 'big'} slot`,
      brief: `Make one legal change inside a ${source.label} board. Scout rank drives the result; source stats remain context.`,
      focus: objective.description,
      objective: Object.freeze({ id: objective.id, label: objective.label }),
      source: publicSource(source),
      lineup: Object.freeze(lineup.map(publicPlayer)),
      removeId: lineup[replacementIndex].id,
      candidates: Object.freeze(candidates.map(publicPlayer)),
      positionMinimums: Object.freeze({ G: 2, F: 2, C: 1 }),
    }),
    sealedResults: Object.freeze(Object.fromEntries(ranked.map((row) => [row.candidate.id, Object.freeze({
      candidateId: row.candidate.id,
      rank: row.rank,
      roundScore: row.roundScore,
      isBest: row.isBest,
      scoring: Object.freeze({
        model: 'scout-od',
        objective: objective.id,
        description: `${objective.label} rank from the validated Scout O/D model.`,
      }),
    })]))),
  });
}

function createDraftBoard(source, dailySeed) {
  const objective = objectiveFor(`${dailySeed}:draft:${source.id}`);
  const used = new Set();
  const rounds = [];
  for (let index = 0; index < SLOT_ORDER.length; index += 1) {
    const slot = SLOT_ORDER[index];
    const candidates = pickPlayersForSlot(source.players, slot, 3, used, `${dailySeed}:draft:${source.id}:round:${index}`);
    if (!candidates) return null;
    rounds.push(Object.freeze({
      id: `round-${index + 1}`,
      title: index === 0 ? 'Lead guard' : index === 1 ? 'Second guard' : index === 2 ? 'Wing connector' : index === 3 ? 'Frontcourt support' : 'Centerpiece big',
      slot,
      prompt: `Choose one source-listed ${slot} from this fixed Scout board.`,
      candidates: Object.freeze(candidates),
    }));
  }
  const combinations = [];
  function enumerate(cursor = 0, selected = []) {
    if (cursor === rounds.length) {
      combinations.push(selected);
      return;
    }
    rounds[cursor].candidates.forEach((candidate) => enumerate(cursor + 1, [...selected, candidate]));
  }
  enumerate();
  const ranked = rankRows(combinations.map((selected) => ({
    selected,
    signature: selected.map((player) => player.id).join('|'),
    privateScore: selected.reduce((total, player) => total + scoutScore(player, objective), 0),
  })), (row) => row.signature);
  const resultBySignature = new Map(ranked.map((row) => [row.signature, row]));
  const sealedResults = Object.fromEntries(ranked.map((row) => {
    const alternatives = ranked
      .filter((candidate) => candidate.signature !== row.signature)
      .map((candidate) => {
        const changedIndexes = candidate.selected.reduce((indexes, player, playerIndex) => (
          player.id === row.selected[playerIndex].id ? indexes : [...indexes, playerIndex]
        ), []);
        if (changedIndexes.length !== 1) return null;
        const changedIndex = changedIndexes[0];
        return {
          roundId: rounds[changedIndex].id,
          fromPlayerId: row.selected[changedIndex].id,
          toPlayerId: candidate.selected[changedIndex].id,
          rank: candidate.rank,
          roundScore: candidate.roundScore,
          scoreChange: candidate.roundScore - row.roundScore,
        };
      })
      .filter(Boolean)
      .filter((candidate) => candidate.scoreChange > 0)
      .sort((left, right) => right.scoreChange - left.scoreChange || left.rank - right.rank || stableCompare(left.toPlayerId, right.toPlayerId))
      .slice(0, 3)
      .map((candidate) => Object.freeze(candidate));
    return [row.signature, Object.freeze({
      selectionIds: Object.freeze(row.selected.map((player) => player.id)),
      rank: row.rank,
      roundScore: row.roundScore,
      isBest: row.isBest,
      scoring: Object.freeze({
        model: 'scout-od',
        objective: objective.id,
        description: `${objective.label} rank from the validated Scout O/D model.`,
      }),
      onePickAlternatives: Object.freeze(alternatives),
    })];
  }));
  if (resultBySignature.size !== 243) throw new Error('A Draft Night Scout board must expose exactly 243 legal paths.');
  return Object.freeze({
    publicBoard: Object.freeze({
      id: `draft-${dailySeed}-${stableHash(source.id).toString(36)}`.toLowerCase(),
      title: objective.label,
      brief: `Draft five players from a ${source.label} Scout board.`,
      focus: objective.description,
      objective: Object.freeze({ id: objective.id, label: objective.label }),
      source: publicSource(source),
      rounds: Object.freeze(rounds.map((round) => Object.freeze({
        id: round.id,
        title: round.title,
        slot: round.slot,
        prompt: round.prompt,
        candidates: Object.freeze(round.candidates.map(publicPlayer)),
      }))),
      positionMinimums: Object.freeze({ G: 2, F: 2, C: 1 }),
      publishedPathCount: 243,
    }),
    sealedResults: Object.freeze(sealedResults),
  });
}

function sourceOrder(sources, gameKind, dailySeed, cursor, family) {
  const filtered = sources.filter((source) => !family || source.family === family);
  return seededOrder(filtered, `${gameKind}:${dailySeed}:${cursor}`);
}

function assertNoPrivateScoutFields(value, path = 'board') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateScoutFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_KEY_PATTERN.test(key)) throw new Error(`${path}.${key} would expose a private Scout value.`);
    assertNoPrivateScoutFields(nested, `${path}.${key}`);
  }
}

/** Return only validated, in-range, ready-to-play Scout sources. */
export function collectScoutDailyGameSources(scopes = []) {
  if (!Array.isArray(scopes)) throw new Error('Scout game scopes must be an array.');
  return Object.freeze(scopes
    .map(normalizeScope)
    .filter(Boolean)
    .flatMap(buildSources)
    .sort((left, right) => stableCompare(left.id, right.id)));
}

/** Build a deterministic Fix the Five run or Draft Night board from one private Scout scope. */
export function buildScoutDailyGame({ gameKind, dailySeed, scopes, family = null, challengeCount = 5 } = {}) {
  if (!SCOUT_DAILY_GAME_KINDS.includes(gameKind)) throw new Error('Unsupported Scout game kind.');
  if (family !== null && !SCOUT_DAILY_GAME_FAMILIES.includes(family)) throw new Error('Unsupported Scout game family.');
  const seed = normalizeDailySeed(dailySeed);
  const sources = collectScoutDailyGameSources(scopes);
  if (!sources.length) throw new Error('No validated Scout game scope is ready for this date.');
  if (!Number.isInteger(challengeCount) || challengeCount < 1 || challengeCount > 5) {
    throw new Error('Scout Fix the Five runs must contain one through five challenges.');
  }

  if (gameKind === 'fix-the-five') {
    const publicChallenges = [];
    const sealedResults = {};
    const usedSourceIds = new Set();
    for (let index = 0; index < challengeCount; index += 1) {
      const ordered = sourceOrder(sources, gameKind, seed, index, family);
      const preferred = ordered.filter((source) => !usedSourceIds.has(source.id));
      const candidateSources = preferred.length ? preferred : ordered;
      let built = null;
      for (const source of candidateSources) {
        built = createFixChallenge(source, seed, index);
        if (built) {
          usedSourceIds.add(source.id);
          break;
        }
      }
      if (!built) throw new Error(`No legal Scout Fix the Five challenge could be built for round ${index + 1}.`);
      publicChallenges.push(built.publicChallenge);
      sealedResults[built.publicChallenge.id] = built.sealedResults;
    }
    const publicBoard = Object.freeze({
      contractVersion: SCOUT_DAILY_GAME_CONTRACT_VERSION,
      compilerVersion: SCOUT_DAILY_GAME_MODEL_VERSION,
      gameKind,
      dailySeed: seed,
      scoring: 'Validated Scout O/D model determines every rank. Historical player stats are descriptive context only.',
      challenges: Object.freeze(publicChallenges),
    });
    assertNoPrivateScoutFields(publicBoard);
    return Object.freeze({ publicBoard, sealedResults: Object.freeze(sealedResults) });
  }

  let built = null;
  for (const source of sourceOrder(sources, gameKind, seed, 0, family)) {
    built = createDraftBoard(source, seed);
    if (built) break;
  }
  if (!built) throw new Error('No legal Scout Draft Night board could be built for this date.');
  const publicBoard = Object.freeze({
    contractVersion: SCOUT_DAILY_GAME_CONTRACT_VERSION,
    compilerVersion: SCOUT_DAILY_GAME_MODEL_VERSION,
    gameKind,
    dailySeed: seed,
    scoring: 'Validated Scout O/D model determines every rank. Historical player stats are descriptive context only.',
    deck: built.publicBoard,
  });
  assertNoPrivateScoutFields(publicBoard);
  return Object.freeze({ publicBoard, sealedResults: built.sealedResults });
}

/** Guard a browser/API payload against accidental Scout coefficient exposure. */
export function assertScoutDailyGamePublicBoard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Scout public board must be an object.');
  if (Number(value.contractVersion) !== SCOUT_DAILY_GAME_CONTRACT_VERSION) throw new Error('Unsupported Scout daily game contract.');
  if (!SCOUT_DAILY_GAME_KINDS.includes(value.gameKind)) throw new Error('Scout public board has an invalid game kind.');
  normalizeDailySeed(value.dailySeed);
  assertNoPrivateScoutFields(value);
  return value;
}
