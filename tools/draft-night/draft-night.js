import {
  buildDraftNightDeck,
  chicagoDailySeed,
  evaluateDraftNightDeck,
  formatRolePercent,
  formatSignedPoints,
  validateDraftNightDecks,
} from '../fix-the-five/game-engine.js?v=20260905g';
import { DRAFT_NIGHT_DECKS, DRAFT_NIGHT_SOURCE } from './decks.js?v=20260905g';

const STORAGE_KEY = 'djhc.draft-night.v2';
const STORAGE_VERSION = 2;

const elements = {
  runTitle: document.getElementById('runTitle'),
  runDescription: document.getElementById('runDescription'),
  roundCount: document.getElementById('roundCount'),
  bestScore: document.getElementById('bestScore'),
  pathCount: document.getElementById('pathCount'),
  progress: document.getElementById('draftProgress'),
  status: document.getElementById('gameStatus'),
  workspace: document.getElementById('draftWorkspace'),
  panel: document.getElementById('draftPanel'),
  completionPanel: document.getElementById('completionPanel'),
  sourceCopy: document.getElementById('sourceCopy'),
  boardPicker: document.getElementById('draftBoardPicker'),
  restart: document.getElementById('restartDraft'),
  undo: document.getElementById('undoPick'),
};

const state = {
  seed: readSeedFromUrl(),
  requestedDeckId: readDeckIdFromUrl(),
  roster: [],
  deck: null,
  evaluation: null,
  selections: [],
  store: readStore(),
};

function createElement(tagName, className = '', text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function normalizeSeed(value) {
  const seed = String(value || '').trim();
  return /^[a-z0-9_-]{1,64}$/i.test(seed) ? seed : '';
}

function readSeedFromUrl() {
  const fromUrl = normalizeSeed(new URLSearchParams(window.location.search).get('seed'));
  return fromUrl || chicagoDailySeed();
}

function readDeckIdFromUrl() {
  const deckId = String(new URLSearchParams(window.location.search).get('deck') || '').trim();
  return /^[a-z0-9-]{1,80}$/.test(deckId) ? deckId : '';
}

function emptyStore() {
  return { version: STORAGE_VERSION, runs: {}, completed: {} };
}

function readStore() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed || parsed.version !== STORAGE_VERSION || typeof parsed !== 'object') return emptyStore();
    return {
      ...emptyStore(),
      ...parsed,
      runs: parsed.runs && typeof parsed.runs === 'object' ? parsed.runs : {},
      completed: parsed.completed && typeof parsed.completed === 'object' ? parsed.completed : {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store));
  } catch {
    // Local play still works if this browser blocks storage. No account or
    // remote analytics fallback is attempted for game progress.
  }
}

function recordKey() {
  return state.deck ? `${state.seed}:${state.deck.id}` : state.seed;
}

function savedRun() {
  const run = state.store.runs[recordKey()];
  return run && typeof run === 'object' && Array.isArray(run.selections) ? run.selections : [];
}

function persistSelections() {
  state.store.runs[recordKey()] = { deckId: state.deck.id, selections: state.selections.slice() };
  writeStore();
}

function readValidSelections() {
  const saved = savedRun();
  const valid = [];
  for (let index = 0; index < state.deck.rounds.length && index < saved.length; index += 1) {
    const candidateId = saved[index];
    if (!state.deck.rounds[index].candidateIds.includes(candidateId)) break;
    valid.push(candidateId);
  }
  return valid;
}

function setStatus(message, tone = 'normal') {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', tone === 'error');
}

function playerFor(id) {
  return state.roster.find((player) => player.id === id) || null;
}

function sourcePositions(player) {
  return Array.isArray(player?.positions) && player.positions.length
    ? player.positions.join(' / ')
    : 'Source position unavailable';
}

function currentIndex() {
  return state.selections.length;
}

function isComplete() {
  return state.deck && currentIndex() === state.deck.rounds.length;
}

function selectedOutcome() {
  if (!isComplete() || !state.evaluation) return null;
  return state.evaluation.bySelectionSignature[state.selections.join('|')] || null;
}

function localHighScore() {
  return Number(state.store.completed?.[recordKey()]?.bestScore || 0);
}

function createPlayerChip(player, index) {
  const item = createElement('li', 'fix-five-player-chip draft-night-player-chip');
  item.append(
    createElement('span', 'draft-night-player-number', String(index + 1)),
    createElement('strong', '', player.name),
    createElement('small', '', sourcePositions(player)),
  );
  return item;
}

function renderProgress() {
  elements.progress.replaceChildren();
  state.deck.rounds.forEach((round, index) => {
    const step = createElement('span', 'fix-five-progress-step', round.title);
    step.dataset.round = String(index + 1);
    if (index < currentIndex()) step.classList.add('is-complete');
    else if (index === currentIndex()) step.classList.add('is-current');
    elements.progress.append(step);
  });
}

