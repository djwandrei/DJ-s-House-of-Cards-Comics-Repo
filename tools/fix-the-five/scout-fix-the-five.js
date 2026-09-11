import {
  chicagoDailySeed,
  loadScoutDailyBoard,
  normalizeDailySeed,
  normalizeGameFamily,
  revealScoutDailyGame,
  scoutDailyGameUnavailableMessage,
} from '../scout-daily-game-client.js?v=20260909m';

import { createNextPlay, focusGameStage } from '../fan-journey.js?v=20260905ui';
import { publicStatLine } from '../game-decision-model.js?v=20260907b';
import { decisionBrief, candidateComparison, decisionPreview, decisionDebrief } from '../game-decision-ui.js?v=20260909m';
import { createFanMilestones } from '../fan-telemetry.js?v=20260909m';
import { createDecisionHistory } from '../game-decision-history.js?v=20260909m';
import { decisionHistoryPanel } from '../game-decision-ui.js?v=20260909m';

const GAME_KIND = 'fix-the-five';
const RUN_LENGTH = 5;
const STORAGE_KEY = 'djhc.fix-the-five.scout.v1';
const STORAGE_VERSION = 1;
const milestones = createFanMilestones(GAME_KIND);

const elements = {
  runTitle: document.getElementById('runTitle'),
  runDescription: document.getElementById('runDescription'),
  roundCount: document.getElementById('roundCount'),
  bestScore: document.getElementById('bestScore'),
  streakCount: document.getElementById('streakCount'),
  runProgress: document.getElementById('runProgress'),
  status: document.getElementById('gameStatus'),
  workspace: document.getElementById('gameWorkspace'),
  challengePanel: document.getElementById('challengePanel'),
  completionPanel: document.getElementById('completionPanel'),
  sourceCopy: document.getElementById('sourceCopy'),
  restartRun: document.getElementById('restartRun'),
};

const state = {
  seed: readSeedFromUrl(),
  family: readFamilyFromUrl(),
  board: null,
  history: null,
  selections: {},
  outcomes: new Map(),
  activeIndex: 0,
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
  return { version: STORAGE_VERSION, runs: {}, completed: {}, streak: 0, lastStreakSeed: '' };
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
      streak: Math.max(0, Math.floor(Number(stored.streak) || 0)),
      lastStreakSeed: normalizeDailySeed(stored.lastStreakSeed),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store));
  } catch {
    // Play remains local and usable if the browser blocks storage.
  }
}

function storageKey() {
  return state.family ? `${state.seed}:${state.family}` : state.seed;
}

function savedSelections() {
  const record = state.store.runs[storageKey()];
  return record?.selections && typeof record.selections === 'object' ? record.selections : {};
}

function persistSelections() {
  state.store.runs[storageKey()] = { selections: { ...state.selections } };
  writeStore();
}

function setStatus(message, tone = 'normal') {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', tone === 'error');
}

function challenges() {
  return state.board?.challenges || [];
}

function challengeAt(index) {
  return challenges()[index] || null;
}

function outcomeFor(challenge) {
  return challenge ? state.outcomes.get(challenge.id) || null : null;
}

function firstIncompleteIndex() {
  const index = challenges().findIndex((challenge) => !state.selections[challenge.id]);
  return index === -1 ? challenges().length : index;
}

function completedCount() {
  return challenges().filter((challenge) => Boolean(state.selections[challenge.id])).length;
}

function isComplete() {
  return challenges().length === RUN_LENGTH && completedCount() === RUN_LENGTH;
}

function totalScore() {
  return challenges().reduce((total, challenge) => total + Number(outcomeFor(challenge)?.roundScore || 0), 0);
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

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '?';
}

function trustedImageUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && ['www.basketball-reference.com', 'cdn.ssref.net', 'iili.io'].includes(url.hostname)
      ? url.href : '';
  } catch {
    return '';
  }
}

