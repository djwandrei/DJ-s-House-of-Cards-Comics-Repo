import { formatStudioValue as format, toggleStudioPlayer, validRoster } from './studio-model.js?v=20260906a';
import { buildBlueprint, comparePlayerEvidence, analyzeChemistry, FORGE_BLOCKS, createForgeRecipe, buildComposite, explainForgeChange } from './studio-analysis.js?v=20260906a';
import { loadForgeDraft, saveForgeDraft, clearForgeDraft } from './forge-state.js?v=20260906a';
import { findPlayerStyleMatches, findCompositeStyleMatches } from './style-matches.js?v=20260907b';
import { analyzePlayerContextLens, analyzeGroupContextLens } from './context-lens.js?v=20260907d';
import { createGameLab } from './game-lab.js?v=20260907d';
import { createLeagueLab } from './league-lab.js?v=20260907e';
import { createCareerLab } from './career-lab.js?v=20260907f';
import { SEASON_FORGE_BLOCKS, createSeasonForgeRecipe, buildSeasonComposite, seasonProfileLabel, validateSeasonDonorProfiles } from './season-composite.js?v=20260907f';
import { captureChemistry, compareChemistry, compareForgeRecipes, inspectForgeDependencies, BLUEPRINT_QUESTIONS } from './workbench-comparisons.js?v=20260907e';

const byId = id => document.getElementById(id);
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
let state = null, players = [], selected = [], loadedTeam = null, generation = 0, busy = false;
const controllers = new Set();
let mode = 'blueprint';
let roster = null, recipe = null;
let recipeHistory = [];
let referenceRecipe = null, referenceChemistry = null;
let seasonDonorProfiles = null, seasonForgeRecipe = null, seasonForgeBaseline = '';
const contextCache = new Map();
const gameLab = createGameLab(byId('gamePanel'), api);
const leagueLab = createLeagueLab(byId('leaguePanel'), api);
const careerLab = createCareerLab(byId('careerPanel'), api);
const statusLabel = status => status.replaceAll('_', ' ');
const differenceLabel = (value, unit) => value === null ? 'Unavailable' : `${value > 0 ? '+' : ''}${unit === 'percent' ? `${(value * 100).toFixed(1)} pp` : format(value)}`;
function browserStorage() { try { return window.localStorage; } catch { return null; } }

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

function styleMatchesPanel(report, mode) {
  const section = el('details', undefined, 'studio-panel');
  section.dataset.styleMatches = mode;
  section.append(el('summary', 'Find nearby observed profiles'));
  section.append(el('p', report.reason, 'studio-muted'));
  if (report.status !== 'ready') return section;
  section.append(el('p', `${report.eligible}/${report.candidates} candidate profiles support this fixed basis of ${report.components.length} varying components. Lower distance means closer recorded components, not a better player.`, 'studio-muted'));
  section.append(el('p', report.note, 'studio-muted'));
  if (mode === 'forge') section.append(el('p', 'A donor may appear because its components were copied into the recipe. That is expected by construction, not validation of the composite. Comparison buttons change only the baseline, not your donors.'));
  const cards = el('div', undefined, 'studio-roadmap');
  report.matches.forEach(match => {
    const card = el('article');
    card.append(el('h4', `${match.rank}. ${match.name}`));
    const gaps = [...match.gaps].sort((a, b) => a.normalizedGap - b.normalizedGap || a.key.localeCompare(b.key));
    card.append(el('p', `Closest components: ${gaps.slice(0, 2).map(gap => gap.label.toLowerCase()).join(', ')}.`));
    const largest = gaps[gaps.length - 1];
    card.append(el('p', `Largest normalized gap: ${largest.label}. Target minus this profile: ${differenceLabel(largest.difference, largest.unit)}${largest.unit === 'per100' ? ' per 100 estimated possessions' : ''}.`));
    if (match.donorBlocks.length) card.append(el('p', `Recipe donor: ${match.donorBlocks.join(', ')}.`, 'studio-muted'));
    if (match.unreconciledComponents) card.append(el('p', `${match.unreconciledComponents} compared components have a target or candidate without complete independent box-score reconciliation.`, 'studio-muted'));
    const compare = el('button', `Compare with ${match.name}`, 'button-secondary'); compare.type = 'button';
    compare.dataset.styleCandidate = match.id;
    compare.addEventListener('click', () => {
      byId(mode === 'forge' ? 'forgeBaseline' : 'compareSelect').value = match.id;
      if (mode === 'forge') renderForge(); else renderBlueprint();
      const heading = byId(mode === 'forge' ? 'forgeContent' : 'blueprintContent').querySelector(mode === 'forge' ? 'h3' : '[data-blueprint-comparison]');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    });
    card.append(compare); cards.append(card);
  });
  section.append(cards);
  if (report.omitted.length) section.append(el('p', `Not used to order profiles: ${report.omitted.map(item => `${item.label} (${statusLabel(item.reason)})`).join('; ')}.`, 'studio-muted'));
  if (report.outsideCohortRange.length) section.append(el('p', `Target outside the comparison cohort’s recorded range: ${report.outsideCohortRange.join(', ')}. This does not establish exceptional talent or physical feasibility.`, 'studio-muted'));
  const method = el('details'); method.append(el('summary', 'How proximity is calculated'), el('p', report.method)); section.append(method);
  return section;
}

