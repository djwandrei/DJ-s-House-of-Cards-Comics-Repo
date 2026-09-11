import {
  chicagoDailySeed,
  loadScoutDailyBoard,
  normalizeDailySeed,
  normalizeGameFamily,
  revealScoutDailyGame,
  scoutDailyGameUnavailableMessage,
} from '../scout-daily-game-client.js?v=20260909m';

import { createNextPlay, focusGameStage } from '../fan-journey.js?v=20260905ui';
import { publicStatLine, validOnePickAlternatives } from '../game-decision-model.js?v=20260907b';
import { decisionBrief, candidateComparison, decisionPreview, decisionDebrief, draftChecklist } from '../game-decision-ui.js?v=20260909m';
import { createFanMilestones } from '../fan-telemetry.js?v=20260909m';
import { createDecisionHistory } from '../game-decision-history.js?v=20260909m';
import { decisionHistoryPanel } from '../game-decision-ui.js?v=20260909m';

const GAME_KIND = 'draft-night';
const PICK_COUNT = 5;
const STORAGE_KEY = 'djhc.draft-night.scout.v1';
const STORAGE_VERSION = 1;
const milestones = createFanMilestones(GAME_KIND);

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
  restart: document.getElementById('restartDraft'),
  undo: document.getElementById('undoPick'),
};

const state = {
  seed: readSeedFromUrl(),
  family: readFamilyFromUrl(),
  board: null,
  history: null,
  selections: [],
  outcome: null,
  pending: false,
  previewId: '',
  store: readStore(),
};

function createElement(tagName, className = '', text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function readSeedFromUrl() {
  return normalizeDailySeed(new URLSearchParams(window.location.search).get('seed')) || chicagoDailySeed();
}

function readFamilyFromUrl() {
  return normalizeGameFamily(new URLSearchParams(window.location.search).get('family'));
}

function emptyStore() {
  return { version: STORAGE_VERSION, runs: {}, completed: {} };
}

function readStore() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    if (!stored || stored.version !== STORAGE_VERSION || typeof stored !== 'object') return emptyStore();
    return {
      ...emptyStore(),
      ...stored,
      runs: stored.runs && typeof stored.runs === 'object' ? stored.runs : {},
      completed: stored.completed && typeof stored.completed === 'object' ? stored.completed : {},
    };
  } catch {
    return emptyStore();
  }
}

function writeStore() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store));
  } catch {
    // A storage-restricted browser still gets a complete local round.
  }
}

function deck() {
  return state.board?.deck || null;
}

function publishedPathCount() {
  const count = Number(deck()?.publishedPathCount);
  return Number.isInteger(count) && count > 0 ? String(count) : '';
}

function recordKey() {
  const boardId = deck()?.id || 'daily-scout-board';
  return `${state.seed}:${state.family || 'automatic'}:${boardId}`;
}

function savedSelections() {
  const record = state.store.runs[recordKey()];
  return Array.isArray(record?.selections) ? record.selections : [];
}

function persistSelections() {
  state.store.runs[recordKey()] = { selections: state.selections.slice() };
  writeStore();
}

function setStatus(message, tone = 'normal') {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', tone === 'error');
}

function currentIndex() {
  return state.selections.length;
}

function isComplete() {
  return Boolean(deck()) && currentIndex() === PICK_COUNT;
}

function playerFor(id) {
  for (const round of deck()?.rounds || []) {
    const player = round.candidates.find((candidate) => candidate.id === id);
    if (player) return player;
  }
  return null;
}

function positionText(player) {
  return Array.isArray(player?.positions) && player.positions.length ? player.positions.join(' / ') : 'Source position unavailable';
}

function playerContext(player) {
  const source = player?.source || {};
  return `${source.teamName || 'Source team'} · ${source.seasonLabel || 'Season unavailable'}`;
}

function playerStatText(player) {
  return publicStatLine(player);
}

function sourceFamilyLabel(family) {
  return ({
    'team-season': 'Team season',
    'franchise-window': 'Franchise window',
    'multi-season-pool': 'Multi-season pool',
  })[family] || 'Scout source';
}

function createPlayerChip(player, index) {
  const item = createElement('li', 'fix-five-player-chip draft-night-player-chip');
  item.append(
    createElement('span', 'draft-night-player-number', String(index + 1)),
    createElement('strong', '', player?.name || 'Player unavailable'),
    createElement('small', '', `${positionText(player)} · ${playerContext(player)}`),
  );
  return item;
}

