import { compareBlueprints, formatStudioValue as format, toggleStudioPlayer, validRoster } from './studio-model.js?v=20260906a';

const byId = id => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
let state = null, players = [], selected = [], loadedTeam = null, generation = 0, controller = null, busy = false;

function table(headers, rows, caption) {
  const block = el('div');
  // Keep the explanation outside the horizontally scrollable table so a
  // narrow-screen reader sees the complete qualification before the numbers.
  const explanation = el('p', caption, 'studio-muted');
  block.append(explanation);
  const wrap = el('div', undefined, 'studio-table-wrap');
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption);
  const node = el('table', undefined, 'studio-table');
  node.setAttribute('aria-label', caption);
  const head = el('thead'), header = el('tr');
  headers.forEach(label => { const cell = el('th', label); cell.scope = 'col'; header.append(cell); });
  head.append(header); node.append(head);
  const body = el('tbody');
  rows.forEach(row => { const tr = el('tr'); row.forEach((value, index) => {
    const cell = el(index === 0 ? 'th' : 'td', String(value));
    if (index === 0) cell.scope = 'row';
    tr.append(cell);
  }); body.append(tr); });
  node.append(body); wrap.append(node); block.append(wrap);
  block.append(el('p', 'On a narrow screen, scroll the table sideways to see every column.', 'studio-table-hint studio-muted'));
  return block;
}

function setBusy(value) {
  busy = value;
  byId('teamSelect').disabled = value;
  byId('loadTeam').disabled = value;
  byId('inspectChemistry').disabled = value || selected.length < 2;
  byId('clearSelection').disabled = value;
  document.querySelectorAll('#chemistryPlayers button').forEach(button => { button.disabled = value; });
}

function invalidate() {
  generation++; controller?.abort(); controller = null;
  players = []; selected = []; loadedTeam = null;
  byId('analysis').hidden = true; byId('blueprintContent').replaceChildren();
  byId('chemistryContent').replaceChildren(el('p', 'Select players to inspect this team’s observed shared-floor evidence.'));
  setBusy(false);
}

async function api(route, params = {}) {
  controller?.abort();
  const ownController = new AbortController(); controller = ownController;
  const timer = setTimeout(() => ownController.abort(), 90000);
  try {
    const response = await fetch(`/api/scout-studio/${route}?${new URLSearchParams(params)}`, {
      cache: 'no-store', credentials: 'omit', signal: ownController.signal,
    });
    if (!response.ok) throw new Error('Current-package evidence is not ready for this request. Refresh the checkpoint or retry after validation.');
    return await response.json();
  } finally { clearTimeout(timer); if (controller === ownController) controller = null; }
}

async function refresh() {
  invalidate();
  const request = generation;
  byId('workspace').hidden = true; byId('pendingPanel').hidden = false;
  byId('sourceTitle').textContent = 'Checking the incoming package…';
  byId('sourceMessage').textContent = 'Reading compact validation metadata only; this does not restart or re-fit Scout.';
  try {
    if (location.hostname !== '127.0.0.1') throw new Error('This is a local integration preview. Start the Scout Studio preview server to connect the incoming private package.');
    const result = await api('status');
    if (request !== generation) return;
    if (!['pending', 'blocked', 'ready'].includes(result.phase) || !Array.isArray(result.teams)) throw new Error('Unexpected preview contract. No evidence was loaded.');
    state = result;
    const ready = result.phase === 'ready';
    byId('sourceTitle').textContent = ready ? 'Validated for local integration review' : result.phase === 'blocked' ? 'Package validation needs attention' : 'Waiting for the current Scout build';
    byId('sourceMessage').textContent = ready
      ? `Choose a team below. ${result.warnings?.length || 0} validation warning(s) remain available in the private reports for review.`
      : result.phase === 'blocked' ? 'The supplied evidence did not clear the integration checks. Results remain unavailable; review the private validation reports.'
        : 'The completed four-season manifest and its matching validation report are not available yet. The older package will not be substituted.';
    const phaseLabels = { regular: 'regular season', in_season_tournament: 'in-season tournament', play_in: 'play-in', playoffs: 'playoffs' };
    byId('sourceScope').textContent = `${result.source?.aggregation || ''} ${ready ? `Included phases: ${(result.source?.phases || []).map(phase => phaseLabels[phase] || phase).join(', ')}.` : ''}`;
    byId('workspace').hidden = !ready; byId('pendingPanel').hidden = ready;
    byId('teamSelect').replaceChildren(...result.teams.map(team => {
      const option = el('option', team.name); option.value = team.id; return option;
    }));
    byId('workStatus').textContent = 'Select a team to begin. No team shards have been loaded.';
  } catch (error) {
    if (request !== generation) return;
    state = null; byId('sourceTitle').textContent = 'Local Scout connection unavailable';
    byId('sourceMessage').textContent = error.name === 'AbortError' ? 'The read timed out. You can refresh the checkpoint.' : error.message;
  }
}