function renderScoreboard() {
  const complete = selectedOutcome();
  const localBest = localHighScore();
  elements.roundCount.textContent = `${Math.min(currentIndex() + 1, state.deck.rounds.length)}/${state.deck.rounds.length}`;
  elements.bestScore.textContent = localBest ? `${localBest}/100` : (complete ? `${complete.roundScore}/100` : '—');
  elements.pathCount.textContent = String(state.evaluation?.combinations.length || 0);
  elements.runTitle.textContent = `Draft board · ${state.seed}`;
  elements.runDescription.textContent = isComplete()
    ? 'Your full five is in. Review its source-bounded Lineup DNA result or replay the same board locally.'
    : `${state.deck.title}: ${state.deck.brief}`;
  elements.undo.disabled = currentIndex() === 0;
}

function renderSelectedPlayers(parent) {
  const section = createElement('section', 'draft-night-selection-section');
  section.append(createElement('h3', 'fix-five-section-title', 'Your draft card'));
  if (!state.selections.length) {
    section.append(createElement('p', 'draft-night-empty-selection', 'No picks locked yet. Build from lead creator through centerpiece big.'));
    parent.append(section);
    return;
  }
  const list = createElement('ol', 'fix-five-lineup-list draft-night-picked-list');
  state.selections.forEach((id, index) => {
    const player = playerFor(id);
    if (player) list.append(createPlayerChip(player, index));
  });
  section.append(list);
  parent.append(section);
}

function addSourceLink(parent) {
  const link = createElement('a', 'fix-five-text-link', 'View source snapshot');
  link.href = state.deck.source.url;
  link.target = '_blank';
  link.rel = 'noopener';
  parent.append(link);
}

function renderBoardPicker() {
  if (!elements.boardPicker || !state.deck) return;
  elements.boardPicker.replaceChildren();
  DRAFT_NIGHT_DECKS.forEach((deck) => {
    const option = document.createElement('option');
    option.value = deck.id;
    option.selected = deck.id === state.deck.id;
    option.textContent = `${deck.title} — ${deck.brief}`;
    elements.boardPicker.append(option);
  });
  elements.boardPicker.disabled = false;
}

function changeBoard(deckId) {
  if (!DRAFT_NIGHT_DECKS.some((deck) => deck.id === deckId) || deckId === state.deck?.id) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('seed', state.seed);
  url.searchParams.set('deck', deckId);
  window.location.assign(url.toString());
}

function renderRound() {
  const index = currentIndex();
  const round = state.deck.rounds[index];
  elements.workspace.hidden = false;
  elements.completionPanel.hidden = true;
  elements.panel.replaceChildren();

  const header = createElement('header', 'fix-five-challenge-header');
  header.append(createElement('div', 'fix-five-round-label', `Pick ${index + 1} of ${state.deck.rounds.length}`));
  header.append(createElement('h2', '', round.title));
  header.lastElementChild.id = 'draftTitle';
  header.append(createElement('p', '', round.prompt));
  elements.panel.append(header);

  const focus = createElement('p', 'fix-five-focus', state.deck.focus);
  elements.panel.append(focus);
  renderSelectedPlayers(elements.panel);

  elements.panel.append(createElement('h3', 'fix-five-section-title', 'Make this pick'));
  const candidates = createElement('div', 'fix-five-candidate-grid draft-night-candidate-grid');
  round.candidateIds.forEach((candidateId) => {
    const player = playerFor(candidateId);
    if (!player) return;
    const button = createElement('button', 'fix-five-candidate');
    button.type = 'button';
    button.dataset.action = 'choose';
    button.dataset.candidateId = candidateId;
    button.setAttribute('aria-label', `Draft ${player.name} as ${round.title}`);
    button.append(
      createElement('span', 'fix-five-candidate-position', sourcePositions(player)),
      createElement('strong', '', player.name),
      createElement('small', '', 'Lock this pick and move to the next part of your five.'),
    );
    candidates.append(button);
  });
  elements.panel.append(candidates);
  addSourceLink(elements.panel);
}

function createRolePanel(title, roles, inverse = false) {
  const panel = createElement('section', 'fix-five-dna-panel');
  panel.append(createElement('h4', '', title));
  const list = createElement('ul', 'fix-five-dna-list');
  roles.forEach((role) => {
    const item = createElement('li', inverse ? 'is-loss' : '');
    item.append(createElement('strong', '', role.label), createElement('span', '', formatRolePercent(role.coverage)));
    list.append(item);
  });
  panel.append(list);
  return panel;
}