function renderSource() {
  const source = deck()?.source;
  if (!source) return;
  document.getElementById('sourceHeading').textContent = source.label;
  elements.sourceCopy.textContent = `${sourceFamilyLabel(source.family)} · ${source.label}. ${source.description} ${source.model.label} ranks the sealed result; visible stats are context only.`;
}

function renderProgress() {
  elements.progress.replaceChildren();
  (deck()?.rounds || []).forEach((round, index) => {
    const step = createElement('span', 'fix-five-progress-step', round.title);
    step.dataset.round = String(index + 1);
    step.setAttribute('aria-label', `${round.title}: ${index < currentIndex() ? 'completed' : index === currentIndex() ? 'current pick' : 'up next'}`);
    if (index === currentIndex()) step.setAttribute('aria-current', 'step');
    if (index < currentIndex()) step.classList.add('is-complete');
    else if (index === currentIndex()) step.classList.add('is-current');
    elements.progress.append(step);
  });
}

function localBest() {
  return Number(state.store.completed[recordKey()]?.bestScore || 0);
}

function renderScoreboard() {
  const currentDeck = deck();
  elements.roundCount.textContent = `${Math.min(currentIndex() + 1, PICK_COUNT)}/${PICK_COUNT}`;
  elements.bestScore.textContent = localBest() ? `${localBest()}/100` : (state.outcome ? `${state.outcome.roundScore}/100` : '—');
  elements.pathCount.textContent = Number.isInteger(currentDeck?.publishedPathCount) && currentDeck.publishedPathCount > 0
    ? String(currentDeck.publishedPathCount)
    : '—';
  elements.runTitle.textContent = `Daily Scout draft · ${state.seed}`;
  elements.runDescription.textContent = isComplete()
    ? 'Your five is selected. The sealed Scout comparison uses this one source-labeled daily board.'
    : `${currentDeck?.brief || 'Build a five from today’s source-labeled Scout board.'}`;
  elements.undo.disabled = state.pending || currentIndex() === 0;
}

function renderSelectedPlayers(parent) {
  const section = createElement('section', 'draft-night-selection-section');
  section.append(createElement('h3', 'fix-five-section-title', `Your five · ${state.selections.length} of ${PICK_COUNT} picked`));
  const list = createElement('ol', 'fix-five-lineup-list draft-night-picked-list');
  deck().rounds.forEach((round, index) => {
    if (state.selections[index]) {
      list.append(createPlayerChip(playerFor(state.selections[index]), index));
      return;
    }
    const slot = createElement('li', 'fix-five-player-chip draft-night-player-chip draft-night-open-slot');
    if (index === currentIndex()) slot.setAttribute('aria-current', 'step');
    slot.append(createElement('span', 'draft-night-player-number', String(index + 1)),
      createElement('strong', '', round.title),
      createElement('small', '', index === currentIndex() ? 'On the clock' : 'Up next'));
    list.append(slot);
  });
  section.append(list);
  parent.append(section);
}

function createCandidateButton(round, candidate) {
  const button = createElement('button', 'fix-five-candidate');
  button.type = 'button';
  button.dataset.action = 'choose';
  button.dataset.candidateId = candidate.id;
  button.setAttribute('aria-pressed', String(state.previewId === candidate.id));
  button.disabled = state.pending;
  button.setAttribute('aria-label', `Draft ${candidate.name} as ${round.title}`);
  button.append(
    createElement('span', 'fix-five-candidate-position', positionText(candidate)),
    createElement('strong', '', candidate.name),
    createElement('small', '', playerContext(candidate)),
    createElement('small', 'fix-five-candidate-statline', playerStatText(candidate)),
    createElement('span', 'game-choice-action', state.previewId === candidate.id ? 'Selected for review' : 'Preview this pick →'),
  );
  return button;
}