function populatePlayers() {
  const options = () => players.map(player => { const option = el('option', player.name); option.value = player.id; return option; });
  byId('playerSelect').replaceChildren(...options());
  const none = el('option', 'No comparison'); none.value = '';
  byId('compareSelect').replaceChildren(none, ...options());
  byId('playerSearch').value = '';
  renderRoster(); renderBlueprint();
}

function renderBlueprint() {
  const player = players.find(player => player.id === byId('playerSelect').value);
  if (!player) return;
  if (byId('compareSelect').value === player.id) byId('compareSelect').value = '';
  for (const option of byId('compareSelect').options) option.disabled = option.value === player.id;
  const root = byId('blueprintContent'); root.replaceChildren();
  const sample = el('div', undefined, 'studio-sample');
  sample.append(el('h3', player.name), el('p', `${format(player.games)} observed appearances · ${format(player.minutes)} reconstructed minutes · ${format(player.estimatedTeamPossessions)} estimated team possessions`),
    el('p', `${player.coverage.note} Event-field coverage: ${player.coverage.statistics}. Independent box-score check: ${player.coverage.independentBoxScore === 'complete_and_reconciled' ? 'complete and reconciled' : 'not fully reconciled; do not use as verified workload targets'}.`, 'studio-muted'));
  root.append(sample);
  const metrics = el('div', undefined, 'studio-metrics');
  player.metrics.forEach(metric => {
    const card = el('article', undefined, 'studio-panel studio-metric');
    card.append(el('span', metric.family, 'studio-eyebrow'), el('h3', metric.label),
      el('strong', format(metric.value, metric.unit)),
      el('p', metric.unit === 'per100' ? 'per 100 estimated team possessions' : 'of recorded attempts'),
      el('p', `${format(metric.numerator)} / ${format(metric.denominator)} source count / denominator`));
    const details = el('details'); details.append(el('summary', 'Evidence & method'), el('p', metric.method));
    if (metric.status === 'unavailable') details.append(el('p', 'Missing coverage or a zero denominator prevents this metric from being shown.'));
    card.append(details); metrics.append(card);
  }); root.append(metrics);
  const compare = players.find(item => item.id === byId('compareSelect').value);
  if (compare) {
    const comparison = el('section', undefined, 'studio-panel'); comparison.append(el('h3', 'Side-by-side blueprint'));
    comparison.append(table(['Metric', player.name, compare.name, 'First minus second'], compareBlueprints(player, compare).map(row => {
      const difference = row.difference === null ? 'Unavailable' : `${row.difference > 0 ? '+' : ''}${row.unit === 'percent' ? `${(row.difference * 100).toFixed(1)} pp` : format(row.difference)}`;
      return [row.label, format(row.first, row.unit), format(row.second, row.unit), difference];
    }), 'Same team and pooled package window. Differences describe production, not player quality. pp = percentage points.'));
    root.append(comparison);
  }
  const tendency = el('section', undefined, 'studio-panel'); tendency.append(el('h3', 'Shot tendency map'));
  const shots = player.tendencies;
  tendency.append(table(['Recorded zone', 'Attempts', 'Share of all attempts', 'Accuracy'], shots.zones.map(zone => [zone.label, format(zone.attempts), format(zone.shareOfAllAttempts, 'percent'), format(zone.accuracy, 'percent')]), shots.note));
  tendency.append(el('p', `${format(shots.fieldGoalAttempts)} total attempts · ${format(shots.threePointAttempts)} threes · ${format(shots.unlocatedTwoPointAttempts)} twos with unlocated distance · ${format(shots.unclassifiedAttempts)} unclassified shot values.`, 'studio-muted'));
  tendency.append(el('h3', 'Optional provider shot labels'));
  if (shots.labels.length) tendency.append(table(['Label', 'Attempts', 'Share of all attempts', 'Accuracy'], shots.labels.map(label => [label.label, format(label.attempts), format(label.shareOfAllAttempts, 'percent'), format(label.accuracy, 'percent')]), 'Labels are recorded shot descriptions, not verified tactical play types.'));
  else tendency.append(el('p', 'No usable shot-description labels are available in this sample.'));
  tendency.append(el('p', `${format(shots.missingShotDescriptions)} attempts have no shot description. Missing labels are not reallocated to known categories.`, 'studio-muted'));
  root.append(tendency);
}

function renderRoster() {
  const filter = byId('playerSearch').value.trim().toLowerCase();
  const buttons = players.map(player => {
    const button = el('button', player.name); button.type = 'button';
    button.hidden = !player.name.toLowerCase().includes(filter);
    button.setAttribute('aria-pressed', String(selected.includes(player.id))); button.disabled = busy;
    button.addEventListener('click', () => {
      if (busy) return;
      const next = toggleStudioPlayer(selected, player.id);
      if (next === selected) { byId('selectionStatus').textContent = 'Five selected. Deselect a player before adding another.'; return; }
      selected = next;
      byId('chemistryContent').replaceChildren(el('p', 'Selection changed. Inspect shared floor to load this exact group.'));
      // Update in place so keyboard focus remains on the toggled player.
      button.setAttribute('aria-pressed', String(selected.includes(player.id)));
      byId('selectionStatus').textContent = `${selected.length} of 5 selected`;
      byId('inspectChemistry').disabled = selected.length < 2;
    }); return button;
  });
  byId('chemistryPlayers').replaceChildren(...buttons);
  byId('selectionStatus').textContent = `${selected.length} of 5 selected`;
  byId('inspectChemistry').disabled = busy || selected.length < 2;
}

