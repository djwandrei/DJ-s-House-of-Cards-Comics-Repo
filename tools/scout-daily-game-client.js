/**
 * Browser boundary for the Scout Daily Games Edge Function.
 *
 * The function returns a public board plus a sealed, per-selection outcome.
 * This module deliberately validates that no raw Scout components reach page
 * state, localStorage, share URLs, or rendering code.
 */

export const SCOUT_DAILY_GAME_CONTRACT_VERSION = 1;
export const SCOUT_DAILY_GAME_KINDS = Object.freeze(['fix-the-five', 'draft-night']);
export const SCOUT_DAILY_GAME_FAMILIES = Object.freeze([
  'team-season',
  'franchise-window',
  'multi-season-pool',
]);

const PRIVATE_SCOUT_KEY = /^(?:scout|offen[sc]|defen[sc]|rapm|impact|coefficient|rawscore|provider(?:player)?id|playerid)/i;
const PROVIDER_UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function assertNoPrivateScoutFields(value, path = 'payload') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateScoutFields(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'string' && PROVIDER_UUID_PATTERN.test(value)) {
    throw new Error(`${path} is not a public Scout game identifier.`);
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, nested]) => {
    if (PRIVATE_SCOUT_KEY.test(key)) throw new Error(`${path}.${key} is not a public Scout game field.`);
    if (typeof nested === 'string' && PROVIDER_UUID_PATTERN.test(nested)) {
      throw new Error(`${path}.${key} is not a public Scout game identifier.`);
    }
    assertNoPrivateScoutFields(nested, `${path}.${key}`);
  });
}

function assertPlayer(player, label) {
  if (!player || typeof player !== 'object' || Array.isArray(player)) throw new Error(`${label} is invalid.`);
  requireText(player.id, `${label} ID`);
  requireText(player.name, `${label} name`);
  if (!Array.isArray(player.positions) || !player.positions.length) throw new Error(`${label} positions are missing.`);
  if (!player.source || typeof player.source !== 'object' || Array.isArray(player.source)) {
    throw new Error(`${label} source context is missing.`);
  }
  requireText(player.source.teamName, `${label} team name`);
  requireText(player.source.seasonLabel, `${label} season`);
}

function assertSource(source, label) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(`${label} source is invalid.`);
  if (!SCOUT_DAILY_GAME_FAMILIES.includes(String(source.family || ''))) {
    throw new Error(`${label} source family is invalid.`);
  }
  requireText(source.label, `${label} source label`);
  requireText(source.description, `${label} source description`);
  requireText(source.model?.label, `${label} model label`);
  if (!Array.isArray(source.seasonLabels) || !source.seasonLabels.length) {
    throw new Error(`${label} source seasons are missing.`);
  }
}

function assertFixBoard(board) {
  if (!Array.isArray(board.challenges) || board.challenges.length !== 5) {
    throw new Error('Fix the Five needs five Scout challenges.');
  }
  board.challenges.forEach((challenge, index) => {
    const label = `Fix the Five challenge ${index + 1}`;
    requireText(challenge?.id, `${label} ID`);
    requireText(challenge?.title, `${label} title`);
    requireText(challenge?.brief, `${label} brief`);
    assertSource(challenge?.source, label);
    if (!Array.isArray(challenge?.lineup) || challenge.lineup.length !== 5) {
      throw new Error(`${label} lineup is invalid.`);
    }
    challenge.lineup.forEach((player, playerIndex) => assertPlayer(player, `${label} lineup player ${playerIndex + 1}`));
    requireText(challenge?.removeId, `${label} removed player`);
    if (!Array.isArray(challenge?.candidates) || challenge.candidates.length !== 3) {
      throw new Error(`${label} needs three legal candidates.`);
    }
    challenge.candidates.forEach((player, playerIndex) => assertPlayer(player, `${label} candidate ${playerIndex + 1}`));
  });
}

function assertDraftBoard(board) {
  const deck = board.deck;
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) throw new Error('Draft Night deck is invalid.');
  requireText(deck.id, 'Draft Night deck ID');
  requireText(deck.title, 'Draft Night deck title');
  assertSource(deck.source, 'Draft Night');
  if (!Array.isArray(deck.rounds) || deck.rounds.length !== 5) throw new Error('Draft Night needs five Scout picks.');
  deck.rounds.forEach((round, index) => {
    const label = `Draft Night round ${index + 1}`;
    requireText(round?.id, `${label} ID`);
    requireText(round?.title, `${label} title`);
    requireText(round?.prompt, `${label} prompt`);
    if (!Array.isArray(round?.candidates) || round.candidates.length !== 3) {
      throw new Error(`${label} needs three legal candidates.`);
    }
    round.candidates.forEach((player, playerIndex) => assertPlayer(player, `${label} candidate ${playerIndex + 1}`));
  });
}

