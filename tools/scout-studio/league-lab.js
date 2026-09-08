import { simulateLeague, roundRobinSchedule } from './season-simulator.js?v=20260907e';
import { teamGameEvidence } from './possession-simulator.js?v=20260907e';
import { captureLeagueSummary, compareLeagueScenarios } from './league-comparisons.js?v=20260907e';

const node = (tag, text, className = '') => {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
  if (className) element.className = className; return element;
};
function choice(labelText, id, options) {
  const label = node('label', labelText), input = node('select'); input.id = id;
  for (const [value, text] of options) { const option = node('option', text); option.value = value; input.append(option); }
  label.append(input); return { label, input };
}
function table(title, headers, rows) {
  const block = node('div'), wrap = node('div', undefined, 'studio-table-wrap'), table = node('table', undefined, 'studio-table');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', title);
  table.append(node('caption', title)); const head = node('thead'), header = node('tr'), body = node('tbody');
  headers.forEach(label => { const cell = node('th', label); cell.scope = 'col'; header.append(cell); }); head.append(header);
  rows.forEach(row => { const tr = node('tr'); row.forEach((value, index) => { const cell = node(index ? 'td' : 'th', String(value));
    if (!index) cell.scope = 'row'; tr.append(cell); }); body.append(tr); });
  table.append(head, body); wrap.append(table); block.append(wrap, node('p', 'Scroll tables sideways on narrow screens.', 'studio-table-hint studio-muted')); return block;
}
const percent = (count, total) => `${(count / total * 100).toFixed(1)}%`;