function sampleRows(samples) {
  return samples.map(sample => [sample.label, format(sample.offensePossessions), format(sample.defensePossessions),
    format(sample.offensiveRating), format(sample.defensiveRating), format(sample.netRating),
    sample.interval ? `${format(sample.interval.lower)} to ${format(sample.interval.upper)}` : 'Unavailable']);
}

byId('refreshSource').addEventListener('click', refresh);
byId('teamSelect').addEventListener('change', () => { invalidate(); byId('workStatus').textContent = 'Team changed. Load its evidence before comparing players.'; });
byId('teamForm').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || state?.phase !== 'ready') return;
  invalidate(); const request = generation, team = byId('teamSelect').value;
  setBusy(true); byId('workStatus').textContent = 'Verifying and streaming one team shard. Large samples may take a moment; only compact views are retained.';
  try {
    const result = await api('roster', { team, snapshot: state.snapshot });
    if (request !== generation) return;
    if (!validRoster(result, state.snapshot, team)) throw new Error('The roster does not match this package selection. Refresh the checkpoint.');
    players = result.players; loadedTeam = team;
    populatePlayers(); byId('analysis').hidden = false;
    byId('workStatus').textContent = `${players.length} source player profiles loaded. All metrics use the full pooled team sample, not just the latest season.`;
  } catch (error) { if (request === generation) byId('workStatus').textContent = error.name === 'AbortError' ? 'The team read timed out. Retry when the package is ready.' : error.message; }
  finally { if (request === generation) setBusy(false); }
});
byId('playerSelect').addEventListener('change', renderBlueprint);
byId('compareSelect').addEventListener('change', renderBlueprint);
byId('playerSearch').addEventListener('input', renderRoster);
byId('clearSelection').addEventListener('click', () => { selected = []; renderRoster(); byId('chemistryContent').replaceChildren(el('p', 'Selection cleared.')); });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  byId('blueprintPanel').hidden = button.dataset.mode !== 'blueprint';
  byId('chemistryPanel').hidden = button.dataset.mode !== 'chemistry';
}));
byId('inspectChemistry').addEventListener('click', async () => {
  if (busy || selected.length < 2) return;
  const request = ++generation, selection = [...selected]; setBusy(true);
  const root = byId('chemistryContent'); root.replaceChildren(el('p', 'Reading the selected shared-floor sample…'));
  try {
    const result = await api('chemistry', { team: loadedTeam, snapshot: state.snapshot, players: selection.join(',') });
    if (request !== generation) return;
    if (result.snapshot !== state.snapshot || JSON.stringify(result.selection) !== JSON.stringify(selection)) throw new Error('Selection changed. Inspect this group again.');
    root.replaceChildren(el('h3', selection.map(id => players.find(player => player.id === id).name).join(' + ')));
    if (!result.combination) root.append(el('p', 'No observed combination in this team sample. This does not establish poor chemistry; no unseen-lineup result is invented.'));
    else {
      const sample = result.combination.sample;
      root.append(el('p', result.combination.note));
      root.append(el('p', `${format(result.combination.minutes)} reconstructed minutes · ${format(sample.games)} observed games. Status: ${sample.status.replaceAll('_', ' ')}.`, 'studio-muted'));
      root.append(table(['Sample', 'Off. poss.', 'Def. poss.', 'ORtg', 'DRtg', 'Net', 'Approx. 95% interval'], sampleRows([{ label: 'Selected group', ...sample }]), 'Rates per 100 possessions. Approximate descriptive intervals do not account for all possession dependence.'));
      if (sample.status !== 'observed') root.append(el('p', `Ratings are withheld below the package sample gate (${format(sample.minimumCombinedPossessions)} combined possessions) or when a side has no exposure.`));
    }
    if (result.wowy?.length) root.append(table(['Together / apart', 'Off. poss.', 'Def. poss.', 'ORtg', 'DRtg', 'Net', 'Approx. 95% interval'], sampleRows(result.wowy), 'Same-game WOWY partitions. Different teammates, opponents and situations can explain these differences.'));
    else if (selection.length === 2) root.append(el('p', 'No four-cell together/apart record is available for this pair.'));
    root.append(el('p', result.note, 'studio-muted'));
  } catch (error) { if (request === generation) root.replaceChildren(el('p', error.name === 'AbortError' ? 'Read timed out. Retry this selection.' : error.message)); }
  finally { if (request === generation) setBusy(false); }
});
refresh();
