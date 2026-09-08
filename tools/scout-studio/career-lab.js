import { formatStudioValue as format } from './studio-model.js?v=20260906a';
import { buildCareerTimeline, summarizeCareer, replayObservedCareer, CAREER_POLICY } from './career-simulator.js?v=20260907f';

const node = (tag, text, className = '') => {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
  if (className) element.className = className; return element;
};
const seasonLabel = year => `${year}–${String(year + 1).slice(-2)}`;
const percent = value => value === null || value === undefined ? 'Unavailable' : `${(value * 100).toFixed(1)}%`;

function table(title, headers, rows) {
  const block = node('div'), wrap = node('div', undefined, 'studio-table-wrap'), table = node('table', undefined, 'studio-table');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', title);
  table.append(node('caption', title));
  const head = node('thead'), heading = node('tr'); headers.forEach(label => { const cell = node('th', label); cell.scope = 'col'; heading.append(cell); }); head.append(heading);
  const body = node('tbody'); rows.forEach(row => { const tr = node('tr'); row.forEach((value, index) => { const cell = node(index ? 'td' : 'th', String(value)); if (!index) cell.scope = 'row'; tr.append(cell); }); body.append(tr); });
  table.append(head, body); wrap.append(table); block.append(wrap, node('p', 'Scroll tables sideways on narrow screens.', 'studio-table-hint studio-muted')); return block;
}

function numberInput(labelText, id, value, min, max, step = 1) {
  const label = node('label', labelText), input = node('input');
  Object.assign(input, { id, type: 'number', value, min, max, step, required: true }); label.append(input); return { label, input };
}