function renderRound() {
  const round = deck()?.rounds[currentIndex()];
  if (!round) return;
  elements.workspace.hidden = false;
  elements.completionPanel.hidden = true;
  elements.panel.replaceChildren();
  renderSource();

  const header = createElement('header', 'fix-five-challenge-header');
  header.append(createElement('div', 'fix-five-round-label', `Pick ${currentIndex() + 1} of ${PICK_COUNT}`));
  header.append(createElement('h2', '', round.title));
  header.lastElementChild.id = 'draftTitle';
  header.append(createElement('p', '', round.prompt));
  elements.panel.append(header);
  elements.panel.append(createElement('p', 'fix-five-focus', `${sourceFamilyLabel(deck().source.family)} · ${deck().source.seasonLabels.join(', ')} · ${deck().objective.label}`));
  elements.panel.append(decisionBrief(deck(), 'Choose one player per slot. Preview before committing; the Scout rank stays sealed until all five are selected. There is no shot clock or speed bonus.'));
  elements.panel.append(draftChecklist(deck(), state.selections));
  renderSelectedPlayers(elements.panel);
  elements.panel.append(createElement('h3', 'fix-five-section-title', state.pending ? 'Checking your five against the Scout board…' : 'Make this pick'));
  const candidates = createElement('div', 'fix-five-candidate-grid draft-night-candidate-grid');
  round.candidates.forEach((candidate) => candidates.append(createCandidateButton(round, candidate)));
  elements.panel.append(candidates);
  elements.panel.append(candidateComparison(round.candidates));
  const preview = round.candidates.find(player => player.id === state.previewId);
  if (preview) elements.panel.append(decisionPreview(preview, { action: currentIndex() === PICK_COUNT - 1 ? 'Confirm final pick & reveal' : 'Confirm this pick', pending: state.pending,
    description: `${round.title}: this fills one board slot. Your earlier picks stay in place; you can undo the last committed pick. Public source stats do not determine the sealed rank.` }));
}

function createOnePickLearning(outcome) {
  const section = createElement('section', 'draft-night-learning');
  section.append(createElement('h3', '', outcome.isBest ? 'Board check' : 'One-pick learning'));
  const alternatives = validOnePickAlternatives(deck(), state.selections, outcome);
  if (outcome.isBest) {
    section.append(createElement('p', '', 'No one-pick change on this fixed Scout board improves your relative result. You can still edit and explore another lineup identity.'));
    return section;
  }
  if (!alternatives.length) {
    section.append(createElement('p', '', 'No usable one-pick improvement was supplied with this reveal. You can edit a pick and ask Scout to evaluate that exact five; no alternative score is invented here.'));
    return section;
  }
  section.append(createElement('p', '', 'These nearby alternatives are comparisons inside today’s board, not advice for a real game or a player valuation.'));
  const list = createElement('ol');
  alternatives.slice(0, 3).forEach((alternative) => {
    const item = createElement('li');
    item.append(
      createElement('strong', '', `${alternative.title}: ${alternative.from.name} → ${alternative.to.name}`),
      createElement('span', '', `+${alternative.scoreChange} board-score points · rank ${alternative.rank}${publishedPathCount() ? ` of ${publishedPathCount()}` : ''}`),
    );
    const tryChange = createElement('button', 'button-secondary', 'Try & reveal this one-pick change');
    tryChange.type = 'button'; tryChange.dataset.action = 'try-alternative';
    tryChange.dataset.candidateId = alternative.to.id; tryChange.disabled = state.pending;
    item.append(tryChange);
    list.append(item);
  });
  section.append(list);
  return section;
}

function recordCompletion() {
  if (!state.outcome) return;
  const current = state.store.completed[recordKey()];
  const bestScore = Math.max(Number(current?.bestScore || 0), Number(state.outcome.roundScore || 0));
  state.store.completed[recordKey()] = {
    bestScore,
    completedAt: current?.completedAt || new Date().toISOString(),
    selections: state.selections.slice(),
  };
  writeStore();
}

