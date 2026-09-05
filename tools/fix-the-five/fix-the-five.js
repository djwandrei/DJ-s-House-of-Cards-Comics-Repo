import {
  buildChallengeRun,
  chicagoDailySeed,
  evaluateFixTheFiveChallenge,
  formatRolePercent,
  formatSignedPoints,
  validateFixTheFiveFixtures,
} from './game-engine.js?v=20260905g';
import { FIX_THE_FIVE_FIXTURES, FIX_THE_FIVE_SOURCE } from './fixtures.js?v=20260905g';

const RUN_LENGTH = 5;
const STORAGE_KEY = 'djhc.fix-the-five.v2';
const STORAGE_VERSION = 2;

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
  run: [],
  roster: [],
  evaluations: new Map(),
  selections: {},
  activeIndex: 0,
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

function emptyStore() {
  return {
    version: STORAGE_VERSION,
    runs: {},
    completed: {},
    streak: 0,
    lastStreakSeed: '',
  };
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
      streak: Math.max(0, Math.floor(Number(parsed.streak) || 0)),
      lastStreakSeed: normalizeSeed(parsed.lastStreakSeed),
    };
  } catch {
    return emptyStore();
  }
}

function writeStore() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store));
  } catch {
    // Local play remains usable when a browser blocks storage. The page does
    // not silently fall back to an account or remote persistence layer.
  }
}