const contextGroupLabels = Object.freeze({ all: 'All groups', season: 'Season', phase: 'Competition phase', venue: 'Venue',
  period: 'Period', half: 'Half', window: 'Recent window', game_state: 'Game state', transition: 'Transition label',
  score_state: 'Score state', competition: 'Competition proxy', leverage: 'Leverage proxy' });

function contextFilter(report, onChange) {
  const label = el('label', 'Show context group');
  const select = el('select');
  const all = el('option', 'All groups'); all.value = 'all'; select.append(all);
  report.groups.filter(group => group !== 'all').forEach(group => { const option = el('option', contextGroupLabels[group] || group); option.value = group; select.append(option); });
  select.addEventListener('change', () => onChange(select.value)); label.append(select); return label;
}

function renderPlayerContextTable(report, filter = 'all') {
  const rows = report.rows.filter(row => filter === 'all' || row.group === filter);
  const possessions = sample => Number.isFinite(sample?.offensePossessions) && Number.isFinite(sample?.defensePossessions)
    ? sample.offensePossessions + sample.defensePossessions : null;
  return table(['Context', 'On status', 'On net rating', 'Off status', 'Off net rating', 'On − off net', 'On possessions', 'Off possessions', 'Games on / off'],
    rows.map(row => [row.label, statusLabel(row.on.status), format(row.on.netRating), statusLabel(row.off.status), format(row.off.netRating),
      differenceLabel(row.difference.netRating), format(possessions(row.on)), format(possessions(row.off)),
      `${format(row.on.games)} / ${format(row.off.games)}`]),
    'On/off context splits use the same-game player-appearance sample. A net difference is shown only when both sides pass the package observation gate.');
}

function renderGroupContextTable(report, filter = 'all') {
  const rows = report.rows.filter(row => filter === 'all' || row.group === filter);
  return table(['Context', 'Status', 'Games', 'Offensive possessions', 'Defensive possessions', 'Offensive rating', 'Defensive rating', 'Net rating', 'Net vs all'],
    rows.map(row => [row.label, statusLabel(row.status), format(row.games), format(row.offensePossessions), format(row.defensePossessions),
      format(row.offensiveRating), format(row.defensiveRating), format(row.netRating), differenceLabel(row.differenceFromAll?.netRating)]),
    'Context rows are observed splits of the selected group. Net vs all is descriptive and is not a causal chemistry effect or a forecast.');
}

function renderPlayerContextBody(root, report) {
  if (!report.rows.length) { root.replaceChildren(el('p', 'No context evidence is available for this player.')); return; }
  root.replaceChildren(el('p', `${report.rows.length} context rows are available for ${report.player.name}. On and off samples retain their own possession counts; no rate is pooled across contexts.`, 'studio-muted'));
  let filter = 'all'; const tableRoot = el('div');
  root.append(contextFilter(report, value => { filter = value; tableRoot.replaceChildren(renderPlayerContextTable(report, filter)); }), tableRoot);
  tableRoot.replaceChildren(renderPlayerContextTable(report));
  root.append(el('p', report.note, 'studio-muted'));
}

function renderGroupContextPanel(combination) {
  const report = analyzeGroupContextLens(combination?.contexts || []);
  const section = el('details', undefined, 'studio-panel'); section.dataset.contextLens = 'group';
  section.append(el('summary', 'Inspect season and game-context splits'));
  if (!report.rows.length) { section.append(el('p', 'No context splits are available for this observed group.', 'studio-muted')); return section; }
  section.append(el('p', `${report.rows.length} context rows are available. The all-sample row is the comparison baseline; missing or below-gate rates stay unavailable.`, 'studio-muted'));
  let filter = 'all'; const tableRoot = el('div');
  section.append(contextFilter(report, value => { filter = value; tableRoot.replaceChildren(renderGroupContextTable(report, filter)); }), tableRoot);
  tableRoot.replaceChildren(renderGroupContextTable(report)); section.append(el('p', report.note, 'studio-muted')); return section;
}

function contextLensPanel(player) {
  const section = el('details', undefined, 'studio-panel'); section.dataset.contextLens = 'player';
  section.append(el('summary', 'Inspect season and game-context splits'));
  section.append(el('p', 'Load observed on/off rows for the selected player. These splits help frame a question about role or environment; they do not identify a causal player effect.', 'studio-muted'));
  const button = el('button', 'Load context splits', 'button-secondary'); button.type = 'button';
  const body = el('div'); body.setAttribute('aria-live', 'polite'); body.hidden = true;
  button.addEventListener('click', async () => {
    body.hidden = false;
    if (contextCache.has(player.id)) { renderPlayerContextBody(body, contextCache.get(player.id)); return; }
    button.disabled = true; body.replaceChildren(el('p', 'Reading the selected player’s bounded context rows…'));
    const request = generation, selectedId = player.id;
    try {
      const payload = await api('player-contexts', { team: loadedTeam, snapshot: state.snapshot, player: selectedId });
      if (request !== generation || byId('playerSelect').value !== selectedId) return;
      const report = analyzePlayerContextLens(roster, selectedId, payload);
      contextCache.set(selectedId, report); renderPlayerContextBody(body, report);
    } catch (error) {
      if (request === generation) body.replaceChildren(el('p', error.name === 'AbortError' ? 'Read timed out. Retry this context lens.' : error.message));
    } finally { if (button.isConnected) button.disabled = false; }
  });
  section.append(button, body); return section;
}