function renderCompletion() {
  if (!isComplete()) return;
  elements.workspace.hidden = true;
  elements.completionPanel.hidden = false;
  elements.completionPanel.replaceChildren();
  const outcome = state.outcome;
  const pathCount = publishedPathCount();
  if (outcome) recordCompletion();
  elements.completionPanel.append(createElement('span', 'kicker', outcome ? 'Scout draft complete' : 'Draft saved locally'));
  elements.completionPanel.append(createElement('h2', '', outcome?.isBest ? 'You drafted the top Scout-board fit.' : (outcome ? 'Your five has a Scout-board identity.' : 'Your five is awaiting its Scout-board reveal.')));
  elements.completionPanel.lastElementChild.id = 'completionTitle';
  elements.completionPanel.append(createElement('p', '', outcome
    ? (outcome.isBest
      ? `Your five ranked first${pathCount ? ` across ${pathCount}` : ''} on this source-labeled board.`
      : `Your five ranked ${outcome.rank}${pathCount ? ` of ${pathCount}` : ''} on this source-labeled board.`)
    : 'The picks are retained only in this browser. A score will appear only when the validated Scout service confirms this exact board.'));

  if (outcome) {
    const score = createElement('div', 'fix-five-total-score');
    score.append(createElement('strong', '', `${outcome.roundScore}/100`), createElement('span', '', `Local best ${Math.max(outcome.roundScore, localBest())}/100`));
    elements.completionPanel.append(score);
  }
  const lineup = createElement('ol', 'fix-five-lineup-list draft-night-result-lineup');
  state.selections.forEach((id, index) => lineup.append(createPlayerChip(playerFor(id), index)));
  elements.completionPanel.append(lineup);
  if (outcome) {
    const resultPills = createElement('div', 'fix-five-result-pills');
    resultPills.append(
      createElement('span', '', `Rank ${outcome.rank}${pathCount ? ` of ${pathCount}` : ''}`),
      createElement('span', '', deck().objective.label),
      createElement('span', '', sourceFamilyLabel(deck().source.family)),
    );
    elements.completionPanel.append(resultPills, createOnePickLearning(outcome));
    elements.completionPanel.append(decisionHistoryPanel(state.history.summary(deck().id)));
    elements.completionPanel.append(decisionDebrief('Your draft, explained', [
      `You filled ${deck().rounds.map(round => round.title).join(', ')} from the same fixed board.`,
      `${deck().objective.label} decided the sealed rank. The role checklist described legal slots, not an extra chemistry bonus.`,
      'Use a supplied one-pick change to keep four choices fixed and compare again. Undo or restart affects only this browser; it does not alter the daily board.',
    ]));
    elements.completionPanel.append(createElement('p', 'fix-five-result-caveat', `${outcome.scoring?.description || state.board.scoring} Visible source stats are context only; raw Scout inputs remain private.`));
    milestones.mark('completion');
  }

  const actions = createElement('div', 'fix-five-complete-actions');
  if (!outcome) {
    const retry = createElement('button', 'button', 'Retry Scout reveal');
    retry.type = 'button';
    retry.dataset.action = 'retry';
    retry.disabled = state.pending;
    actions.append(retry);
  } else {
    const share = createElement('button', 'button', 'Share this board');
    share.type = 'button';
    share.dataset.action = 'share';
    actions.append(share);
  }
  const edit = createElement('button', 'button-secondary', 'Edit last pick');
  edit.type = 'button';
  edit.dataset.action = 'undo';
  const replay = createElement('button', 'button-secondary', 'Draft again');
  replay.type = 'button';
  replay.dataset.action = 'restart';
  const tools = createElement('a', 'button-secondary', 'More fan tools');
  tools.href = '../index.html';
  actions.append(edit, replay, tools);
  elements.completionPanel.append(actions);
  if (outcome) elements.completionPanel.append(createNextPlay(GAME_KIND));
}

function render() {
  elements.restart.disabled = state.pending;
  elements.workspace.setAttribute('aria-busy', String(state.pending));
  elements.completionPanel.setAttribute('aria-busy', String(state.pending));
  renderProgress();
  renderScoreboard();
  if (isComplete()) renderCompletion();
  else renderRound();
}

async function resolveOutcome(announce = true) {
  if (!isComplete() || state.pending) return false;
  state.pending = true;
  if (announce) setStatus('Comparing your five against the validated Scout board…');
  render();
  try {
    const outcome = await revealScoutDailyGame({
      gameKind: GAME_KIND,
      dailySeed: state.seed,
      family: state.family,
      selectionIds: state.selections,
    });
    state.history.record(deck().id, state.selections, outcome);
    state.outcome = outcome;
    milestones.mark('reveal');
    recordCompletion();
    setStatus('Your fixed-board Scout result is ready.');
    return true;
  } catch {
    state.outcome = null;
    setStatus(scoutDailyGameUnavailableMessage(), 'error');
    return false;
  } finally {
    state.pending = false;
    render();
  }
}

async function selectCandidate(candidateId) {
  const round = deck()?.rounds[currentIndex()];
  if (state.pending || !round || !round.candidates.some((candidate) => candidate.id === candidateId)) return;
  state.selections.push(candidateId);
  state.previewId = '';
  state.outcome = null;
  persistSelections();
  const player = playerFor(candidateId);
  setStatus(`${player?.name || 'Pick'} locked. ${isComplete() ? 'Checking the full five now.' : 'The next source-listed role is ready.'}`);
  render();
  if (isComplete()) await resolveOutcome(false);
  focusGameStage(document.getElementById(isComplete() ? 'completionTitle' : 'draftTitle'));
}