function calendarDateBefore(seed) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(seed)) return '';
  const date = new Date(`${seed}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function currentRunRecord() {
  const record = state.store.runs[state.seed];
  if (!record || typeof record !== 'object') return { selections: {} };
  return {
    selections: record.selections && typeof record.selections === 'object' ? record.selections : {},
  };
}

function persistSelections() {
  state.store.runs[state.seed] = { selections: { ...state.selections } };
  writeStore();
}

function setStatus(message, tone = 'normal') {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', tone === 'error');
}

function evaluationFor(fixture) {
  if (!state.evaluations.has(fixture.id)) {
    state.evaluations.set(fixture.id, evaluateFixTheFiveChallenge(fixture, state.roster));
  }
  return state.evaluations.get(fixture.id);
}

function firstIncompleteIndex() {
  const next = state.run.findIndex((fixture) => !state.selections[fixture.id]);
  return next === -1 ? state.run.length : next;
}

function currentIndex() {
  return Math.min(Math.max(0, state.activeIndex), state.run.length);
}

function totalScore() {
  return state.run.reduce((total, fixture) => {
    const selection = state.selections[fixture.id];
    if (!selection) return total;
    return total + (evaluationFor(fixture).byCandidateId[selection]?.roundScore || 0);
  }, 0);
}

function completedCount() {
  return state.run.filter((fixture) => Boolean(state.selections[fixture.id])).length;
}

function isComplete() {
  return completedCount() === state.run.length;
}

function sourcePositions(player) {
  return Array.isArray(player?.positions) && player.positions.length
    ? player.positions.join(' / ')
    : 'Source position unavailable';
}

function createPlayerChip(player, removed = false) {
  const item = createElement('li', `fix-five-player-chip${removed ? ' is-removed' : ''}`);
  item.append(createElement('span', '', player.name), createElement('small', '', sourcePositions(player)));
  return item;
}

function addSourceLink(parent, fixture) {
  const link = createElement('a', 'fix-five-text-link', 'View source snapshot');
  link.href = fixture.source.url;
  link.target = '_blank';
  link.rel = 'noopener';
  parent.append(link);
}

function roleRows(delta, direction) {
  const eligible = delta.filter((row) => (
    direction === 'gain' ? row.change > 0.015 : row.change < -0.015
  ));
  return eligible.slice(0, 3);
}

function createDnaPanel(title, rows, loss = false) {
  const panel = createElement('section', 'fix-five-dna-panel');
  panel.append(createElement('h4', '', title));
  const list = createElement('ul', 'fix-five-dna-list');
  if (!rows.length) {
    const item = createElement('li', 'is-neutral', loss
      ? 'No material role trade-off crossed the display threshold.'
      : 'No material role gain crossed the display threshold.');
    list.append(item);
  }
  rows.forEach((row) => {
    const item = createElement('li', loss ? 'is-loss' : '');
    item.append(
      createElement('strong', '', row.label),
      createElement('span', '', `${formatSignedPoints(row.change * 100)} pts`),
    );
    list.append(item);
  });
  panel.append(list);
  return panel;
}

function createScoreBreakdown(choice) {
  const breakdown = choice.scoreBreakdown;
  const panel = createElement('section', 'fix-five-score-breakdown');
  panel.append(createElement('h4', '', 'What made this score'));
  const intro = createElement('p', '', 'The candidate composite is calculated before its published-board rank. The round score then compares that composite with the best legal answer.');
  const list = createElement('dl', 'fix-five-score-breakdown__list');
  for (const [label, value, detail] of [
    ['Direct objective contribution', breakdown.directContribution, `${breakdown.directObjective.toFixed(1)} fit × 62%`],
    ['Lineup DNA contribution', breakdown.dnaContribution, `${breakdown.dnaFit.toFixed(1)} fit × 38%`],
    ['Published composite', breakdown.composite, 'Compared only with this candidate board'],
  ]) {
    const row = createElement('div');
    const term = createElement('dt', '', label);
    const description = createElement('dd');
    description.append(createElement('strong', '', value.toFixed(1)), createElement('span', '', detail));
    row.append(term, description);
    list.append(row);
  }
  panel.append(intro, list);
  return panel;
}

function createCandidateBoard(evaluation, choice) {
  const details = createElement('details', 'fix-five-candidate-board');
  const summary = createElement('summary', '', 'Compare every published candidate');
  const intro = createElement('p', '', 'These results are revealed only after your choice. Scores and ranks stay inside this fixed, legal historical board.');
  const list = createElement('ol');
  evaluation.candidates.forEach((candidate) => {
    const item = createElement('li');
    if (candidate.candidateId === choice.candidateId) item.classList.add('is-selected');
    if (candidate.isBest) item.classList.add('is-best');
    const copy = createElement('div');
    copy.append(
      createElement('strong', '', candidate.candidate.name),
      createElement('span', '', `Rank ${candidate.rank} · ${candidate.roundScore}/100`),
    );
    const reading = createElement('small', '', `Objective ${candidate.directObjective.toFixed(1)} · DNA ${candidate.dna.fitIndex.toFixed(1)}`);
    item.append(copy, reading);
    list.append(item);
  });
  details.append(summary, intro, list);
  return details;
}

function relatedLineupLabUrl(fixture, outcome) {
  const parameters = new URLSearchParams({
    v: '1',
    team: fixture.source.team,
    season: String(fixture.source.season),
    phase: fixture.source.phase,
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

function createResult(evaluation, choice) {
  const result = createElement('section', 'fix-five-result');
  const isBest = choice.isBest;
  const header = createElement('div', 'fix-five-result-header');
  const copy = createElement('div');
  copy.append(createElement('span', 'kicker', isBest ? 'Best published swap' : 'Published-board comparison'));
  copy.append(createElement('h3', '', isBest ? 'You found the top legal fit.' : `${choice.candidate.name} is a playable answer.`));
  const comparison = isBest
    ? 'Your choice ranked first on this fixed candidate board.'
    : `${evaluation.best.candidate.name} ranked first on this fixed candidate board. Your selection is still shown with its exact published comparison.`;
  copy.append(createElement('p', '', comparison));
  const score = createElement('div', 'fix-five-round-score');
  score.append(createElement('strong', '', String(choice.roundScore)), createElement('span', '', 'of 100'));
  header.append(copy, score);
  result.append(header);

  const pills = createElement('div', 'fix-five-result-pills');
  pills.append(
    createElement('span', '', `Published rank ${choice.rank} of ${evaluation.candidates.length}`),
    createElement('span', '', `DNA fit ${choice.dna.fitIndex.toFixed(1)}`),
    createElement('span', '', `Role change ${formatSignedPoints(choice.roleImprovement)} points`),
  );
  result.append(pills);

  const dnaGrid = createElement('div', 'fix-five-dna-grid');
  dnaGrid.append(
    createDnaPanel('DNA gains', roleRows(choice.coverageDelta, 'gain')),
    createDnaPanel('Trade-offs to watch', roleRows(choice.coverageDelta.slice().sort((left, right) => left.change - right.change), 'loss'), true),
  );
  result.append(dnaGrid, createScoreBreakdown(choice), createCandidateBoard(evaluation, choice));
  result.append(createElement('p', 'fix-five-result-caveat', choice.dna.evidence));

  const actions = createElement('div', 'fix-five-result-actions');
  const change = createElement('button', 'button-secondary', 'Try a different swap');
  change.type = 'button';
  change.dataset.action = 'change';
  const labLink = createElement('a', 'button-secondary', 'Open related Lineup Lab scenario');
  labLink.href = relatedLineupLabUrl(evaluation.challenge, choice);
  labLink.target = '_blank';
  labLink.rel = 'noopener';
  const isFinalReview = isComplete() && currentIndex() === state.run.length - 1;
  const next = createElement('button', 'button', isFinalReview ? 'Finish run' : 'Next challenge');
  next.type = 'button';
  next.dataset.action = 'next';
  actions.append(change, labLink, next);
  result.append(actions);
  return result;
}

function renderChallenge() {
  const index = currentIndex();
  if (index >= state.run.length) {
    renderCompletion();
    return;
  }
  const fixture = state.run[index];
  const evaluation = evaluationFor(fixture);
  const choiceId = state.selections[fixture.id];
  const choice = choiceId ? evaluation.byCandidateId[choiceId] : null;

  elements.workspace.hidden = false;
  elements.completionPanel.hidden = true;
  elements.challengePanel.replaceChildren();

  const header = createElement('header', 'fix-five-challenge-header');
  header.append(createElement('div', 'fix-five-round-label', `Round ${index + 1} of ${state.run.length}`));
  header.append(createElement('h2', '', fixture.title));
  header.lastElementChild.id = 'challengeTitle';
  header.append(createElement('p', '', fixture.brief));
  elements.challengePanel.append(header);

  elements.challengePanel.append(createElement('h3', 'fix-five-section-title', `The five — replace ${evaluation.removed.name}`));
  const lineup = createElement('ul', 'fix-five-lineup-list');
  evaluation.lineup.forEach((player) => lineup.append(createPlayerChip(player, player.id === evaluation.removed.id)));
  elements.challengePanel.append(lineup);
  elements.challengePanel.append(createElement('p', 'fix-five-focus', fixture.focus));

  if (!choice) {
    elements.challengePanel.append(createElement('h3', 'fix-five-section-title', 'Choose one legal replacement'));
    const candidates = createElement('div', 'fix-five-candidate-grid');
    evaluation.candidates.forEach((candidate) => {
      const button = createElement('button', 'fix-five-candidate');
      button.type = 'button';
      button.dataset.action = 'choose';
      button.dataset.candidateId = candidate.candidateId;
      button.setAttribute('aria-label', `Choose ${candidate.candidate.name}`);
      button.append(
        createElement('span', 'fix-five-candidate-position', sourcePositions(candidate.candidate)),
        createElement('strong', '', candidate.candidate.name),
        createElement('small', '', 'Lock this swap and reveal the Lineup DNA change.'),
      );
      candidates.append(button);
    });
    elements.challengePanel.append(candidates);
  } else {
    elements.challengePanel.append(createResult(evaluation, choice));
  }

  addSourceLink(elements.challengePanel, fixture);
}

function renderProgress() {
  elements.runProgress.replaceChildren();
  const firstIncomplete = firstIncompleteIndex();
  state.run.forEach((fixture, index) => {
    const step = createElement('button', 'fix-five-progress-step', `Challenge ${index + 1}`);
    step.type = 'button';
    step.dataset.action = 'review';
    step.dataset.index = String(index);
    step.dataset.round = String(index + 1);
    step.disabled = !state.selections[fixture.id] && index !== firstIncomplete;
    step.setAttribute('aria-label', state.selections[fixture.id]
      ? `Review challenge ${index + 1}: ${fixture.title}`
      : `Open challenge ${index + 1}: ${fixture.title}`);
    if (state.selections[fixture.id]) step.classList.add('is-complete');
    else if (index === currentIndex()) step.classList.add('is-current');
    elements.runProgress.append(step);
  });
}

function renderScoreboard() {
  const total = totalScore();
  const savedBest = Number(state.store.completed?.[state.seed]?.bestScore || 0);
  elements.roundCount.textContent = `${Math.min(currentIndex() + 1, state.run.length)}/${state.run.length}`;
  elements.bestScore.textContent = savedBest > 0 ? `${savedBest}/500` : `${total}/500`;
  elements.streakCount.textContent = `${state.store.streak} day${state.store.streak === 1 ? '' : 's'}`;
  elements.runTitle.textContent = `Daily five · ${state.seed}`;
  elements.runDescription.textContent = isComplete() && currentIndex() >= state.run.length
    ? 'Run complete. Replay it locally or share the same seeded five with a friend.'
    : isComplete()
      ? 'Reviewing a completed local choice. Change it, then continue through the same seeded run.'
    : 'Five source-labeled historical lineup decisions. Your progress stays in this browser.';
}

function renderSource() {
  elements.sourceCopy.textContent = FIX_THE_FIVE_SOURCE.note;
}

function recordCompletion() {
  const score = totalScore();
  const prior = state.store.completed[state.seed];
  const bestScore = Math.max(Number(prior?.bestScore || 0), score);
  if (!prior && state.seed === chicagoDailySeed()) {
    const yesterday = calendarDateBefore(state.seed);
    state.store.streak = state.store.lastStreakSeed === yesterday ? state.store.streak + 1 : 1;
    state.store.lastStreakSeed = state.seed;
  }
  state.store.completed[state.seed] = {
    bestScore,
    completedAt: prior?.completedAt || new Date().toISOString(),
    rounds: state.run.length,
  };
  persistSelections();
}

function createRunReviewList() {
  const section = createElement('section', 'fix-five-run-review');
  section.append(createElement('h3', '', 'Review a decision'));
  section.append(createElement('p', '', 'Open any completed round to compare the full published board or change that local choice.'));
  const list = createElement('ol');
  state.run.forEach((fixture, index) => {
    const evaluation = evaluationFor(fixture);
    const choice = evaluation.byCandidateId[state.selections[fixture.id]];
    const button = createElement('button');
    button.type = 'button';
    button.dataset.action = 'review';
    button.dataset.index = String(index);
    button.append(
      createElement('strong', '', `Round ${index + 1} · ${fixture.title}`),
      createElement('span', '', choice ? `${choice.candidate.name} · ${choice.roundScore}/100` : 'No local choice'),
    );
    const item = createElement('li');
    item.append(button);
    list.append(item);
  });
  section.append(list);
  return section;
}

function renderCompletion() {
  recordCompletion();
  elements.workspace.hidden = true;
  elements.completionPanel.hidden = false;
  elements.completionPanel.replaceChildren();
  const total = totalScore();
  elements.completionPanel.append(createElement('span', 'kicker', 'Run complete'));
  elements.completionPanel.append(createElement('h2', '', 'Five decisions, one clearer lineup brain.'));
  elements.completionPanel.lastElementChild.id = 'completionTitle';
  elements.completionPanel.append(createElement('p', '', 'Your result is local to this browser. The same seed recreates this exact reviewed challenge order for anyone who opens the shared link.'));
  const score = createElement('div', 'fix-five-total-score');
  score.append(createElement('strong', '', `${total}/500`), createElement('span', '', `Best local score ${Math.max(total, Number(state.store.completed[state.seed]?.bestScore || 0))}/500`));
  elements.completionPanel.append(score, createRunReviewList());
  const actions = createElement('div', 'fix-five-complete-actions');
  const share = createElement('button', 'button', 'Share this run');
  share.type = 'button';
  share.dataset.action = 'share';
  const replay = createElement('button', 'button-secondary', 'Play the five again');
  replay.type = 'button';
  replay.dataset.action = 'restart';
  const tools = createElement('a', 'button-secondary', 'Explore more fan tools');
  tools.href = '../index.html';
  actions.append(share, replay, tools);
  elements.completionPanel.append(actions);
}

function render() {
  renderProgress();
  renderScoreboard();
  if (isComplete() && currentIndex() >= state.run.length) renderCompletion();
  else renderChallenge();
}

function selectCandidate(candidateId) {
  const fixture = state.run[currentIndex()];
  if (!fixture) return;
  const evaluation = evaluationFor(fixture);
  if (!evaluation.byCandidateId[candidateId]) return;
  state.selections[fixture.id] = candidateId;
  persistSelections();
  const choice = evaluation.byCandidateId[candidateId];
  setStatus(`${choice.candidate.name} locked. You earned ${choice.roundScore} of 100 for this historical published-board comparison.`);
  render();
}

function nextChallenge() {
  const fixture = state.run[currentIndex()];
  if (!fixture || !state.selections[fixture.id]) {
    render();
    return;
  }
  state.activeIndex = Math.min(currentIndex() + 1, state.run.length);
  render();
}

function changeCurrentChoice() {
  const fixture = state.run[currentIndex()];
  if (!fixture || !state.selections[fixture.id]) return;
  delete state.selections[fixture.id];
  persistSelections();
  setStatus(`Your ${fixture.title} choice is open again. Compare the same published candidates and lock a new swap when ready.`);
  render();
}

function reviewChallenge(index) {
  const fixture = state.run[index];
  if (!fixture || (!state.selections[fixture.id] && index !== firstIncompleteIndex())) return;
  state.activeIndex = index;
  setStatus(state.selections[fixture.id]
    ? `Reviewing ${fixture.title}. You can compare the board or try a different local swap.`
    : `Opening ${fixture.title}. Pick the legal swap you trust most.`);
  render();
}

function restartRun() {
  state.selections = {};
  state.activeIndex = 0;
  state.store.runs[state.seed] = { selections: {} };
  writeStore();
  setStatus('This local run has been reset. The same daily seed and challenge order remain in place.');
  render();
}

async function shareRun() {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('seed', state.seed);
  url.searchParams.set('score', String(totalScore()));
  url.searchParams.set('rounds', String(state.run.length));
  const shareData = {
    title: 'Fix the Five · DJHC',
    text: `I scored ${totalScore()}/500 in today’s Fix the Five historical lineup run. Can you beat the same seeded five?`,
    url: url.toString(),
  };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      setStatus('Share sheet opened. The link recreates the same seeded historical five.');
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
      setStatus('Share link copied. It includes the seed and a self-reported score summary only.');
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
  }
  window.prompt('Copy this Fix the Five run link:', url.toString());
}

function bindEvents() {
  elements.challengePanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'choose') selectCandidate(button.dataset.candidateId);
    if (button.dataset.action === 'next') nextChallenge();
    if (button.dataset.action === 'change') changeCurrentChoice();
  });
  elements.completionPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'restart') restartRun();
    if (button.dataset.action === 'share') shareRun();
    if (button.dataset.action === 'review') reviewChallenge(Number(button.dataset.index));
  });
  elements.runProgress.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action="review"]');
    if (button && !button.disabled) reviewChallenge(Number(button.dataset.index));
  });
  elements.restartRun.addEventListener('click', restartRun);
}

async function loadGame() {
  try {
    const response = await fetch(FIX_THE_FIVE_SOURCE.url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Historical source returned ${response.status}.`);
    const dataset = await response.json();
    if (!Array.isArray(dataset?.players)) throw new Error('Historical source did not provide a player roster.');
    state.roster = dataset.players;
    const reviewedEvaluations = validateFixTheFiveFixtures(FIX_THE_FIVE_FIXTURES, state.roster);
    // Release validation already evaluates every fixture. Reuse those immutable
    // results for this local run instead of rebuilding the same role model
    // once per card after the source has loaded.
    state.evaluations = new Map(reviewedEvaluations.map((evaluation) => [evaluation.challenge.id, evaluation]));
    state.run = buildChallengeRun(FIX_THE_FIVE_FIXTURES, state.seed, RUN_LENGTH);
    state.selections = currentRunRecord().selections;
    const validSelections = Object.fromEntries(Object.entries(state.selections).filter(([fixtureId, candidateId]) => {
      const fixture = state.run.find((item) => item.id === fixtureId);
      return fixture && evaluationFor(fixture).byCandidateId[candidateId];
    }));
    state.selections = validSelections;
    state.activeIndex = firstIncompleteIndex();
    persistSelections();
    renderSource();
    elements.workspace.hidden = false;
    setStatus('Historical source loaded. Pick the legal swap you trust most.');
    render();
  } catch (error) {
    elements.workspace.hidden = true;
    setStatus(`Fix the Five could not load its curated, test-validated historical source. ${error instanceof Error ? error.message : 'Please refresh and try again.'}`, 'error');
  }
}

bindEvents();
loadGame();