function createIdentityBadge(player, label = 'Player identity') {
  const badge = createElement('span', 'fix-five-identity-badge');
  badge.setAttribute('aria-label', label);
  const imageUrl = trustedImageUrl(player?.headshotUrl);
  if (imageUrl) {
    const image = document.createElement('img');
    image.src = imageUrl;
    image.alt = `${player.name} profile`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.replaceWith(createElement('span', '', initials(player.name))), { once: true });
    badge.append(image);
  } else {
    badge.append(createElement('span', '', initials(player?.name)));
  }
  return badge;
}

function createTeamBadge(player) {
  const source = player?.source || {};
  const mark = createElement('span', 'fix-five-team-badge');
  const logoUrl = trustedImageUrl(source.teamLogoUrl);
  if (logoUrl) {
    const image = document.createElement('img');
    image.src = logoUrl;
    image.alt = `${source.teamName || 'Team'} logo`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.replaceWith(createElement('span', '', initials(source.teamName))), { once: true });
    mark.append(image);
  } else {
    mark.append(createElement('span', '', initials(source.teamName)));
  }
  return mark;
}

function sourceFamilyLabel(family) {
  return ({
    'team-season': 'Team season',
    'franchise-window': 'Franchise window',
    'multi-season-pool': 'Multi-season pool',
  })[family] || 'Scout source';
}

function createPlayerChip(player, removed = false) {
  const item = createElement('li', `fix-five-player-chip${removed ? ' is-removed' : ''}`);
  const identity = createElement('div', 'fix-five-player-chip__identity');
  identity.append(createIdentityBadge(player), createTeamBadge(player));
  const copy = createElement('div', 'fix-five-player-chip__copy');
  copy.append(
    createElement('strong', '', player.name),
    createElement('small', '', `${positionText(player)} · ${playerContext(player)}`),
    createElement('small', 'fix-five-player-chip__stats', playerStatText(player)),
  );
  item.append(
    identity,
    copy,
  );
  return item;
}

function renderSource(challenge) {
  if (!challenge) return;
  const source = challenge.source;
  document.getElementById('sourceHeading').textContent = source.label;
  elements.sourceCopy.textContent = `${sourceFamilyLabel(source.family)} · ${source.label}. ${source.description} ${source.model.label} ranks the sealed result; visible stats are context only.`;
}

function createCandidateButton(challenge, candidate) {
  const button = createElement('button', 'fix-five-candidate');
  button.type = 'button';
  button.dataset.action = 'choose';
  button.dataset.candidateId = candidate.id;
  button.setAttribute('aria-pressed', String(state.previewId === candidate.id));
  button.disabled = state.pending;
  button.setAttribute('aria-label', `Choose ${candidate.name}`);
  const identity = createElement('div', 'fix-five-candidate__identity');
  identity.append(createIdentityBadge(candidate), createTeamBadge(candidate));
  const copy = createElement('div', 'fix-five-candidate__copy');
  button.append(
    identity,
    createElement('span', 'fix-five-candidate-position', positionText(candidate)),
    copy,
  );
  copy.append(
    createElement('strong', '', candidate.name),
    createElement('small', '', playerContext(candidate)),
    createElement('small', 'fix-five-candidate-statline', playerStatText(candidate)),
    createElement('span', 'game-choice-action', state.previewId === candidate.id ? 'Selected for review' : 'Preview this swap →'),
  );
  return button;
}