export function normalizeDailySeed(value) {
  const seed = String(value || '').trim();
  if (!ISO_DATE.test(seed)) return '';
  const date = new Date(`${seed}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === seed ? seed : '';
}

export function chicagoDailySeed(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeGameFamily(value) {
  const family = String(value || '').trim();
  return SCOUT_DAILY_GAME_FAMILIES.includes(family) ? family : '';
}

export function assertScoutDailyGamePublicBoard(value, expectedGameKind = '', expectedDailySeed = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Scout daily board is invalid.');
  assertNoPrivateScoutFields(value, 'board');
  if (Number(value.contractVersion) !== SCOUT_DAILY_GAME_CONTRACT_VERSION) {
    throw new Error('This Scout daily board uses an unsupported contract.');
  }
  if (!SCOUT_DAILY_GAME_KINDS.includes(String(value.gameKind || ''))) {
    throw new Error('This Scout daily board uses an unsupported game kind.');
  }
  if (expectedGameKind && value.gameKind !== expectedGameKind) throw new Error('Scout daily board game kind did not match the page.');
  const dailySeed = normalizeDailySeed(value.dailySeed);
  if (!dailySeed) throw new Error('Scout daily board has an invalid date.');
  if (expectedDailySeed && dailySeed !== expectedDailySeed) throw new Error('Scout daily board date did not match the requested day.');
  if (value.gameKind === 'fix-the-five') assertFixBoard(value);
  else assertDraftBoard(value);
  return value;
}

export function assertScoutDailyGameReveal(value, gameKind, dailySeed, selection = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Scout daily reveal is invalid.');
  assertNoPrivateScoutFields(value, 'reveal');
  if (Number(value.contractVersion) !== SCOUT_DAILY_GAME_CONTRACT_VERSION || value.gameKind !== gameKind || value.dailySeed !== dailySeed) {
    throw new Error('Scout daily reveal did not match this board.');
  }
  const outcome = value.outcome;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error('Scout daily result is missing.');
  if (!Number.isInteger(Number(outcome.rank)) || Number(outcome.rank) < 1) throw new Error('Scout daily result rank is invalid.');
  if (!Number.isInteger(Number(outcome.roundScore)) || Number(outcome.roundScore) < 0 || Number(outcome.roundScore) > 100) {
    throw new Error('Scout daily result score is invalid.');
  }
  if (gameKind === 'fix-the-five' && outcome.candidateId !== selection.candidateId) {
    throw new Error('Scout daily result did not match the selected player.');
  }
  if (gameKind === 'draft-night') {
    const selected = Array.isArray(selection.selectionIds) ? selection.selectionIds : [];
    if (!Array.isArray(outcome.selectionIds) || outcome.selectionIds.join('|') !== selected.join('|')) {
      throw new Error('Scout daily result did not match the selected five.');
    }
  }
  return outcome;
}

function browserInvoker() {
  const invoker = window.DJ?.remoteCatalog?.invokeFunction;
  if (typeof invoker !== 'function') throw new Error('The public game connection is not ready.');
  return invoker;
}

export async function invokeScoutDailyGame(payload, invoke = browserInvoker()) {
  const result = await invoke('scout-daily-game', payload);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Scout Daily Games returned an invalid response.');
  return result;
}

export async function loadScoutDailyBoard({ gameKind, dailySeed, family = '', invoke } = {}) {
  if (!SCOUT_DAILY_GAME_KINDS.includes(gameKind)) throw new Error('Choose a supported Scout daily game.');
  const seed = normalizeDailySeed(dailySeed);
  if (!seed) throw new Error('Choose a valid daily date.');
  const requestedFamily = family ? normalizeGameFamily(family) : '';
  if (family && !requestedFamily) throw new Error('Choose a supported Scout challenge family.');
  const response = await invokeScoutDailyGame({
    action: 'board', gameKind, dailySeed: seed, ...(requestedFamily ? { family: requestedFamily } : {}),
  }, invoke || browserInvoker());
  return assertScoutDailyGamePublicBoard(response.board, gameKind, seed);
}

export async function revealScoutDailyGame({ gameKind, dailySeed, family = '', challengeId = '', candidateId = '', selectionIds = [], invoke } = {}) {
  if (!SCOUT_DAILY_GAME_KINDS.includes(gameKind)) throw new Error('Choose a supported Scout daily game.');
  const seed = normalizeDailySeed(dailySeed);
  if (!seed) throw new Error('Choose a valid daily date.');
  const requestedFamily = family ? normalizeGameFamily(family) : '';
  if (family && !requestedFamily) throw new Error('Choose a supported Scout challenge family.');
  const payload = {
    action: 'reveal', gameKind, dailySeed: seed, ...(requestedFamily ? { family: requestedFamily } : {}),
  };
  const selection = gameKind === 'fix-the-five'
    ? { candidateId: requireText(candidateId, 'Candidate ID'), challengeId: requireText(challengeId, 'Challenge ID') }
    : { selectionIds: Array.isArray(selectionIds) ? selectionIds.map((id) => requireText(id, 'Selected player ID')) : [] };
  Object.assign(payload, selection);
  const response = await invokeScoutDailyGame(payload, invoke || browserInvoker());
  return assertScoutDailyGameReveal(response, gameKind, seed, selection);
}

export function scoutDailyGameUnavailableMessage() {
  return 'The validated Scout board is not available right now. This game will not substitute an older roster or a non-Scout score; please try again later.';
}
