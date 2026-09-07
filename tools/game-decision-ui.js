import { comparePublicPlayers, boardRules, draftNeeds } from './game-decision-model.js?v=20260907b';
const node = (tag, text, className = '') => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const number = value => value === null ? 'Unavailable' : value.toFixed(1);
export function decisionBrief(board, action) {
  const section = node('section', undefined, 'game-decision-brief');
  section.setAttribute('aria-label', 'Your objective and rules');
  section.append(node('strong', `Your objective: ${board.objective?.label || 'Scout board rank'}`),
    node('p', board.focus || 'Find the highest-ranked legal choice under this board’s Scout objective.'),
    node('p', action), node('small', boardRules(board)));
  return section;
}
export function candidateComparison(players, baseline = null) {
  const details = node('details', undefined, 'game-decision-details');
  details.append(node('summary', 'Compare public source stats'));
  const note = 'Recorded source values as supplied, not lineup totals or a Scout score. Players can come from different team-seasons. More is not always better; turnovers, for example, are not a benefit. Missing values stay unavailable.';
  details.append(node('p', note));
  const wrap = node('div', undefined, 'game-decision-table');
  wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Source comparison; scroll horizontally for all players');
  const table = node('table'); table.append(node('caption', baseline ? `Source comparison with outgoing player ${baseline.name}` : 'Candidates from this fixed board'));
  const head = node('thead'), row = node('tr');
  ['Metric', ...(baseline ? [`Outgoing: ${baseline.name}`] : []), ...players.map(player => player.name)].forEach(text => {
    const cell = node('th', text); cell.scope = 'col'; row.append(cell);
  });
  head.append(row); table.append(head);
  const body = node('tbody');
  for (const metric of comparePublicPlayers(players, baseline)) {
    const tr = node('tr'), heading = node('th', metric.label); heading.scope = 'row'; tr.append(heading);
    [...(baseline ? [metric.baseline] : []), ...metric.values].forEach(value => tr.append(node('td', number(value))));
    body.append(tr);
  }
  table.append(body); wrap.append(table); details.append(wrap, node('small', 'On narrow screens, scroll the comparison sideways.'));
  return details;
}
export function decisionPreview(player, { action, description, pending = false }) {
  const section = node('section', undefined, 'game-decision-preview');
  const heading = node('h3', `Review ${player.name}`); heading.id = 'decisionPreviewTitle';
  section.append(heading, node('p', description));
  const actions = node('div', undefined, 'fix-five-result-actions');
  const confirm = node('button', pending ? 'Checking…' : action, 'button');
  confirm.type = 'button'; confirm.dataset.action = 'confirm'; confirm.disabled = pending;
  const cancel = node('button', 'Back to candidates', 'button-secondary');
  cancel.type = 'button'; cancel.dataset.action = 'cancel-preview'; cancel.disabled = pending;
  actions.append(confirm, cancel); section.append(actions);
  return section;
}
export function draftChecklist(deck, selections) {
  const context = draftNeeds(deck, selections), section = node('section', undefined, 'game-draft-needs');
  if (!context) return section;
  section.setAttribute('aria-label', 'Remaining board roles');
  section.append(node('strong', `${context.picked}/5 picks committed · ${context.remaining.length} remaining`),
    node('p', context.remaining.length ? `Still to fill: ${context.remaining.map(round => round.title).join(' · ')}` : 'Every board slot is filled.'),
    node('small', context.note));
  return section;
}
export function decisionDebrief(title, lines) {
  const section = node('section', undefined, 'game-decision-debrief');
  section.append(node('h3', title));
  const list = node('ul'); lines.forEach(text => list.append(node('li', text))); section.append(list);
  return section;
}

export function decisionHistoryPanel(report) {
  const details = node('details', undefined, 'game-decision-details'); details.dataset.decisionHistory = '';
  details.append(node('summary', `Decision history · ${report.count} checked ${report.count === 1 ? 'choice' : 'choices'}`));
  details.append(node('p', report.note));
  if (!report.first) return details;
  details.append(node('p', `First checked: rank ${report.first.rank}, ${report.first.score}/100. Current: rank ${report.current.rank}, ${report.current.score}/100. Best checked: rank ${report.best.rank}.`));
  const delta = report.rankChange;
  details.append(node('p', delta > 0 ? `Your current choice moved ${delta} place(s) up this same board.`
    : delta < 0 ? `Your current choice moved ${Math.abs(delta)} place(s) down this same board.`
      : 'Your current choice has the same rank as your first checked choice. A tied rank does not establish equal basketball ability.'));
  const list = node('ol');
  for (const entry of report.recent) list.append(node('li', `Choice ${entry.number}: ${entry.names.join(' + ')} · rank ${entry.rank} · ${entry.score}/100`));
  details.append(list, node('small', 'Up to eight recent distinct choices are shown. This is feedback about the fixed board, not why the private model preferred a player.'));
  return details;
}