export function createLeagueLab(root, request) {
  let source = null, active = null, generation = 0, reference = null, currentReport = null;
  const cache = new Map(), heading = node('h2', 'Season Lab'); heading.id = 'leagueLabTitle';
  root.append(heading, node('p', 'Build a four-team mini league, decide how often rivals meet, then follow the standings and title race through repeated seasons.'),
    node('p', 'Custom round-robin experiments—not the NBA schedule or calibrated playoff odds. Team-season scoring samples stay fixed; rotations, injuries, fatigue and home-court effects are not modeled.', 'studio-muted'));
  const form = node('form'), field = node('div', undefined, 'studio-league-teams');
  const entrants = Array.from({ length: 4 }, (_, index) => choice(`Franchise ${index + 1}`, `leagueTeam${index + 1}`, []));
  entrants.forEach(entrant => field.append(entrant.label));
  const setup = node('div', undefined, 'studio-roadmap');
  const season = choice('Season sample', 'leagueSeason', [2020, 2021, 2022, 2023, 2024, 2025].map(year => [year, `${year}–${String(year + 1).slice(-2)}`]));
  const cycles = choice('Meetings per pair', 'leagueCycles', [[2, 'Twice · six games per team'], [1, 'Once · three games per team'], [4, 'Four times · twelve games per team']]);
  const playoffs = choice('Postseason', 'leaguePlayoffs', [[2, 'Top two · final'], [4, 'Top four · semifinals and final'], [0, 'Standings only']]);
  setup.append(season.label, cycles.label, playoffs.label);
  const more = node('details', undefined, 'studio-panel'); more.append(node('summary', 'League assumptions and workload'));
  const settings = node('div', undefined, 'studio-roadmap');
  const length = choice('Series length', 'leagueSeriesLength', [[3, 'Best of three'], [1, 'One game'], [7, 'Best of seven']]);
  const pace = choice('Possessions per team', 'leaguePace', [[100, '100 · baseline'], [90, '90 · slower'], [110, '110 · faster']]);
  const blend = choice('Scoring blend', 'leagueBlend', [[0.5, '50% offense / 50% opposing defense'], [0.75, '75% offense / 25% opposing defense'], [0.25, '25% offense / 75% opposing defense']]);
  const trials = choice('Repeated seasons', 'leagueTrials', [[100, '100'], [250, '250'], [500, '500']]);
  const seedLabel = node('label', 'Repeatable seed'), seed = node('input'); Object.assign(seed, { id: 'leagueSeed', value: 'league-v1', maxLength: 80, required: true, pattern: '[a-zA-Z0-9:._\\-]+' }); seedLabel.append(seed);
  settings.append(length.label, pace.label, blend.label, trials.label, seedLabel);
  more.append(settings, node('p', 'Custom standings use wins plus half a point for unresolved ties, then point differential, then a disclosed seeded lottery. These are not NBA tiebreakers. Tied playoff games beyond the overtime limit leave that bracket unresolved; they never grant an automatic bye.', 'studio-muted'));
  const brief = node('p', '', 'studio-muted'); brief.id = 'leagueBrief';
  const controls = node('div', undefined, 'studio-team-form'), run = node('button', 'Simulate mini league', 'button'), cancel = node('button', 'Cancel league', 'button-secondary');
  run.type = 'submit'; run.id = 'leagueRun'; cancel.type = 'button'; cancel.hidden = true;
  controls.append(run, cancel); form.append(field, setup, more, brief, controls);
  const status = node('p'), results = node('div'); status.id = 'leagueStatus'; results.id = 'leagueResults'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const referenceControls = node('div', undefined, 'studio-team-form'), pin = node('button', 'Pin this league result', 'button-secondary'), clear = node('button', 'Clear league reference', 'button-secondary');
  pin.type = 'button'; clear.type = 'button'; pin.disabled = true; clear.hidden = true;
  const referenceStatus = node('p', 'No pinned league result. Run a season, then pin it before changing an assumption.', 'studio-muted');
  referenceStatus.id = 'leagueReferenceStatus'; referenceStatus.setAttribute('role', 'status');
  referenceControls.append(pin, clear); root.append(form, status, referenceControls, referenceStatus, results);
  const name = id => source?.teams.find(team => team.id === id)?.name || 'Unresolved slot';
  function busy(value) {
    form.querySelectorAll('input,select,button').forEach(input => { input.disabled = value; });
    cancel.disabled = false; cancel.hidden = !value; run.textContent = value ? 'Running league…' : 'Simulate mini league';
    pin.disabled = value || !currentReport; clear.disabled = value;
  }
  function describeSetup() {
    const games = 6 * Number(cycles.input.value), bracket = Number(playoffs.input.value);
    brief.textContent = `${games} scheduled games per season${bracket ? ` + up to ${(bracket - 1) * Number(length.input.value)} playoff games` : ''}. Four private team shards are read on the first run; later runs reuse compact samples.`;
  }
  function updateReference() {
    pin.disabled = !!active || !currentReport; pin.textContent = reference ? 'Replace pinned league result' : 'Pin this league result';
    clear.hidden = !reference;
    referenceStatus.textContent = reference ? `Pinned: ${reference.teams.map(row => name(row.team)).join(', ')} · ${reference.season}–${String(reference.season + 1).slice(-2)} · ${reference.settings.trials} seasons · Seed ${reference.seed}. Kept only until this page or evidence scope changes.`
      : 'No pinned league result. Run a season, then pin it before changing an assumption.';
  }
  form.addEventListener('input', () => {
    active?.abort(); generation++; currentReport = null; results.replaceChildren(); describeSetup();
    const ids = entrants.map(entrant => entrant.input.value);
    if (reference && (reference.season !== Number(season.input.value) || new Set(ids).size !== ids.length
      || reference.teams.some(row => !ids.includes(row.team)))) reference = null;
    updateReference(); status.textContent = 'Setup changed. Run again to update the standings.';
  });
  cancel.addEventListener('click', () => { active?.abort(); status.textContent = 'Cancelling league…'; });
  function renderComparison() {
    results.querySelector('[data-league-comparison]')?.remove();
    if (!reference || !currentReport) return;
    const report = compareLeagueScenarios(reference, currentReport), block = node('section', undefined, 'studio-panel'); block.dataset.leagueComparison = '';
    block.append(node('h3', 'What changed from the pinned league?'));
    if (report.identical) block.append(node('p', 'The teams, season, seed and all settings are unchanged. This is a repeat of the same experiment, not new independent evidence.'));
    else block.append(table('Changed assumptions only', ['Setting', 'Pinned', 'Current'], report.changes.map(row => [row.label, row.reference, row.current])));
    if (report.structureChanged) block.append(node('p', 'The schedule or postseason structure changed. Raw win totals or qualification/title frequencies may change because the competition rules changed; that does not demonstrate a stronger team.', 'studio-muted'));
    if (report.repetitionChanged) block.append(node('p', 'The seed or repetition count changed. Some differences may reflect simulation sampling, not a change in basketball assumptions.', 'studio-muted'));
    const difference = (metric, percent = true) => {
      const precision = percent ? 1 : 2;
      const value = number => number === null ? 'Not run' : `${number.toFixed(precision)}${percent ? '%' : ''}`;
      const rounded = metric.difference === null ? null : Number(metric.difference.toFixed(precision));
      const delta = rounded === null ? 'Not comparable' : `${rounded > 0 ? '+' : ''}${rounded.toFixed(precision)}${percent ? ' pp' : ' wins'}`;
      return `${value(metric.reference)} → ${value(metric.current)} (${delta})`;
    };
    block.append(table('Pinned → current; changes in wins or percentage points (pp)', ['Team', 'Average wins', 'Wins / scheduled games', 'Qualified', 'Won title'],
      report.teams.map(row => [name(row.team), difference(row.averageWins, false), difference(row.winShare), difference(row.qualified), difference(row.title)])));
    block.append(node('p', `Scheduled games per team: ${report.gamesPerTeam.reference} pinned → ${report.gamesPerTeam.current} current. Raw win changes are withheld if schedule lengths differ. Win share counts wins only; unresolved ties are not wins. Differences are computed before display rounding.`, 'studio-muted'), node('p', report.note, 'studio-muted'));
    results.append(block);
  }
  pin.addEventListener('click', () => { if (!currentReport || active) return; reference = captureLeagueSummary(currentReport); updateReference(); renderComparison(); });
  clear.addEventListener('click', () => { reference = null; updateReference(); renderComparison(); pin.focus(); });
  function render(report) {
    currentReport = captureLeagueSummary(report);
    const title = node('h3', !report.settings.playoffTeams ? 'The first mini-season is complete'
      : report.example.champion ? `${name(report.example.champion)} wins the first title draw` : 'The first title draw remains unresolved');
    title.tabIndex = -1; title.dataset.leagueResult = '';
    results.replaceChildren(title, node('p', `${report.settings.trials} repeated seasons · ${report.regularGamesPerExperiment} regular games each · ${report.gamesPlayed} total simulated games.`, 'studio-muted'));
    results.append(table('Standings from the first seeded season', ['Seed', 'Team', 'W–L–T', 'Point differential', 'Seeding lottery'],
      report.example.table.map(row => [row.seed, name(row.team), `${row.wins}–${row.losses}–${row.ties}`, row.differential, row.seedLottery ? 'Used' : 'Not needed'])));
    results.append(table('Repeated-season outcomes under these assumptions', ['Team', 'Average wins', 'Wins: 10th / median / 90th', 'Qualified', 'Won title'],
      report.teams.map(row => [name(row.team), row.averageWins.toFixed(1), [10, 50, 90].map(percent => row.winQuantiles[percent]).join(' / '),
        report.settings.playoffTeams ? percent(row.playoffAppearances, report.settings.trials) : 'Not run', row.titles === null ? 'Not run' : percent(row.titles, report.settings.trials)])));
    results.append(node('p', report.note, 'studio-muted'), node('p', 'These frequencies measure this chosen experiment only. Repetition does not validate the scoring assumptions or quantify real NBA forecast uncertainty.', 'studio-muted'));
    if (report.settings.playoffTeams) {
      results.append(node('p', `${report.unresolvedTitles}/${report.settings.trials} title draws remained unresolved after the overtime limit.`));
      const bracket = node('details', undefined, 'studio-panel'); bracket.append(node('summary', 'Follow the first playoff bracket'));
      bracket.append(table('First bracket', ['Round', 'Pairing', 'Series score', 'Winner'], report.example.bracket.map(series => [series.round,
        `${name(series.a)} / ${name(series.b)}`, `${series.winsA}–${series.winsB}`, series.winner ? name(series.winner) : 'Unresolved']))); results.append(bracket);
    }
    const distribution = node('details', undefined, 'studio-panel'); distribution.append(node('summary', 'Inspect seeding frequencies'));
    distribution.append(table('Seed frequencies; each column sums to 100%', ['Team', ...report.teams.map((_, index) => `Seed ${index + 1}`), 'Lottery used'],
      report.teams.map(row => [name(row.team), ...row.seeds.map(count => percent(count, report.settings.trials)), percent(row.seedLottery, report.settings.trials)]))); results.append(distribution);
    const schedule = node('details', undefined, 'studio-panel'); schedule.append(node('summary', 'Review the first schedule and scores'));
    schedule.append(table('Home/away are schedule labels only', ['Round', 'Home', 'Away', 'Score'], report.example.schedule.map(game => [game.round, name(game.home), name(game.away), `${game.scoreA}–${game.scoreB}`]))); results.append(schedule);
    results.append(node('p', `${report.modelVersion} / ${report.gameModelVersion} · ${report.season}–${String(report.season + 1).slice(-2)} · Seed ${report.seed} · ${report.snapshot}`, 'studio-muted studio-game-repro'));
    updateReference(); renderComparison(); title.focus();
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (active || !source) return;
    const ids = entrants.map(entrant => entrant.input.value);
    if (new Set(ids).size !== 4) { status.textContent = 'Choose four different franchises.'; return; }
    const own = new AbortController(), requestGeneration = ++generation; active = own; currentReport = null; busy(true); results.replaceChildren();
    try {
      roundRobinSchedule(ids, Number(cycles.input.value));
      const teams = [];
      for (const id of ids) {
        let payload = cache.get(id);
        if (!payload) {
          status.textContent = `Reading ${name(id)} (${teams.length + 1}/4). The first team read may take a moment.`;
          payload = await request('team-contexts', { team: id, snapshot: source.snapshot }, own.signal);
          if (own.signal.aborted || requestGeneration !== generation) throw new DOMException('Cancelled.', 'AbortError');
          if (payload.team !== id || payload.snapshot !== source.snapshot) throw new Error('League evidence changed. Refresh the checkpoint.');
          const evidence = teamGameEvidence(payload, Number(season.input.value));
          if (evidence.status !== 'ready') throw new Error(`${name(id)}: ${evidence.reason}`);
          cache.set(id, payload); if (cache.size > 4) cache.delete(cache.keys().next().value);
        }
        teams.push(payload);
      }
      const report = await simulateLeague({ teams, season: Number(season.input.value), seed: seed.value,
        trials: Number(trials.input.value), cycles: Number(cycles.input.value), playoffTeams: Number(playoffs.input.value),
        seriesLength: Number(length.input.value), possessions: Number(pace.input.value), attackWeight: Number(blend.input.value) },
      { signal: own.signal, onProgress: progress => { status.textContent = `Simulating seasons… ${Math.round(progress * 100)}%`; }, yieldEveryBatch: () => new Promise(resolve => setTimeout(resolve, 0)) });
      if (requestGeneration !== generation) return;
      render(report); status.textContent = 'Mini-league experiment complete. Change one assumption to explore a different season.';
    } catch (error) { if (requestGeneration === generation) status.textContent = error.name === 'AbortError' ? 'League cancelled. No partial champion was assigned.' : error.message; }
    finally { if (active === own) { active = null; busy(false); } }
  });
  return { setSource(value) {
    active?.abort(); active = null; generation++; reference = null; currentReport = null; cache.clear(); results.replaceChildren(); busy(false);
    source = value?.phase === 'ready' && value.teams?.length >= 4 ? value : null;
    entrants.forEach((entrant, index) => {
      entrant.input.replaceChildren(...(source?.teams || []).map(team => { const option = node('option', team.name); option.value = team.id; return option; }));
      if (source) entrant.input.value = source.teams[index].id;
    });
    run.disabled = !source; describeSetup(); updateReference(); status.textContent = source ? 'Choose four franchises. No team evidence loads until you run.' : 'Four teams from one validated Scout snapshot are required.';
  } };
}