function createScoreBreakdown(outcome) {
  const breakdown = outcome.scoreBreakdown;
  const panel = createElement('section', 'fix-five-score-breakdown draft-night-score-breakdown');
  panel.append(createElement('h3', '', 'How the board scored this five'));
  panel.append(createElement('p', '', 'The published composite is calculated before rank. Your 0–100 result is its distance from the strongest legal five on this one board.'));
  const list = createElement('dl', 'fix-five-score-breakdown__list');
  for (const [label, value, detail] of [
    ['Direct objective contribution', breakdown.directContribution, `${breakdown.directObjective.toFixed(1)} fit × 62%`],
    ['Lineup DNA contribution', breakdown.dnaContribution, `${breakdown.dnaFit.toFixed(1)} fit × 38%`],
    ['Published composite', breakdown.composite, 'Compared only with the 243 disclosed paths'],
  ]) {
    const row = createElement('div');
    const term = createElement('dt', '', label);
    const description = createElement('dd');
    description.append(createElement('strong', '', value.toFixed(1)), createElement('span', '', detail));
    row.append(term, description);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

function createOnePickLearning(outcome) {
  const section = createElement('section', 'draft-night-learning');
  section.append(createElement('h3', '', outcome.isBest ? 'Board check' : 'One-pick learning'));
  const improvements = (outcome.onePickAlternatives || []).filter((option) => option.compositeChange > 0.0001);
  if (outcome.isBest) {
    section.append(createElement('p', '', 'No one-pick change on this published board improves the underlying composite. You can still edit the final pick and explore a different lineup identity.'));
    return section;
  }
  if (!improvements.length) {
    section.append(createElement('p', '', 'No single-pick change improves the underlying composite. A stronger published path requires rebuilding more than one choice.'));
    return section;
  }
  section.append(createElement('p', '', 'These are nearby published alternatives after the reveal—not recommendations for a real game or player evaluation.'));
  const list = createElement('ol');
  improvements.slice(0, 2).forEach((option) => {
    const item = createElement('li');
    const scoreChange = formatSignedPoints(option.scoreChange);
    item.append(
      createElement('strong', '', `${option.roundTitle}: ${option.fromPlayer.name} → ${option.toPlayer.name}`),
      createElement('span', '', `${scoreChange} board-score points · rank ${option.rank} of ${state.evaluation.combinations.length}`),
    );
    list.append(item);
  });
  section.append(list);
  return section;
}

function lineupLabUrl(outcome) {
  const parameters = new URLSearchParams({
    v: '1',
    team: state.deck.source.team,
    season: String(state.deck.source.season),
    phase: state.deck.source.phase,
    experience: 'detailed',
    mode: 'lineup',
    size: '5',
    games: '0',
    mpg: '0',
    pos: 'g:2,f:2,c:1',
    roleBalance: 'recommended',
    lock: outcome.selected.map((player) => player.id).join(','),
  });
  return `../../lineup-lab/?${parameters.toString()}`;
}

function recordCompletion(outcome) {
  const prior = state.store.completed[recordKey()];
  const bestScore = Math.max(Number(prior?.bestScore || 0), outcome.roundScore);
  state.store.completed[recordKey()] = {
    bestScore,
    deckId: state.deck.id,
    completedAt: prior?.completedAt || new Date().toISOString(),
    selections: state.selections.slice(),
  };
  persistSelections();
}

function renderCompletion() {
  const outcome = selectedOutcome();
  if (!outcome) return;
  recordCompletion(outcome);
  elements.workspace.hidden = true;
  elements.completionPanel.hidden = false;
  elements.completionPanel.replaceChildren();
  elements.completionPanel.append(createElement('span', 'kicker', 'Draft complete'));
  elements.completionPanel.append(createElement('h2', '', outcome.isBest ? 'You drafted the top published fit.' : 'Your five has a clear identity.'));
  elements.completionPanel.lastElementChild.id = 'completionTitle';
  elements.completionPanel.append(createElement('p', '', outcome.isBest
    ? 'Your five ranked first across every published legal combination on this historical board.'
    : `Your five ranked ${outcome.rank} of ${state.evaluation.combinations.length} on this historical board. The top published fit is shown as a comparison, not a real-game prediction.`));

  const score = createElement('div', 'fix-five-total-score');
  score.append(createElement('strong', '', `${outcome.roundScore}/100`), createElement('span', '', `Local best ${Math.max(outcome.roundScore, localHighScore())}/100`));
  elements.completionPanel.append(score);

  const lineup = createElement('ol', 'fix-five-lineup-list draft-night-result-lineup');
  outcome.selected.forEach((player, index) => lineup.append(createPlayerChip(player, index)));
  elements.completionPanel.append(lineup);

  const roles = createElement('div', 'fix-five-dna-grid draft-night-role-grid');
  roles.append(
    createRolePanel('Strongest coverage', outcome.dna.strengths),
    createRolePanel('Coverage to watch', outcome.dna.needs, true),
  );
  elements.completionPanel.append(roles, createScoreBreakdown(outcome), createOnePickLearning(outcome));
  elements.completionPanel.append(createElement('p', 'draft-night-result-caveat', outcome.dna.evidence));

  const actions = createElement('div', 'fix-five-complete-actions');
  const labLink = createElement('a', 'button-secondary', 'Open related Lineup Lab scenario');
  labLink.href = lineupLabUrl(outcome);
  labLink.target = '_blank';
  labLink.rel = 'noopener';
  const share = createElement('button', 'button', 'Share this board');
  share.type = 'button';
  share.dataset.action = 'share';
  const replay = createElement('button', 'button-secondary', 'Draft again');
  replay.type = 'button';
  replay.dataset.action = 'restart';
  const edit = createElement('button', 'button-secondary', 'Edit last pick');
  edit.type = 'button';
  edit.dataset.action = 'undo';
  const tools = createElement('a', 'button-secondary', 'Explore more fan tools');
  tools.href = '../index.html';
  actions.append(edit, labLink, share, replay, tools);
  elements.completionPanel.append(actions);
}

function render() {
  renderProgress();
  renderScoreboard();
  if (isComplete()) renderCompletion();
  else renderRound();
}

function selectCandidate(candidateId) {
  const round = state.deck.rounds[currentIndex()];
  if (!round || !round.candidateIds.includes(candidateId)) return;
  state.selections.push(candidateId);
  persistSelections();
  const player = playerFor(candidateId);
  setStatus(`${player?.name || 'Pick'} locked. ${isComplete() ? 'Your full five is ready to compare.' : 'The next draft choice is ready.'}`);
  render();
}

function restartDraft() {
  state.selections = [];
  persistSelections();
  setStatus('This local draft has been reset. The same source-labeled board remains in place.');
  render();
}

function undoPick() {
  if (!state.selections.length) return;
  const removed = state.selections.pop();
  persistSelections();
  setStatus(`${playerFor(removed)?.name || 'Last pick'} removed. Choose again from the same round.`);
  render();
}

async function shareDraft() {
  const outcome = selectedOutcome();
  if (!outcome) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('seed', state.seed);
  url.searchParams.set('score', String(outcome.roundScore));
  url.searchParams.set('deck', state.deck.id);
  const shareData = {
    title: 'Draft Night · DJHC',
    text: `I scored ${outcome.roundScore}/100 on a Draft Night historical board. Can you draft a stronger five from the same seed?`,
    url: url.toString(),
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      setStatus('Share sheet opened. The seed recreates this same historical draft board.');
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
      setStatus('Share link copied. It includes the seed and a self-reported score only.');
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  window.prompt('Copy this Draft Night board link:', url.toString());
}

function bindEvents() {
  elements.panel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="choose"]');
    if (button) selectCandidate(button.dataset.candidateId);
  });
  elements.completionPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'restart') restartDraft();
    if (button.dataset.action === 'share') shareDraft();
    if (button.dataset.action === 'undo') undoPick();
  });
  elements.restart.addEventListener('click', restartDraft);
  elements.undo.addEventListener('click', undoPick);
  elements.boardPicker?.addEventListener('change', (event) => changeBoard(event.target.value));
}