function undoPick() {
  if (state.pending || !state.selections.length) return;
  const removed = state.selections.pop();
  state.previewId = '';
  state.outcome = null;
  persistSelections();
  setStatus(`${playerFor(removed)?.name || 'Last pick'} removed. Choose again from the same Scout board.`);
  render();
  focusGameStage(document.getElementById('draftTitle'));
}

function restartDraft() {
  if (state.pending) return;
  state.selections = [];
  state.previewId = '';
  state.outcome = null;
  persistSelections();
  setStatus('This local draft is reset. The same source-labeled Scout board remains in place.');
  render();
  focusGameStage(document.getElementById('draftTitle'));
}

async function shareDraft() {
  if (!state.outcome) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('seed', state.seed);
  if (state.family) url.searchParams.set('family', state.family);
  const shareData = {
    title: 'Draft Night · DJHC',
    text: `I scored ${state.outcome.roundScore}/100 on today’s Draft Night Scout board. Can you draft a stronger five?`,
    url: url.toString(),
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      setStatus('Share sheet opened. The link recreates this daily Scout board.');
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
      setStatus('Share link copied. It recreates this daily Scout board.');
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  window.prompt('Copy this Draft Night board link:', url.toString());
}

function restoreSelections() {
  const saved = savedSelections();
  const restored = [];
  for (let index = 0; index < Math.min(saved.length, PICK_COUNT); index += 1) {
    const candidateId = String(saved[index] || '');
    if (!deck().rounds[index].candidates.some((candidate) => candidate.id === candidateId)) break;
    restored.push(candidateId);
  }
  state.selections = restored;
}

function bindEvents() {
  elements.panel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || state.pending) return;
    if (button.dataset.action === 'choose') {
      if (!deck()?.rounds[currentIndex()]?.candidates.some(player => player.id === button.dataset.candidateId)) return;
      milestones.mark('first_interaction');
      state.previewId = button.dataset.candidateId; render();
      focusGameStage(document.getElementById('decisionPreviewTitle'));
    }
    if (button.dataset.action === 'confirm') selectCandidate(state.previewId);
    if (button.dataset.action === 'cancel-preview') {
      const id = state.previewId; state.previewId = ''; render();
      elements.panel.querySelector(`[data-candidate-id="${CSS.escape(id)}"]`)?.focus();
    }
  });
  elements.completionPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'retry') {
      resolveOutcome().then(() => focusGameStage(document.getElementById('completionTitle')));
    }
    if (button.dataset.action === 'undo') undoPick();
    if (button.dataset.action === 'restart') restartDraft();
    if (button.dataset.action === 'share') shareDraft();
    if (button.dataset.action === 'try-alternative' && !state.pending && state.outcome) {
      const alternative = validOnePickAlternatives(deck(), state.selections, state.outcome).find(item => item.to.id === button.dataset.candidateId);
      if (!alternative) return;
      state.selections[alternative.index] = alternative.to.id; state.outcome = null; state.previewId = '';
      persistSelections(); resolveOutcome().then(() => focusGameStage(document.getElementById('completionTitle')));
    }
  });
  elements.restart.addEventListener('click', restartDraft);
  elements.undo.addEventListener('click', undoPick);
}

async function loadGame() {
  document.getElementById('gameRecovery').hidden = true;
  elements.runTitle.textContent = 'Getting today’s board ready…';
  setStatus('Loading the daily board.');
  try {
    state.board = await loadScoutDailyBoard({ gameKind: GAME_KIND, dailySeed: state.seed, family: state.family });
    state.history = createDecisionHistory(state.board);
    state.selections = []; state.outcome = null; state.previewId = '';
    milestones.mark('game_start');
    restoreSelections();
    if (isComplete()) await resolveOutcome(false);
    else {
      setStatus('Today’s validated Scout board is ready. Draft five legal source-listed players to reveal the fixed-board rank.');
      render();
    }
  } catch {
    elements.workspace.hidden = true;
    elements.completionPanel.hidden = true;
    elements.runTitle.textContent = 'Today’s board is taking a timeout.';
    elements.runDescription.textContent = 'Try again in a moment, or explore another fan tool.';
    document.getElementById('gameRecovery').hidden = false;
    setStatus(scoutDailyGameUnavailableMessage(), 'error');
  }
}

bindEvents();
document.getElementById('retryBoard').addEventListener('click', loadGame);
loadGame();