function seasonProfilePanel(player) {
  const section = el('details', undefined, 'studio-panel');
  section.dataset.seasonProfiles = player.id;
  section.append(el('summary', 'Inspect season and phase history'));
  section.append(el('p', 'Load observed season-by-season production from the selected v2 Scout evidence package. Missing seasons remain blank; this history is not a career forecast.', 'studio-muted'));
  const button = el('button', 'Load season history', 'button-secondary'); button.type = 'button';
  const body = el('div'); body.hidden = true; body.setAttribute('aria-live', 'polite');
  button.addEventListener('click', async () => {
    body.hidden = false; button.disabled = true; body.replaceChildren(el('p', 'Reading bounded season profiles…'));
    try {
      const result = await api('player-seasons', { team: loadedTeam, snapshot: state.snapshot, player: player.id });
      const profiles = Array.isArray(result.profiles) ? result.profiles : [];
      body.replaceChildren(profiles.length
        ? table(['Season', 'Phase', 'Team', 'Games', 'Minutes', 'PPG', 'APG', 'RPG', 'FG%', '3P%', 'FT%', 'Involvement / 36'], profiles.map(profile => [
          profile.season, profile.phase || 'Unknown phase', profile.team || 'Unknown team', format(profile.games), format(profile.minutes),
          format(profile.perGame?.points), format(profile.perGame?.assists), format(profile.perGame?.rebounds),
          format(profile.shooting?.fieldGoalPercentage, 'percent'), format(profile.shooting?.threePointPercentage, 'percent'),
          format(profile.shooting?.freeThrowPercentage, 'percent'), format(profile.involvement),
        ]), 'Each row is an observed season/phase sample. Percentages use only fields that passed their own evidence checks.')
        : el('p', 'No additive season profiles are available in the selected package. The pooled player blueprint remains available.', 'studio-muted'));
      if (result.note) body.append(el('p', result.note, 'studio-muted'));
    } catch (error) { body.replaceChildren(el('p', error.message, 'studio-muted')); }
  });
  section.append(button, body); return section;
}

function invalidate() {
  generation++; controllers.forEach(controller => controller.abort()); controllers.clear();
  players = []; selected = []; loadedTeam = null; roster = null; recipe = null;
  contextCache.clear();
  seasonDonorProfiles = null; seasonForgeRecipe = null; seasonForgeBaseline = '';
  referenceRecipe = null; referenceChemistry = null;
  recipeHistory = []; byId('forgeUndo').disabled = true; byId('forgeChange').replaceChildren();
  byId('forgeContent').replaceChildren(); byId('forgeDonors').replaceChildren(); byId('forgeStatus').textContent = '';
  renderSeasonForge(); careerLab.setRoster(null, null);
  byId('analysis').hidden = true; byId('blueprintContent').replaceChildren();
  byId('chemistryContent').replaceChildren(el('p', 'Select players to inspect this team’s observed shared-floor evidence.'));
  setBusy(false);
}

async function api(route, params = {}, signal) {
  const ownController = new AbortController(); controllers.add(ownController);
  const abort = () => ownController.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => ownController.abort(), 90000);
  try {
    const response = await fetch(`/api/scout-studio/${route}?${new URLSearchParams(params)}`, {
      cache: 'no-store', credentials: 'omit', signal: ownController.signal,
    });
    if (!response.ok) throw new Error('Current-package evidence is not ready for this request. Refresh the checkpoint or retry after validation.');
    return await response.json();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controllers.delete(ownController); }
}

async function refresh() {
  invalidate();
  gameLab.setSource(null);
  leagueLab.setSource(null);
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
    gameLab.setSource(result);
    leagueLab.setSource(result);
    const ready = result.phase === 'ready';
    byId('sourceTitle').textContent = ready ? 'Validated for local integration review' : result.phase === 'blocked' ? 'Package validation needs attention' : 'Waiting for the current Scout build';
    byId('sourceMessage').textContent = ready
      ? `Choose a team below. ${result.warnings?.length || 0} validation warning(s) remain available in the private reports for review.`
      : result.phase === 'blocked' ? 'The supplied evidence did not clear the integration checks. Results remain unavailable; review the private validation reports.'
        : 'The selected manifest and its matching validation reports are not available yet. Check the selected package paths.';
    byId('studioSeasonScope').textContent = result.source?.seasons?.length
      ? `${result.source.seasons[0]} → ${result.source.seasons.at(-1)}` : 'Selected Scout window';
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
  renderRoster(); renderBlueprint(); populateForge();
}