export function createCareerLab(root, request) {
  let source = null, roster = null, active = null, generation = 0, timeline = null, summary = null;
  const heading = node('h2', 'Career Lab'); heading.id = 'careerLabTitle';
  root.append(heading,
    node('p', 'Trace the selected player’s observed seasons, team changes, phases and production. Then replay those observed seasons to see how the supplied history varies under resampling.'),
    node('p', 'This is an evidence timeline and descriptive replay. It does not estimate aging, future availability, role development, contracts or a future career outcome.', 'studio-muted'));
  const form = node('form'), controls = node('div', undefined, 'studio-roadmap');
  const playerLabel = node('label', 'Player'); const player = node('select'); player.id = 'careerPlayerSelect'; playerLabel.append(player);
  const trials = numberInput('Replay trials', 'careerTrials', 100, CAREER_POLICY.minTrials, CAREER_POLICY.maxTrials, 50);
  const seedLabel = node('label', 'Replay seed'); const seed = node('input'); Object.assign(seed, { id: 'careerSeed', type: 'text', value: 'career-replay', maxLength: 80, pattern: '[a-zA-Z0-9:._\\-]+' }); seedLabel.append(seed);
  controls.append(playerLabel, trials.label, seedLabel);
  const buttons = node('div', undefined, 'studio-team-form');
  const load = node('button', 'Load observed career', 'button'); load.type = 'submit'; load.id = 'careerLoad';
  const replay = node('button', 'Replay observed seasons', 'button-secondary'); replay.type = 'button'; replay.id = 'careerReplay'; replay.disabled = true;
  buttons.append(load, replay); form.append(controls, buttons); root.append(form);
  const status = node('p'); status.id = 'careerStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const results = node('div'); results.id = 'careerResults'; root.append(status, results);

  function clear() { active?.abort(); generation++; timeline = null; summary = null; replay.disabled = true; results.replaceChildren(); }
  function busy(value) { form.querySelectorAll('input,select,button').forEach(control => { control.disabled = value; }); if (!value) replay.disabled = !timeline; }
  function renderReplay(report) {
    const panel = node('section', undefined, 'studio-panel'); panel.dataset.careerReplay = '';
    panel.append(node('h3', `${format(report.trials)} observed-career replays`),
      node('p', `Each replay samples ${report.targetSeasons} observed seasons with replacement. The seed is ${report.seed}.`, 'studio-muted'));
    panel.append(table('Observed replay ranges', ['Measure', '10th percentile', 'Median', '90th percentile', 'Complete trials'],
      Object.entries(report.metrics).filter(([key]) => ['games', 'minutes', 'points', 'assists', 'rebounds'].includes(key)).map(([key, value]) => [
        key === 'games' ? 'Games' : key === 'minutes' ? 'Minutes' : `${key[0].toUpperCase()}${key.slice(1)} total`,
        format(value.quantiles?.[10]), format(value.quantiles?.[50]), format(value.quantiles?.[90]), `${format(value.completeTrials)} / ${report.trials}`,
      ]), report.note));
    panel.append(node('p', report.note, 'studio-muted')); return panel;
  }
  function render() {
    if (!timeline || !summary) return;
    const title = node('h3', `${timeline.observedRows.length} observed seasons · ${timeline.gapRows.length} visible gaps`); title.dataset.careerResult = '';
    const panel = node('section', undefined, 'studio-panel'); panel.append(title,
      node('p', `${summary.teams.length} observed team label${summary.teams.length === 1 ? '' : 's'} · ${summary.teamChanges} team-set change${summary.teamChanges === 1 ? '' : 's'} · ${summary.roleChanges} listed-position change${summary.roleChanges === 1 ? '' : 's'}.`, 'studio-muted'));
    const cards = node('div', undefined, 'studio-roadmap');
    for (const [label, value] of [['Observed games', summary.totals.games ?? timeline.observedRows.reduce((sum, row) => sum + row.games, 0)], ['Observed minutes', summary.totals.minutes ?? timeline.observedRows.reduce((sum, row) => sum + row.minutes, 0)], ['Observed points', summary.totals.points], ['Peak points / game', summary.peakScoringSeason?.perGame]]) {
      const card = node('article'); card.append(node('h4', label), node('strong', format(value)), node('p', label === 'Peak points / game' && summary.peakScoringSeason ? summary.peakScoringSeason.season : 'Observed sample')); cards.append(card);
    }
    panel.append(cards,
      table('Observed season timeline', ['Season', 'Status', 'Recorded teams', 'Phases', 'Games', 'Minutes', 'PPG', 'APG', 'RPG', 'FG%', '3P%', 'FT%', 'Positions'], timeline.rows.map(row => [
        row.season, row.gap ? 'Gap' : 'Observed', row.teams.join(', ') || 'No observed team', row.phases.join(', ') || '—',
        format(row.games), format(row.minutes), format(row.perGame.points), format(row.perGame.assists), format(row.perGame.rebounds),
        percent(row.shooting?.fieldGoalPercentage), percent(row.shooting?.threePointPercentage), percent(row.shooting?.freeThrowPercentage), row.positions.join(', ') || 'Unavailable',
      ]), timeline.note));
    panel.append(node('p', 'A gap means no season row was supplied for that year. It is not a zero season. Regular, tournament, play-in and playoff rows remain identified in the phase column.', 'studio-muted'));
    results.replaceChildren(panel);
  }
  async function loadCareer() {
    if (!source || !roster || !player.value || active) return;
    const run = ++generation, controller = new AbortController(); active = controller; busy(true); results.replaceChildren(); status.textContent = 'Reading observed season profiles…';
    try {
      const payload = await request('player-seasons', { team: roster.team, snapshot: source.snapshot, player: player.value }, controller.signal);
      if (run !== generation || controller.signal.aborted) return;
      timeline = buildCareerTimeline(payload.profiles, { seasonStartYears: source.source?.seasonStartYears || source.seasonStartYears });
      summary = summarizeCareer(timeline); render(); replay.disabled = false; status.textContent = 'Observed career loaded. You can replay the same history or change the player.';
    } catch (error) { if (run === generation) status.textContent = error.name === 'AbortError' ? 'Career read cancelled. Try again.' : error.message; }
    finally { if (active === controller) { active = null; busy(false); } }
  }
  form.addEventListener('submit', event => { event.preventDefault(); loadCareer(); });
  player.addEventListener('change', () => { clear(); status.textContent = 'Player changed. Load the observed career for this player.'; });
  replay.addEventListener('click', () => {
    if (!timeline) return;
    try { const report = replayObservedCareer(timeline, { trials: Number(trials.input.value), seed: seed.value });
      const existing = results.querySelector('[data-career-replay]'); existing?.remove(); results.append(renderReplay(report)); status.textContent = 'Observed replay complete. Its ranges describe this supplied history, not a future forecast.'; }
    catch (error) { status.textContent = error.message; }
  });
  return { setRoster(value, sourceValue) {
    active?.abort(); active = null; generation++; clear(); roster = value; source = sourceValue?.phase === 'ready' ? sourceValue : null;
    player.replaceChildren(...(roster?.players || []).map(item => { const option = node('option', item.name); option.value = item.id; return option; }));
    load.disabled = !roster || !source; status.textContent = roster && source ? 'Choose a player and load observed season profiles.' : 'A loaded team and validated Scout snapshot are required.';
  } };
}