function createResult(challenge, candidate, outcome) {
  const result = createElement('section', 'fix-five-result');
  const header = createElement('div', 'fix-five-result-header');
  const copy = createElement('div');
  copy.append(createElement('span', 'kicker', outcome.isBest ? 'Best Scout-board swap' : 'Scout-board comparison'));
  copy.append(createElement('h3', '', outcome.isBest ? 'You found the top legal swap.' : `${candidate.name} is locked in.`));
  copy.append(createElement('p', '', outcome.isBest
    ? 'This choice ranked first among the three legal replacements on this one source-labeled board.'
    : `This choice ranked ${outcome.rank} of 3 among the legal replacements on this one source-labeled board.`));
  const score = createElement('div', 'fix-five-round-score');
  score.append(createElement('strong', '', String(outcome.roundScore)), createElement('span', '', 'of 100'));
  header.append(copy, score);
  result.append(header);

  const pills = createElement('div', 'fix-five-result-pills');
  pills.append(
    createElement('span', '', `Rank ${outcome.rank} of 3`),
    createElement('span', '', challenge.objective.label),
    createElement('span', '', sourceFamilyLabel(challenge.source.family)),
  );
  result.append(pills);
  result.append(decisionHistoryPanel(state.history.summary(challenge.id)));
  const removed = challenge.lineup.find(player => player.id === challenge.removeId);
  result.append(decisionDebrief('Your decision, explained', [
    `${removed?.name || 'The marked player'} out; ${candidate.name} in. The other four players stayed fixed.`,
    `The revealed rank evaluates ${challenge.objective.label} among these three replacements—not improvement over the outgoing player.`,
    'The public stats below describe the change in personnel. They do not explain the private model’s causal reasoning or predict how this five will play.',
  ]), candidateComparison([candidate], removed));
  result.append(createElement('p', 'fix-five-result-caveat', `${outcome.scoring?.description || state.board.scoring} This is a fixed-board comparison, not a prediction of wins or a claim that these five played together.`));

  const actions = createElement('div', 'fix-five-result-actions');
  const change = createElement('button', 'button-secondary', 'Try a different swap');
  change.type = 'button';
  change.dataset.action = 'change';
  const nextLabel = state.activeIndex === RUN_LENGTH - 1 ? 'Finish run' : 'Next challenge';
  const next = createElement('button', 'button', nextLabel);
  next.type = 'button';
  next.dataset.action = 'next';
  actions.append(change, next);
  result.append(actions);
  return result;
}

function renderChallenge() {
  const challenge = challengeAt(state.activeIndex);
  if (!challenge) {
    renderCompletion();
    return;
  }
  elements.workspace.hidden = false;
  elements.completionPanel.hidden = true;
  elements.challengePanel.replaceChildren();
  renderSource(challenge);

  const header = createElement('header', 'fix-five-challenge-header');
  header.append(createElement('div', 'fix-five-round-label', `Round ${state.activeIndex + 1} of ${RUN_LENGTH}`));
  header.append(createElement('h2', '', challenge.title));
  header.lastElementChild.id = 'challengeTitle';
  header.append(createElement('p', '', 'Pick the player who replaces the marked spot. Every choice shown below is legal for this board.'));
  elements.challengePanel.append(header);

  const sourceBadge = createElement('p', 'fix-five-focus', `${sourceFamilyLabel(challenge.source.family)} · ${challenge.source.seasonLabels.join(', ')} · ${challenge.objective.label}`);
  elements.challengePanel.append(sourceBadge);
  elements.challengePanel.append(decisionBrief(challenge, 'Keep the other four players fixed. Preview one replacement, then confirm to reveal its rank.'));
  elements.challengePanel.append(createElement('h3', 'fix-five-section-title', `The five — replace ${challenge.lineup.find((player) => player.id === challenge.removeId)?.name || 'the marked player'}`));
  const lineup = createElement('ul', 'fix-five-lineup-list');
  challenge.lineup.forEach((player) => lineup.append(createPlayerChip(player, player.id === challenge.removeId)));
  elements.challengePanel.append(lineup);

  const selectedId = state.selections[challenge.id];
  const selected = challenge.candidates.find((candidate) => candidate.id === selectedId);
  const outcome = outcomeFor(challenge);
  if (selected && outcome) {
    elements.challengePanel.append(createResult(challenge, selected, outcome));
    return;
  }

  elements.challengePanel.append(createElement('h3', 'fix-five-section-title', state.pending ? 'Checking your Scout-board swap…' : 'Choose one legal replacement'));
  const candidates = createElement('div', 'fix-five-candidate-grid');
  challenge.candidates.forEach((candidate) => candidates.append(createCandidateButton(challenge, candidate)));
  elements.challengePanel.append(candidates);
  elements.challengePanel.append(candidateComparison(challenge.candidates, challenge.lineup.find(player => player.id === challenge.removeId)));
  const preview = challenge.candidates.find(player => player.id === state.previewId);
  if (preview) elements.challengePanel.append(decisionPreview(preview, { action: 'Confirm swap & reveal', pending: state.pending,
    description: 'This is a preview, not a submitted guess. Confirm to request the sealed Scout rank; the other four players and current objective stay fixed.' }));
}

