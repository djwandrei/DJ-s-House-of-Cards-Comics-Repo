import { dailyMatchup, teamGameEvidence, simulateMatchup, GAME_LAB_POLICY } from './possession-simulator.js?v=20260908a';
import { formatStudioValue as format } from './studio-model.js?v=20260908a';

const node = (tag, text, className) => {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
};
const percent = value => `${(value * 100).toFixed(1)}%`;
const seasonLabel = year => `${year}–${String(year + 1).slice(-2)}`;
function challengeDate() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function control(labelText, id, options) {
  const label = node('label', labelText), select = node('select'); select.id = id;
  options.forEach(([value, text]) => { const option = node('option', text); option.value = value; select.append(option); });
  label.append(select); return { label, input: select };
}
function numberInput(labelText, id, value, min, max, step = 1) {
  const label = node('label', labelText), input = node('input');
  Object.assign(input, { id, type: 'number', value, min, max, step, required: true });
  label.append(input); return { label, input };
}
function evidenceTable(headers, rows, label) {
  const wrap = node('div', undefined, 'studio-table-wrap'); wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', label);
  const table = node('table', undefined, 'studio-table'); table.setAttribute('aria-label', label);
  const head = node('thead'), header = node('tr'), body = node('tbody');
  headers.forEach(text => { const cell = node('th', text); cell.scope = 'col'; header.append(cell); }); head.append(header);
  rows.forEach(row => { const tr = node('tr'); row.forEach((value, index) => { const td = node(index ? 'td' : 'th', String(value));
    if (!index) td.scope = 'row'; tr.append(td); }); body.append(tr); });
  table.append(head, body); wrap.append(table);
  const block = node('div'); block.append(wrap,
    node('p', 'On a narrow screen, scroll the table sideways to see every column.', 'studio-table-hint studio-muted'));
  return block;
}