async function loadGame() {
  try {
    const response = await fetch(DRAFT_NIGHT_SOURCE.url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Historical source returned ${response.status}.`);
    const dataset = await response.json();
    if (!Array.isArray(dataset?.players)) throw new Error('Historical source did not provide a player roster.');
    state.roster = dataset.players;
    const reviewedDecks = validateDraftNightDecks(DRAFT_NIGHT_DECKS, state.roster);
    state.deck = DRAFT_NIGHT_DECKS.find((deck) => deck.id === state.requestedDeckId)
      || buildDraftNightDeck(DRAFT_NIGHT_DECKS, state.seed);
    state.evaluation = reviewedDecks.find((evaluation) => evaluation.deck.id === state.deck.id)
      || evaluateDraftNightDeck(state.deck, state.roster);
    state.selections = readValidSelections();
    persistSelections();
    renderBoardPicker();
    elements.sourceCopy.textContent = DRAFT_NIGHT_SOURCE.note;
    setStatus('Historical draft board loaded. Make five legal picks, then reveal its source-bounded Lineup DNA.');
    render();
  } catch (error) {
    elements.workspace.hidden = true;
    setStatus(`Draft Night could not load its curated, test-validated historical source. ${error instanceof Error ? error.message : 'Please refresh and try again.'}`, 'error');
  }
}

bindEvents();
loadGame();