function renderProgress() {
  elements.runProgress.replaceChildren();
  const firstIncomplete = firstIncompleteIndex();
  challenges().forEach((challenge, index) => {
    const step = createElement('button', 'fix-five-progress-step', `Challenge ${index + 1}`);
    step.type = 'button';
    step.dataset.action = 'review';
    step.dataset.index = String(index);
    step.dataset.round = String(index + 1);
    const complete = Boolean(state.selections[challenge.id]);
    step.disabled = state.pending || (!complete && index !== firstIncomplete);
    step.setAttribute('aria-label', complete ? `Completed: review challenge ${index + 1}` : `Open challenge ${index + 1}`);
    if (index === state.activeIndex) step.setAttribute('aria-current', 'step');
    if (complete) step.classList.add('is-complete');
    else if (index === state.activeIndex) step.classList.add('is-current');
    elements.runProgress.append(step);
  });
}

function localBest() {
  return Number(state.store.completed[storageKey()]?.bestScore || 0);
}

function renderScoreboard() {
  const complete = isComplete();
  elements.roundCount.textContent = `${Math.min(state.activeIndex + 1, RUN_LENGTH)}/${RUN_LENGTH}`;
  elements.bestScore.textContent = localBest() ? `${localBest()}/500` : (completedCount() ? `${totalScore()}/500` : '—');
  elements.streakCount.textContent = `${state.store.streak} day${state.store.streak === 1 ? '' : 's'}`;
  elements.runTitle.textContent = `Daily Scout five · ${state.seed}`;
  elements.runDescription.textContent = complete
    ? 'All five selections are in. Review the fixed Scout-board results or replay this same daily run locally.'
    : 'Five deterministic, source-labeled Scout challenges. The source family can change from round to round.';
}