export function createGameLab(root, request) {
  let source = null, active = null, generation = 0, lastReport = null;
  const cache = new Map();
  const heading = node('h2', 'Game Lab'); heading.id = 'gameLabTitle';
  root.append(heading, node('p', 'Pick a matchup, call the winner, then play through a repeatable scenario. Change pace or the offense/defense blend to see how the result responds.'));
  const form = node('form'), teams = node('div', undefined, 'studio-roadmap');
  const a = control('Team A', 'gameTeamA', []), b = control('Team B', 'gameTeamB', []);
  const season = control('Season sample', 'gameSeason', GAME_LAB_POLICY.seasons.map(year => [year, seasonLabel(year)]));
  teams.append(a.label, b.label, season.label);
  const setup = node('div', undefined, 'studio-team-form');
  const daily = node('button', 'Today’s matchup', 'button-secondary'); daily.type = 'button'; daily.id = 'gameDaily';
  const brief = node('p', '', 'studio-muted'); brief.id = 'gameBrief'; setup.append(daily, brief);
  const assumptions = node('details', undefined, 'studio-panel'); assumptions.append(node('summary', 'Scenario settings and assumptions'));
  const fields = node('div', undefined, 'studio-roadmap');
  const possessions = numberInput('Regulation possessions per team', 'gamePossessions', 100, 60, 140);
  const weight = control('Weight on each team’s offense', 'gameOffenseWeight', [[0.5, '50% offense / 50% opposing defense'], [0.75, '75% offense / 25% opposing defense'], [0.25, '25% offense / 75% opposing defense'], [1, 'Own offense only'], [0, 'Opposing defense only']]);
  const gameFormat = control('Experiment', 'gameFormat', [['game', 'One game'], ['best_of_7', 'Best of seven']]);
  const trials = numberInput('Repeated experiments', 'gameTrials', 1000, 100, 5000, 100);
  const seedLabel = node('label', 'Repeatable seed'), seed = node('input');
  Object.assign(seed, { id: 'gameSeed', type: 'text', maxLength: 80, pattern: '[a-zA-Z0-9:._\\-]+', required: true }); seedLabel.append(seed);
  fields.append(possessions.label, weight.label, gameFormat.label, trials.label, seedLabel);
  assumptions.append(fields, node('p', 'Each scoring distribution blends that team’s recorded scoring possessions with its opponent’s recorded points allowed. The blend is a scenario assumption. It is not a fitted matchup adjustment.', 'studio-muted'),
    node('p', 'Possessions are independent; pace and distributions stay fixed. A tied game gets up to six five-minute overtimes. A series uses the same neutral setup each game. Rosters, home court, injuries, fatigue, travel and coaching are unchanged by this experiment.', 'studio-muted'),
    node('p', 'Scout groups four-or-more-point possessions together. This experiment preserves that bucket’s observed average using its two neighboring integer scores; the full tail shape and predictive calibration are unavailable.', 'studio-muted'));
  const call = control('Your call for the first scenario draw', 'gameCall', [['', 'Explore without a pick'], ['a', 'Team A'], ['b', 'Team B']]);
  const buttons = node('div', undefined, 'studio-team-form'), run = node('button', 'Simulate matchup', 'button'); run.type = 'submit'; run.id = 'gameRun';
  const cancel = node('button', 'Cancel', 'button-secondary'); cancel.type = 'button'; cancel.id = 'gameCancel'; cancel.hidden = true;
  buttons.append(call.label, run, cancel);
  const status = node('p'); status.id = 'gameStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const results = node('div'); results.id = 'gameResults';
  form.append(teams, setup, assumptions, buttons); root.append(form, status, results);
  const settings = [a.input, b.input, season.input, possessions.input, weight.input, gameFormat.input, trials.input, seed];
  function busy(value) {
    form.querySelectorAll('input,select,button').forEach(control => { control.disabled = value; });
    cancel.disabled = false; cancel.hidden = !value; run.textContent = value ? 'Running…' : 'Simulate matchup';
  }
  function clearResult() { active?.abort(); generation++; results.replaceChildren(); status.textContent = 'Settings changed. Run this scenario to update the results.'; }
  settings.forEach(input => input.addEventListener('input', () => {
    clearResult(); brief.textContent = 'Custom matchup. Keep the same seed when comparing settings.';
    if (input === a.input || input === b.input || input === season.input) { call.input.value = ''; lastReport = null; }
  }));
  call.input.addEventListener('input', clearResult);
  function chooseDaily() {
    if (!source) return;
    const challenge = dailyMatchup(source.teams, source.snapshot, challengeDate());
    clearResult(); lastReport = null; a.input.value = challenge.a; b.input.value = challenge.b; season.input.value = challenge.season;
    seed.value = challenge.seed; possessions.input.value = 100; weight.input.value = 0.5; trials.input.value = 1000; gameFormat.input.value = 'game'; call.input.value = '';
    brief.textContent = `Daily setup · ${challenge.date} (Central) · ${seasonLabel(challenge.season)}. One sample and seed for this Scout snapshot.`;
    status.textContent = 'Choose your side or explore without a pick. Team evidence loads when you run.';
  }
  daily.addEventListener('click', chooseDaily);
  cancel.addEventListener('click', () => { active?.abort(); status.textContent = 'Cancelling this experiment…'; });
  const teamName = id => source?.teams.find(team => team.id === id)?.name || 'Selected team';
  async function loadTeam(team, own, runGeneration) {
    if (cache.has(team)) return cache.get(team);
    status.textContent = `Reading Scout evidence for ${teamName(team)}. The first read can take a moment.`;
    const payload = await request('team-contexts', { team, snapshot: source.snapshot }, own.signal);
    if (own.signal.aborted || runGeneration !== generation) throw new DOMException('Cancelled.', 'AbortError');
    if (payload.team !== team || payload.snapshot !== source.snapshot) throw new Error('Team evidence changed. Refresh the Scout checkpoint.');
    // Validate the selected context before retaining a small browser response.
    const evidence = teamGameEvidence(payload, Number(season.input.value));
    if (evidence.status !== 'ready') throw new Error(`${teamName(team)}: ${evidence.reason}`);
    cache.set(team, payload); if (cache.size > 4) cache.delete(cache.keys().next().value);
    return payload;
  }
  function render(report, pick, previous) {
    const nameA = teamName(report.teams[0]), nameB = teamName(report.teams[1]);
    const winnerName = report.example.winner === 'a' ? nameA : report.example.winner === 'b' ? nameB : null;
    const example = node('section', undefined, 'studio-panel');
    const resultHeading = node('h3', winnerName ? `${winnerName} takes the scenario draw` : 'This scenario draw ended unresolved');
    resultHeading.tabIndex = -1; resultHeading.dataset.gameResult = ''; example.append(resultHeading);
    if (pick) example.append(node('p', !winnerName ? 'No winner was assigned, so your call is not graded.'
      : pick === report.example.winner ? 'Your call matched this seeded draw.' : 'This seeded draw went against your call. One draw is only one possible outcome.'));
    example.append(node('p', `Team A: ${nameA} · Team B: ${nameB} · ${seasonLabel(report.season)}`, 'studio-muted'));
    if (report.settings.format === 'best_of_7') {
      example.append(node('strong', `Series: ${report.example.seriesWins.a}–${report.example.seriesWins.b}`));
      example.append(evidenceTable(['Game', 'A score', 'B score'], report.example.games.map((game, index) => [`Game ${index + 1}`, game.a, game.b]), 'The first simulated series'));
    } else {
      const game = report.example.games[0]; example.append(node('strong', `${game.a} – ${game.b}`, 'studio-game-score'));
      example.append(evidenceTable(['Checkpoint', 'A score', 'B score'], game.timeline.map(point => [point.period, point.a, point.b]), 'The first simulated game'));
    }
    const stats = node('section', undefined, 'studio-panel'); stats.append(node('h3', `${format(report.settings.trials)} repeated ${report.settings.format === 'game' ? 'games' : 'series'}`));
    const cards = node('div', undefined, 'studio-roadmap');
    for (const [label, value, detail] of [['A wins', percent(report.shares.a), nameA], ['B wins', percent(report.shares.b), nameB], ['Unresolved', percent(report.shares.unresolved), 'Tied beyond the overtime limit']]) {
      const card = node('article'); card.append(node('h4', label), node('strong', value), node('p', detail)); cards.append(card);
    }
    stats.append(cards, node('p', `Simulated win frequencies under these settings. Approximate Monte Carlo error for A: ±${(1.96 * report.monteCarloStandardErrorA * 100).toFixed(1)} percentage points. This measures repetition noise, not uncertainty in an NBA prediction.`, 'studio-muted'));
    stats.append(node('p', `Expected regulation score from the chosen blend: A ${format(report.expectedRegulationScore.a)} · B ${format(report.expectedRegulationScore.b)}.`));
    stats.append(evidenceTable(['First-game score', '10th percentile', 'Median', '90th percentile'],
      [['Team A', ...[10, 50, 90].map(q => report.firstGame.scoreA[q])], ['Team B', ...[10, 50, 90].map(q => report.firstGame.scoreB[q])],
        ['A minus B', ...[10, 50, 90].map(q => report.firstGame.margin[q])]], 'Simulated first-game score ranges, including overtime'));
    const histogram = node('div', undefined, 'studio-game-histogram'); histogram.setAttribute('aria-label', 'First-game winning margins');
    report.firstGame.histogram.forEach(bin => { const row = node('div'), bar = node('progress');
      bar.max = report.settings.trials; bar.value = bin.count; bar.setAttribute('aria-label', `${bin.label}: ${bin.count} experiments`);
      row.append(node('span', bin.label), bar, node('span', percent(bin.count / report.settings.trials))); histogram.append(row); });
    stats.append(histogram, node('p', report.note, 'studio-muted'));
    if (report.settings.format === 'best_of_7') stats.append(evidenceTable(['Series length', 'Completed experiments'], Object.entries(report.seriesLengths).map(([length, total]) => [`${length} games`, total]), 'Completed series lengths'));
    const evidence = node('details', undefined, 'studio-panel'); evidence.append(node('summary', 'Scout samples behind this experiment'));
    evidence.append(node('p', `Experiment: ${report.modelVersion} · Seed: ${report.seed} · Snapshot: ${report.snapshot}`, 'studio-muted studio-game-repro'));
    evidence.append(evidenceTable(['Sample', 'Games', 'Off. possessions', 'Def. possessions', '4+ point possessions scored / allowed'],
      [['A', report.evidence.a], ['B', report.evidence.b]].map(([label, value]) => [label, value.sample.games, value.offense.possessions, value.defense.possessions,
        `${value.offense.tailCount} / ${value.defense.tailCount}`]), 'Sample exposure for the selected season'));
    evidence.append(node('p', 'Season rows include the package’s eligible competition phases and reconstructed possessions. They do not establish complete season coverage or current roster strength.', 'studio-muted'));
    results.replaceChildren(example, stats, evidence);
    if (previous && previous.modelVersion === report.modelVersion && previous.snapshot === report.snapshot && previous.season === report.season
      && previous.teams.join() === report.teams.join() && previous.settings.format === report.settings.format) {
      const change = node('section', undefined, 'studio-sample'); change.append(node('h3', 'What changed from your previous run?'),
        node('p', `Expected A margin: ${format(previous.expectedRegulationScore.a - previous.expectedRegulationScore.b)} → ${format(report.expectedRegulationScore.a - report.expectedRegulationScore.b)}. Simulated A wins: ${percent(previous.shares.a)} → ${percent(report.shares.a)}.`),
        node('p', previous.seed === report.seed ? 'Both runs used the same seed. Review the settings before attributing the change to one choice.' : 'The seed changed, so the difference also includes new simulation draws.', 'studio-muted'));
      results.prepend(change);
    }
    resultHeading.focus();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (active || !source) return;
    if (a.input.value === b.input.value) { status.textContent = 'Choose two different teams.'; return; }
    const runGeneration = ++generation, own = new AbortController(); active = own; busy(true); results.replaceChildren();
    const pick = call.input.value;
    try {
      const first = await loadTeam(a.input.value, own, runGeneration);
      const second = await loadTeam(b.input.value, own, runGeneration);
      const report = await simulateMatchup({ a: first, b: second, season: Number(season.input.value), seed: seed.value,
        possessions: Number(possessions.input.value), trials: Number(trials.input.value), attackWeight: Number(weight.input.value), format: gameFormat.input.value },
      { signal: own.signal, onProgress: progress => { status.textContent = `Simulating… ${Math.round(progress * 100)}%`; },
        yieldEveryBatch: () => new Promise(resolve => setTimeout(resolve, 0)) });
      if (runGeneration !== generation) return;
      render(report, pick, lastReport); lastReport = report; status.textContent = 'Experiment complete. Change one assumption and rerun to compare.';
    } catch (error) { if (runGeneration === generation) status.textContent = error.name === 'AbortError' ? 'Experiment cancelled. You can run again.' : error.message; }
    finally { if (active === own) { active = null; busy(false); } }
  });
  return { setSource(value) {
    active?.abort(); active = null; generation++; cache.clear(); lastReport = null; results.replaceChildren(); busy(false);
    source = value?.phase === 'ready' ? value : null;
    for (const field of [a.input, b.input]) field.replaceChildren(...(source?.teams || []).map(team => {
      const option = node('option', team.name); option.value = team.id; return option; }));
    if (source) chooseDaily(); else status.textContent = 'A validated Scout snapshot is required.';
  } };
}