function renderBlueprint() {
  const player = players.find(player => player.id === byId('playerSelect').value);
  if (!player) return;
  const blueprint = buildBlueprint(roster, player.id);
  const question = BLUEPRINT_QUESTIONS[byId('blueprintQuestion').value] || BLUEPRINT_QUESTIONS.all;
  const showMetric = metric => !question.keys || question.keys.includes(metric.key);
  if (byId('compareSelect').value === player.id) byId('compareSelect').value = '';
  for (const option of byId('compareSelect').options) option.disabled = option.value === player.id;
  const root = byId('blueprintContent'); root.replaceChildren(el('p', question.note, 'studio-muted'));
  const sample = el('div', undefined, 'studio-sample');
  sample.append(el('h3', player.name), el('p', `${format(player.games)} observed appearances · ${format(player.minutes)} reconstructed minutes · ${format(player.estimatedTeamPossessions)} estimated team possessions`),
    el('p', `${player.coverage.note} Event-field coverage: ${player.coverage.statistics}. Independent box-score check: ${player.coverage.independentBoxScore === 'complete_and_reconciled' ? 'complete and reconciled' : 'not fully reconciled; do not use as verified workload targets'}.`, 'studio-muted'));
  sample.append(el('p', blueprint.note, 'studio-muted'));
  root.append(sample, styleMatchesPanel(findPlayerStyleMatches(roster, player.id), 'blueprint'), contextLensPanel(player), seasonProfilePanel(player));
  const metrics = el('div', undefined, 'studio-metrics');
  blueprint.components.filter(showMetric).forEach(evidence => {
    const matches = player.metrics.filter(item => item.key === evidence.key);
    const metric = matches.length === 1 ? matches[0] : null;
    const card = el('article', undefined, 'studio-panel studio-metric');
    card.append(el('span', metric?.family || 'Recorded component', 'studio-eyebrow'), el('h3', evidence.label),
      el('strong', format(evidence.value, evidence.unit)),
      el('p', evidence.unit === 'per100' ? 'Rate per 100 estimated team possessions' : 'Share of recorded attempts'),
      el('p', `${format(evidence.numerator)} / ${format(evidence.denominator)} observed numerator / denominator`));
    const details = el('details'); details.append(el('summary', 'How this number is built'), el('p', metric?.method || 'No unique source component is available.'));
    if (evidence.status === 'unavailable') details.append(el('p', 'Missing or inconsistent coverage prevents this metric from being shown.'));
    details.append(el('p', `${statusLabel(evidence.status)}: ${evidence.reason}`));
    card.append(el('p', `Other-player median: ${format(evidence.cohort.median, evidence.unit)} (${evidence.cohort.eligible}/${evidence.cohort.candidates} eligible). Difference: ${differenceLabel(evidence.cohort.difference, evidence.unit)}.`));
    card.append(details); metrics.append(card);
  }); root.append(metrics);
  const compare = players.find(item => item.id === byId('compareSelect').value);
  if (compare) {
    const comparison = el('section', undefined, 'studio-panel');
    const heading = el('h3', 'Side-by-side blueprint'); heading.dataset.blueprintComparison = ''; comparison.append(heading);
    comparison.append(table(['Metric', player.name, compare.name, 'First minus second', 'Sample review'], comparePlayerEvidence(roster, player.id, compare.id).filter(showMetric).map(row =>
      [row.label, format(row.first.value, row.unit), format(row.second.value, row.unit), differenceLabel(row.difference, row.unit),
        `${statusLabel(row.first.status)} / ${statusLabel(row.second.status)}`]
    ), 'Same team and pooled window; different games, roles and opponents may contribute. Differences require 25 attempts or 200 estimated possessions on both sides. These review thresholds are not talent cutoffs. pp = percentage points.'));
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

function seasonForgeProfileOptions(profiles, selected = '') {
  const empty = el('option', 'Choose an observed season row'); empty.value = '';
  const options = profiles.map(profile => {
    const option = el('option', seasonProfileLabel(profile)); option.value = profile.key; option.selected = profile.key === selected; return option;
  });
  return [empty, ...options];
}

function renderSeasonForge() {
  const root = byId('seasonForgeContent'); if (!root) return;
  root.replaceChildren();
  if (!seasonDonorProfiles) {
    root.append(el('p', 'Load the bounded season donor catalog after loading a team. It includes observed team rows and all-team aggregates for that roster; missing seasons stay unavailable.', 'studio-muted'));
    return;
  }
  try { validateSeasonDonorProfiles(seasonDonorProfiles); } catch (error) { root.append(el('p', error.message, 'studio-muted')); return; }
  if (!seasonDonorProfiles.length) { root.append(el('p', 'No season-keyed donor rows are available in this package.', 'studio-muted')); return; }
  if (!seasonForgeRecipe) {
    const preferred = seasonDonorProfiles.find(profile => profile.scope === 'all-teams' && profile.phase === 'regular') || seasonDonorProfiles[0];
    seasonForgeBaseline = seasonForgeBaseline || preferred.key;
    seasonForgeRecipe = createSeasonForgeRecipe(seasonDonorProfiles,
      Object.fromEntries(SEASON_FORGE_BLOCKS.map(block => [block.key, preferred.key])));
  }
  const baseline = seasonDonorProfiles.find(profile => profile.key === seasonForgeBaseline) || seasonDonorProfiles[0];
  seasonForgeBaseline = baseline.key;
  const controls = el('div', undefined, 'studio-roadmap');
  const baselineLabel = el('label', 'Observed baseline season row');
  const baselineSelect = el('select'); baselineSelect.id = 'seasonForgeBaseline'; baselineSelect.append(...seasonForgeProfileOptions(seasonDonorProfiles, baseline.key));
  baselineSelect.addEventListener('change', () => { seasonForgeBaseline = baselineSelect.value; renderSeasonForge(); });
  baselineLabel.append(baselineSelect); controls.append(baselineLabel);
  for (const block of SEASON_FORGE_BLOCKS) {
    const label = el('label', `${block.label} donor`), select = el('select'); select.id = `season-forge-${block.key}`;
    select.append(...seasonForgeProfileOptions(seasonDonorProfiles, seasonForgeRecipe.donors[block.key]));
    select.addEventListener('change', () => {
      try { seasonForgeRecipe = createSeasonForgeRecipe(seasonDonorProfiles, { ...seasonForgeRecipe.donors, [block.key]: select.value }); renderSeasonForge(); }
      catch (error) { root.append(el('p', error.message, 'studio-muted')); }
    }); label.append(select); controls.append(label);
  }
  const buttons = el('div', undefined, 'studio-team-form');
  const useBaseline = el('button', 'Use baseline for all season blocks', 'button-secondary'); useBaseline.type = 'button';
  useBaseline.addEventListener('click', () => { seasonForgeRecipe = createSeasonForgeRecipe(seasonDonorProfiles,
    Object.fromEntries(SEASON_FORGE_BLOCKS.map(block => [block.key, baseline.key]))); renderSeasonForge(); });
  const clear = el('button', 'Clear season recipe', 'button-secondary'); clear.type = 'button';
  clear.addEventListener('click', () => { seasonForgeRecipe = createSeasonForgeRecipe(seasonDonorProfiles); renderSeasonForge(); });
  buttons.append(useBaseline, clear); root.append(controls, buttons);
  const composite = buildSeasonComposite(seasonDonorProfiles, seasonForgeRecipe, baseline.key);
  root.append(el('h4', `${composite.assigned}/${composite.totalBlocks} observed season blocks selected`),
    el('p', `${statusLabel(composite.status)}. ${composite.note}`, 'studio-muted'));
  root.append(table(['Block / donor', 'Component', 'Donor value', 'Baseline', 'Difference', 'Sample'], composite.blocks.flatMap(block => block.components.map(metric => [
    `${block.label} / ${block.donor ? seasonProfileLabel({ ...block.donor, player: block.donor.player, season: block.donor.season, phase: block.donor.phase, team: block.donor.team }) : 'Unassigned'}`,
    metric.label, format(metric.value, metric.unit), format(metric.baseline, metric.unit), differenceLabel(metric.difference, metric.unit),
    `${statusLabel(metric.status)}; ${format(metric.denominator)} denominator`
  ])), 'Season components retain their own observed games and attempt bases. Combining blocks is a hypothetical recipe, not a new player, projection or impact estimate.'));
  root.append(el('p', 'Season rows are descriptive evidence. Cross-team identity, age, availability, and joint usage response are not modeled here.', 'studio-muted'));
}

async function loadSeasonDonors() {
  if (!loadedTeam || !state?.snapshot) return;
  const button = byId('loadSeasonDonors'), root = byId('seasonForgeContent');
  button.disabled = true; root.replaceChildren(el('p', 'Reading the bounded season donor table…', 'studio-muted'));
  const request = generation;
  try {
    const result = await api('season-donors', { team: loadedTeam, snapshot: state.snapshot });
    if (request !== generation) return;
    if (result.snapshot !== state.snapshot || result.team !== loadedTeam) throw new Error('Season donor scope changed. Refresh the team evidence.');
    validateSeasonDonorProfiles(result.profiles);
    seasonDonorProfiles = result.profiles; seasonForgeRecipe = null; seasonForgeBaseline = '';
    renderSeasonForge();
  } catch (error) { if (request === generation) root.replaceChildren(el('p', error.name === 'AbortError' ? 'Season donor read timed out. Retry.' : error.message, 'studio-muted')); }
  finally { if (button.isConnected) button.disabled = false; }
}

function populateForge() {
  recipeHistory = []; byId('forgeUndo').disabled = true; byId('forgeChange').replaceChildren();
  seasonDonorProfiles = null; seasonForgeRecipe = null; seasonForgeBaseline = '';
  renderSeasonForge();
  byId('forgeBaseline').replaceChildren(...players.map(player => { const option = el('option', player.name); option.value = player.id; return option; }));
  const saved = loadForgeDraft(browserStorage(), roster);
  recipe = saved.recipe || createForgeRecipe(roster);
  byId('forgeStatus').textContent = saved.status === 'loaded' ? 'Saved recipe restored for this exact team and snapshot.'
    : ['invalid', 'unavailable'].includes(saved.status) ? 'Saved recipe could not be safely loaded. No donors were substituted.' : 'Choose donors or start from a baseline player.';
  byId('forgeDonors').replaceChildren(...FORGE_BLOCKS.map(block => {
    const label = el('label', `${block.label} donor`); const select = el('select'); select.id = `forge-${block.key}`;
    const empty = el('option', 'Choose a donor'); empty.value = '';
    select.append(empty, ...players.map(player => { const option = el('option', player.name); option.value = player.id; return option; }));
    select.value = recipe.donors[block.key];
    select.addEventListener('change', () => {
      changeForgeRecipe(createForgeRecipe(roster, { ...recipe.donors, [block.key]: select.value }));
      byId('forgeStatus').textContent = 'Recipe changed. Save locally to keep these choices.'; renderForge();
    });
    label.append(select); return label;
  }));
  renderForge();
}
function renderForge() {
  if (!roster || !recipe) return;
  const composite = buildComposite(roster, recipe, byId('forgeBaseline').value);
  const root = byId('forgeContent'); root.replaceChildren(el('h3', `${composite.assigned}/${composite.totalBlocks} donor blocks selected`));
  root.append(el('p', `${statusLabel(composite.status)}. ${composite.note}`, 'studio-muted'));
  const dependencies = inspectForgeDependencies(roster, recipe);
  if (dependencies.length) {
    const review = el('details', undefined, 'studio-panel'); review.dataset.forgeDependencies = '';
    review.append(el('summary', `${dependencies.length} cross-donor dependencies to review`));
    dependencies.forEach(item => review.append(el('p', item.reason)));
    review.append(el('p', 'These are untested relationships, not detected physical conflicts, penalties or proof the recipe cannot work.', 'studio-muted')); root.append(review);
  }
  const pin = el('button', referenceRecipe ? 'Replace recipe reference' : 'Pin recipe for comparison', 'button-secondary'); pin.type = 'button';
  pin.id = 'forgeReferencePin';
  pin.addEventListener('click', () => { referenceRecipe = createForgeRecipe(roster, recipe.donors); renderForge(); byId('forgeReferencePin').focus(); byId('forgeStatus').textContent = 'Recipe reference pinned in this tab. Change donors to compare; saved drafts are unchanged.'; });
  root.append(pin);
  if (referenceRecipe) {
    const comparison = compareForgeRecipes(roster, referenceRecipe, recipe), panel = el('details', undefined, 'studio-panel'); panel.dataset.forgeComparison = '';
    panel.append(el('summary', `Recipe comparison · ${comparison.changedBlocks} changed blocks`), el('p', comparison.note, 'studio-muted'));
    panel.append(table(['Component', 'Reference donor', 'Current donor', 'Reference value', 'Current value', 'Difference'], comparison.rows.map(row =>
      [row.label, row.referenceDonor, row.currentDonor, format(row.reference, row.unit), format(row.current, row.unit), differenceLabel(row.difference, row.unit)]), 'Current recipe minus pinned reference. Unavailable and below-gate differences remain blank.'));
    const clear = el('button', 'Clear recipe reference', 'button-secondary'); clear.type = 'button'; clear.addEventListener('click', () => { referenceRecipe = null; renderForge(); byId('forgeReferencePin').focus(); byId('forgeStatus').textContent = 'Pinned reference cleared. Current donors and saved drafts are unchanged.'; });
    panel.append(clear); root.append(panel);
  }
  root.append(styleMatchesPanel(findCompositeStyleMatches(roster, recipe), 'forge'));
  root.append(table(['Block / donor', 'Component', 'Donor value', 'Baseline', 'Difference', 'Evidence'], composite.blocks.flatMap(block => block.components.map(metric =>
    [`${block.label} / ${block.donor?.name || 'Unassigned'}`, metric.label, format(metric.value, metric.unit), format(metric.baseline, metric.unit),
      differenceLabel(metric.difference, metric.unit), `${statusLabel(metric.status)}; ${format(metric.numerator)} / ${format(metric.denominator)}; ${metric.reconciled ? 'box score reconciled' : 'not independently reconciled'}`]
  )), 'Percentages stay on their own attempt bases; production stays per 100 estimated team possessions. Differences are not gains in projected performance. Unavailable and limited samples are never filled or scaled up.'));
}
function showForgeChange(before, after) {
  const explanation = explainForgeChange(roster, before, after), root = byId('forgeChange');
  root.replaceChildren(el('h3', 'What changed?'), el('p', explanation.note, 'studio-muted'));
  explanation.changes.forEach(change => {
    root.append(el('p', `${change.block}: ${change.from} → ${change.to}`));
  });
  root.append(table(['Component', 'Before', 'After', 'Difference'], explanation.changes.flatMap(change => change.metrics.map(metric => [metric.label,
    format(metric.before, metric.unit), format(metric.after, metric.unit), differenceLabel(metric.difference, metric.unit)])), 'Change one block, inspect its evidence, then keep or undo the choice. Other blocks stay unchanged.'));
}
function changeForgeRecipe(next) {
  const before = recipe;
  if (JSON.stringify(before.donors) === JSON.stringify(next.donors)) return;
  recipeHistory.push(before); if (recipeHistory.length > 20) recipeHistory.shift();
  recipe = next; byId('forgeUndo').disabled = false; showForgeChange(before, next);
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
    players = result.players; loadedTeam = team; roster = result;
    populatePlayers(); careerLab.setRoster(roster, state); byId('analysis').hidden = ['game', 'league', 'career'].includes(mode);
    byId('workStatus').textContent = `${players.length} source player profiles loaded. All metrics use the full pooled team sample, not just the latest season.`;
  } catch (error) { if (request === generation) byId('workStatus').textContent = error.name === 'AbortError' ? 'The team read timed out. Retry when the package is ready.' : error.message; }
  finally { if (request === generation) setBusy(false); }
});
byId('playerSelect').addEventListener('change', renderBlueprint);
byId('compareSelect').addEventListener('change', renderBlueprint);
byId('blueprintQuestion').addEventListener('change', renderBlueprint);
byId('playerSearch').addEventListener('input', renderRoster);
byId('clearSelection').addEventListener('click', () => { selected = []; renderRoster(); byId('chemistryContent').replaceChildren(el('p', 'Selection cleared.')); });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  mode = button.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  byId('gamePanel').hidden = mode !== 'game';
  byId('leaguePanel').hidden = mode !== 'league';
  byId('careerPanel').hidden = mode !== 'career';
  const isSimulation = ['game', 'league'].includes(mode);
  byId('teamForm').hidden = isSimulation; byId('workStatus').hidden = isSimulation;
  byId('analysis').hidden = isSimulation || mode === 'career' || !roster;
  byId('blueprintPanel').hidden = button.dataset.mode !== 'blueprint';
  byId('chemistryPanel').hidden = button.dataset.mode !== 'chemistry';
  byId('forgePanel').hidden = button.dataset.mode !== 'forge';
}));
byId('forgeBaseline').addEventListener('change', renderForge);
byId('loadSeasonDonors').addEventListener('click', loadSeasonDonors);
byId('forgeUseBaseline').addEventListener('click', () => {
  if (!roster) return;
  changeForgeRecipe(createForgeRecipe(roster, Object.fromEntries(FORGE_BLOCKS.map(block => [block.key, byId('forgeBaseline').value]))));
  FORGE_BLOCKS.forEach(block => { byId(`forge-${block.key}`).value = recipe.donors[block.key]; });
  byId('forgeStatus').textContent = 'All blocks now use the baseline. Change individual donors to explore differences.'; renderForge();
});
byId('forgeUndo').addEventListener('click', () => {
  if (!roster || !recipeHistory.length) return;
  const before = recipe; recipe = recipeHistory.pop(); showForgeChange(before, recipe);
  FORGE_BLOCKS.forEach(block => { byId(`forge-${block.key}`).value = recipe.donors[block.key]; });
  byId('forgeUndo').disabled = recipeHistory.length === 0;
  byId('forgeStatus').textContent = 'Last donor change undone. Save locally if you want to replace the saved recipe.'; renderForge();
});
byId('forgeSave').addEventListener('click', () => {
  if (!roster || !recipe) return;
  try { saveForgeDraft(browserStorage(), roster, recipe); byId('forgeStatus').textContent = 'Recipe saved locally. Only donor handles are saved—not source statistics.'; }
  catch { byId('forgeStatus').textContent = 'Recipe could not be saved. Browser storage may be unavailable or full.'; }
});
byId('forgeReset').addEventListener('click', () => {
  if (!roster) return;
  let removed = true;
  try { clearForgeDraft(browserStorage(), roster); } catch { removed = false; }
  recipe = createForgeRecipe(roster);
  recipeHistory = []; byId('forgeUndo').disabled = true; byId('forgeChange').replaceChildren();
  FORGE_BLOCKS.forEach(block => { byId(`forge-${block.key}`).value = ''; }); renderForge();
  byId('forgeStatus').textContent = removed ? 'Recipe cleared. Its saved draft was removed; other drafts are untouched.' : 'Current recipe cleared, but browser storage prevented removal of the saved draft.';
});
byId('inspectChemistry').addEventListener('click', async () => {
  if (busy || selected.length < 2) return;
  const request = generation, selection = [...selected]; setBusy(true);
  const root = byId('chemistryContent'); root.replaceChildren(el('p', 'Reading the selected shared-floor sample…'));
  try {
    const result = await api('chemistry', { team: loadedTeam, snapshot: state.snapshot, players: selection.join(',') });
    if (request !== generation) return;
    const chemistry = analyzeChemistry(roster, result, selection);
    root.replaceChildren(el('h3', selection.map(id => players.find(player => player.id === id).name).join(' + ')));
    if (!result.combination) root.append(el('p', 'No observed combination in this team sample. This does not establish poor chemistry; no unseen-lineup result is invented.'));
    else {
      const sample = chemistry.sample;
      root.append(el('p', result.combination.note));
      root.append(el('p', `${format(result.combination.minutes)} reconstructed minutes · ${format(sample.games)} observed games. Status: ${sample.status.replaceAll('_', ' ')}.`, 'studio-muted'));
      root.append(table(['Sample', 'Offensive possessions', 'Defensive possessions', 'Offensive rating', 'Defensive rating', 'Net rating', 'Descriptive 95% range'], sampleRows([{ label: 'Selected group', ...sample }]), 'Ratings are points per 100 observed possessions. The descriptive 95% range does not account for every possession dependency.'));
      if (sample.status !== 'observed') root.append(el('p', `Ratings are withheld below the package sample gate (${format(sample.minimumCombinedPossessions)} combined possessions) or when a side has no exposure.`));
      if (result.combination.contexts?.length) root.append(renderGroupContextPanel(result.combination));
    }
    if (result.wowy?.length) root.append(table(['Together / apart', 'Offensive possessions', 'Defensive possessions', 'Offensive rating', 'Defensive rating', 'Net rating', 'Descriptive 95% range'], sampleRows(chemistry.cells), 'Same-game together/apart partitions. Different teammates, opponents, and situations can explain these differences.'));
    else if (selection.length === 2) root.append(el('p', 'No four-cell together/apart record is available for this pair.'));
    if (chemistry.contrasts.length && result.wowy?.length) root.append(table(['Comparison', 'Offensive difference', 'Defensive difference', 'Net difference'],
      chemistry.contrasts.map(row => [row.label, differenceLabel(row.offensiveDifference), differenceLabel(row.defensiveDifference), differenceLabel(row.netDifference)]), chemistry.note));
    if (chemistry.pairs.length) {
      root.append(el('h3', 'Pairs inside this group'));
      root.append(table(['Pair', 'Offensive possessions', 'Defensive possessions', 'Offensive rating', 'Defensive rating', 'Net rating', 'Descriptive 95% range'], sampleRows(chemistry.pairs), chemistry.note));
      root.append(el('p', `${chemistry.pairs.filter(pair => pair.status === 'observed').length}/${chemistry.pairs.length} pairs have usable observed rates. Pair observations do not establish that the full group played together.`));
    }
    root.append(el('p', result.note, 'studio-muted'));
    const currentView = captureChemistry(roster, result, selection);
    const compareRoot = el('section', undefined, 'studio-panel'); compareRoot.dataset.chemistryComparison = '';
    function renderComparison() {
      compareRoot.replaceChildren(el('h3', 'Compare observed groups'));
      const pin = el('button', referenceChemistry ? 'Replace group reference' : 'Pin group for comparison', 'button-secondary'); pin.type = 'button';
      pin.id = 'chemistryReferencePin';
      pin.addEventListener('click', () => { referenceChemistry = currentView; renderComparison(); byId('chemistryReferencePin').focus(); }); compareRoot.append(pin);
      if (!referenceChemistry) { compareRoot.append(el('p', 'Pin this sample, inspect another group of the same size, then compare their evidence. No substitute is applied to Lineup Lab.', 'studio-muted')); return; }
      const clear = el('button', 'Clear group reference', 'button-secondary'); clear.type = 'button';
      clear.addEventListener('click', () => { referenceChemistry = null; renderComparison(); byId('chemistryReferencePin').focus(); }); compareRoot.append(clear);
      try {
        const comparison = compareChemistry(roster, referenceChemistry, currentView);
        compareRoot.append(el('p', `Reference: ${comparison.reference.names.join(' + ')}`),
          el('p', `Removed: ${comparison.removed.join(', ') || 'Nobody'}. Added: ${comparison.added.join(', ') || 'Nobody'}. ${comparison.kept.length} players stayed in both groups.`),
          table(['Measure', 'Reference', 'Current', 'Difference'], [['offensiveRating', 'Offensive rating'], ['defensiveRating', 'Defensive rating'], ['netRating', 'Net rating']].map(([key, label]) =>
            [label, format(comparison.reference.sample[key]), format(comparison.current.sample[key]), differenceLabel(comparison.difference[key])]), comparison.note));
        const contexts = el('details'); contexts.append(el('summary', 'Compare matching context partitions'));
        contexts.append(table(['Context', 'Reference net', 'Current net', 'Difference', 'Reference / current status'], comparison.contexts.map(row =>
          [row.label, format(row.reference.netRating), format(row.current.netRating), differenceLabel(row.difference.netRating), `${statusLabel(row.reference.status)} / ${statusLabel(row.current.status)}`]), 'Only matching observed partitions receive a difference. Context labels do not match opponents or turn these into controlled samples.'));
        compareRoot.append(contexts);
      } catch (error) { compareRoot.append(el('p', error.message)); }
    }
    renderComparison(); root.append(compareRoot);
  } catch (error) { if (request === generation) root.replaceChildren(el('p', error.name === 'AbortError' ? 'Read timed out. Retry this selection.' : error.message)); }
  finally { if (request === generation) setBusy(false); }
});
refresh();