function calendarDateBefore(seed) {
  const date = new Date(`${seed}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function recordCompletion() {
  if (!isComplete()) return;
  const score = totalScore();
  const existing = state.store.completed[storageKey()];
  state.store.completed[storageKey()] = {
    bestScore: Math.max(score, Number(existing?.bestScore || 0)),
    completedAt: existing?.completedAt || new Date().toISOString(),
  };
  if (!existing) {
    if (state.store.lastStreakSeed === state.seed) {
      // A replay cannot inflate a daily streak.
    } else if (state.store.lastStreakSeed === calendarDateBefore(state.seed)) {
      state.store.streak += 1;
      state.store.lastStreakSeed = state.seed;
    } else {
      state.store.streak = 1;
      state.store.lastStreakSeed = state.seed;
    }
  }
  writeStore();
}

function renderCompletion() {
  if (!isComplete()) return;
  recordCompletion();
  elements.workspace.hidden = true;
  elements.completionPanel.hidden = false;
  elements.completionPanel.replaceChildren();
  const score = totalScore();
  elements.completionPanel.append(createElement('span', 'kicker', 'Daily Scout run complete'));
  elements.completionPanel.append(createElement('h2', '', score === 500 ? 'Perfect Scout board.' : 'Your Scout board is complete.'));
  elements.completionPanel.lastElementChild.id = 'completionTitle';
  elements.completionPanel.append(createElement('p', '', `You scored ${score} of 500 across five sealed Scout-board comparisons. Each round stayed inside its disclosed source family and validated model window.`));
  const scoreCard = createElement('div', 'fix-five-total-score');
  scoreCard.append(createElement('strong', '', `${score}/500`), createElement('span', '', `Local best ${Math.max(score, localBest())}/500`));
  elements.completionPanel.append(scoreCard);

  const list = createElement('ol', 'fix-five-completion-list');
  challenges().forEach((challenge, index) => {
    const outcome = outcomeFor(challenge);
    const selected = challenge.candidates.find((candidate) => candidate.id === state.selections[challenge.id]);
    const item = createElement('li');
    item.append(
      createElement('strong', '', `Round ${index + 1}: ${selected?.name || 'Selection unavailable'}`),
      createElement('span', '', `${outcome?.roundScore || 0}/100 · rank ${outcome?.rank || '—'} of 3 · ${challenge.source.label}`),
    );
    list.append(item);
  });
  elements.completionPanel.append(list);
  elements.completionPanel.append(createElement('p', 'fix-five-result-caveat', 'The public board reveals source context and your relative rank only. Raw Scout inputs remain private.'));

  const actions = createElement('div', 'fix-five-complete-actions');
  const share = createElement('button', 'button', 'Share this daily run');
  share.type = 'button';
  share.dataset.action = 'share';
  const replay = createElement('button', 'button-secondary', 'Play the run again');
  replay.type = 'button';
  replay.dataset.action = 'restart';
  const tools = createElement('a', 'button-secondary', 'More fan tools');
  tools.href = '../index.html';
  actions.append(share, replay, tools);
  elements.completionPanel.append(actions);
  elements.completionPanel.append(createNextPlay(GAME_KIND));
  milestones.mark('completion');
}

function render() {
  elements.workspace.setAttribute('aria-busy', String(state.pending));
  elements.restartRun.disabled = state.pending;
  renderProgress();
  renderScoreboard();
  if (isComplete() && state.activeIndex >= RUN_LENGTH) renderCompletion();
  else renderChallenge();
}

async function chooseCandidate(candidateId) {
  const challenge = challengeAt(state.activeIndex);
  if (state.pending || !challenge || !challenge.candidates.some((candidate) => candidate.id === candidateId)) return;
  state.pending = true;
  setStatus('Checking that swap against the validated Scout board…');
  render();
  try {
    const outcome = await revealScoutDailyGame({
      gameKind: GAME_KIND,
      dailySeed: state.seed,
      family: state.family,
      challengeId: challenge.id,
      candidateId,
    });
    state.history.record(challenge.id, [candidateId], outcome);
    state.selections[challenge.id] = candidateId;
    state.outcomes.set(challenge.id, outcome);
    milestones.mark('reveal');
    state.previewId = '';
    persistSelections();
    setStatus(`${challenge.candidates.find((candidate) => candidate.id === candidateId)?.name || 'Your swap'} is locked. Scout rank revealed on this fixed board.`);
  } catch {
    setStatus(scoutDailyGameUnavailableMessage(), 'error');
  } finally {
    state.pending = false;
    render();
    focusGameStage(document.getElementById('challengeTitle'));
  }
}

function changeCurrentSwap() {
  const challenge = challengeAt(state.activeIndex);
  if (!challenge || state.pending) return;
  delete state.selections[challenge.id];
  state.outcomes.delete(challenge.id);
  state.previewId = '';
  persistSelections();
  setStatus('Choose a different legal replacement from this same Scout board.');
  render();
  focusGameStage(document.getElementById('challengeTitle'));
}

function nextChallenge() {
  if (state.pending) return;
  const challenge = challengeAt(state.activeIndex);
  if (!challenge || !state.selections[challenge.id]) return;
  state.activeIndex = Math.min(state.activeIndex + 1, RUN_LENGTH);
  state.previewId = '';
  setStatus(state.activeIndex >= RUN_LENGTH ? 'Your five-round Scout run is ready to finish.' : 'The next source-labeled Scout challenge is ready.');
  render();
  focusGameStage(document.getElementById(state.activeIndex >= RUN_LENGTH ? 'completionTitle' : 'challengeTitle'));
}

function restartRun() {
  if (state.pending) return;
  state.selections = {};
  state.outcomes.clear();
  state.activeIndex = 0;
  state.previewId = '';
  persistSelections();
  setStatus('This local run is reset. The same daily Scout boards remain in place.');
  render();
  focusGameStage(document.getElementById('challengeTitle'));
}

async function shareRun() {
  if (!isComplete()) return;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('seed', state.seed);
  if (state.family) url.searchParams.set('family', state.family);
  const score = totalScore();
  const shareData = {
    title: 'Fix the Five · DJHC',
    text: `I scored ${score}/500 on today’s Fix the Five Scout boards. Can you improve it?`,
    url: url.toString(),
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      setStatus('Share sheet opened. The link recreates this daily Scout run.');
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
      setStatus('Share link copied. It recreates this daily Scout run.');
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  window.prompt('Copy this Fix the Five link:', url.toString());
}

async function restoreSavedSelections() {
  const saved = savedSelections();
  for (const challenge of challenges()) {
    const candidateId = String(saved[challenge.id] || '');
    if (!candidateId || !challenge.candidates.some((candidate) => candidate.id === candidateId)) continue;
    try {
      const outcome = await revealScoutDailyGame({
        gameKind: GAME_KIND,
        dailySeed: state.seed,
        family: state.family,
        challengeId: challenge.id,
        candidateId,
      });
      state.history.record(challenge.id, [candidateId], outcome);
      state.selections[challenge.id] = candidateId;
      state.outcomes.set(challenge.id, outcome);
    } catch {
      // Do not trust a saved result after a board revision. The next live
      // attempt is the only way to reveal a score.
    }
  }
  state.activeIndex = firstIncompleteIndex();
}

function bindEvents() {
  elements.challengePanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (state.pending) return;
    if (button.dataset.action === 'choose') {
      const challenge = challengeAt(state.activeIndex);
      if (!challenge?.candidates.some(player => player.id === button.dataset.candidateId)) return;
      milestones.mark('first_interaction');
      state.previewId = button.dataset.candidateId;
      render(); focusGameStage(document.getElementById('decisionPreviewTitle'));
    }
    if (button.dataset.action === 'confirm') chooseCandidate(state.previewId);
    if (button.dataset.action === 'cancel-preview') {
      const id = state.previewId; state.previewId = ''; render();
      elements.challengePanel.querySelector(`[data-candidate-id="${CSS.escape(id)}"]`)?.focus();
    }
    if (button.dataset.action === 'change') changeCurrentSwap();
    if (button.dataset.action === 'next') nextChallenge();
  });
  elements.runProgress.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="review"]');
    const index = Number(button?.dataset.index);
    if (!Number.isInteger(index) || state.pending) return;
    state.activeIndex = index;
    state.previewId = '';
    render();
    focusGameStage(document.getElementById('challengeTitle'));
  });
  elements.completionPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'restart') restartRun();
    if (button.dataset.action === 'share') shareRun();
  });
  elements.restartRun.addEventListener('click', restartRun);
}

async function loadGame() {
  document.getElementById('gameRecovery').hidden = true;
  elements.runTitle.textContent = 'Getting today’s board ready…';
  setStatus('Loading the daily board.');
  try {
    state.board = await loadScoutDailyBoard({ gameKind: GAME_KIND, dailySeed: state.seed, family: state.family });
    state.history = createDecisionHistory(state.board);
    state.selections = {}; state.outcomes.clear(); state.activeIndex = 0; state.previewId = '';
    milestones.mark('game_start');
    await restoreSavedSelections();
    setStatus('Today’s validated Scout board is ready. Pick a legal replacement to reveal its fixed-board rank.');
    render();
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
