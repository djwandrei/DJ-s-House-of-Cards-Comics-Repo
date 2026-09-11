/*
 * Scout Studio visual layer.
 *
 * The workbench controllers own the evidence and keep their tables as the
 * accessible source of truth. This module adds compact, data-derived visual
 * summaries beside those tables; it never invents values or changes a report.
 */

const numberFrom = value => {
  const match = String(value ?? '').replaceAll(',', '').match(/[+-]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

const headersFor = table => [...(table.tHead?.rows?.[0]?.cells || [])]
  .map(cell => cell.textContent.trim().toLowerCase());

const captionFor = table => table.querySelector('caption')?.textContent.trim().toLowerCase() || '';

function matchingTable(root, captionNeedle, headerNeedle) {
  return [...root.querySelectorAll('table')].find(table => {
    const captionMatch = !captionNeedle || captionFor(table).includes(captionNeedle);
    const headerMatch = !headerNeedle || headersFor(table).some(header => header.includes(headerNeedle));
    return captionMatch && headerMatch;
  });
}

function rowsFrom(table, valueHeader) {
  if (!table) return [];
  const headers = headersFor(table), valueIndex = headers.findIndex(header => header.includes(valueHeader));
  if (valueIndex < 0) return [];
  return [...(table.tBodies?.[0]?.rows || [])].map(row => {
    const cells = [...row.cells];
    return { label: cells[0]?.textContent.trim() || 'Observed row', display: cells[valueIndex]?.textContent.trim() || 'Unavailable', value: numberFrom(cells[valueIndex]?.textContent) };
  }).filter(row => Number.isFinite(row.value));
}

function removeVisual(root, key) {
  root.querySelector(`[data-scout-visual="${key}"]`)?.remove();
}

function visualSignature(rows) {
  return rows.map(row => `${row.label}:${row.display}`).join('|');
}

function createBarFigure(key, title, description, rows, { centered = false, suffix = '' } = {}) {
  const figure = document.createElement('figure');
  figure.className = `scout-visual-chart${centered ? ' scout-visual-chart--centered' : ''}`;
  figure.dataset.scoutVisual = key;
  figure.dataset.scoutSignature = visualSignature(rows);
  const caption = document.createElement('figcaption');
  caption.innerHTML = `<strong>${title}</strong><span>${description}</span>`;
  figure.append(caption);
  const chart = document.createElement('div');
  chart.className = 'scout-visual-chart__plot';
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `${title}. ${rows.map(row => `${row.label}: ${row.display}`).join('; ')}`);
  const extent = centered
    ? Math.max(...rows.map(row => Math.abs(row.value)), 1)
    : Math.max(...rows.map(row => row.value), 1);
  rows.forEach(row => {
    const line = document.createElement('div');
    line.className = 'scout-visual-chart__row';
    const label = document.createElement('span'); label.className = 'scout-visual-chart__label'; label.textContent = row.label;
    const track = document.createElement('span'); track.className = 'scout-visual-chart__track';
    const fill = document.createElement('span'); fill.className = 'scout-visual-chart__fill';
    if (centered) {
      fill.dataset.sign = row.value < 0 ? 'negative' : 'positive';
      fill.style.setProperty('--scout-bar-size', `${Math.min(50, Math.abs(row.value) / extent * 50)}%`);
    } else fill.style.setProperty('--scout-bar-size', `${Math.min(100, Math.max(0, row.value) / extent * 100)}%`);
    track.append(fill);
    const value = document.createElement('strong'); value.className = 'scout-visual-chart__value'; value.textContent = `${row.display}${suffix}`;
    line.append(label, track, value); chart.append(line);
  });
  figure.append(chart);
  return figure;
}

function placeVisual(target, figure, beforeNode = null) {
  const old = target.querySelector(`[data-scout-visual="${figure.dataset.scoutVisual}"]`);
  if (old?.dataset.scoutSignature === figure.dataset.scoutSignature) return;
  old?.remove();
  target.insertBefore(figure, beforeNode || null);
}

function decorateGame(root) {
  const cards = [...root.querySelectorAll('.studio-roadmap article')].map(card => ({
    label: card.querySelector('h4')?.textContent.trim() || '',
    display: card.querySelector('strong')?.textContent.trim() || '',
    value: numberFrom(card.querySelector('strong')?.textContent)
  })).filter(row => Number.isFinite(row.value) && row.display.includes('%'));
  if (cards.length < 2) return;
  const histogram = root.querySelector('.studio-game-histogram');
  const target = histogram?.parentElement || root;
  placeVisual(target, createBarFigure('game-outcomes', 'Outcome shares', 'A compact view of the seeded repeated experiment; read the score ranges below for context.', cards), histogram);
}

function decorateChemistry(root) {
  const table = matchingTable(root, '', 'net rating');
  const rows = rowsFrom(table, 'net rating').slice(0, 8);
  if (!rows.length) return;
  const wrap = table.closest('.studio-table-wrap');
  const target = wrap?.parentElement || root;
  placeVisual(target, createBarFigure('chemistry-net', 'Observed net rating', 'Relative display of the selected group or pair rows. The table remains the precise source.', rows, { suffix: ' net' }), wrap);
}

function decorateForge(root) {
  const table = matchingTable(root, '', 'difference');
  const rows = rowsFrom(table, 'difference').filter(row => Math.abs(row.value) > 0 || /^0(?:\.0+)?/.test(row.display)).slice(0, 10);
  if (!rows.length) return;
  const wrap = table.closest('.studio-table-wrap');
  const target = wrap?.parentElement || root;
  placeVisual(target, createBarFigure('forge-deltas', 'Recipe deltas', 'Donor values relative to the selected baseline. Positive and negative bars share a zero line.', rows, { centered: true }), wrap);
}

function decorateLeague(root) {
  const table = matchingTable(root, 'repeated-season outcomes', 'won title') || matchingTable(root, 'repeated-season outcomes', 'qualified');
  if (!table) return;
  const headers = headersFor(table);
  const targetHeader = headers.includes('won title') ? 'won title' : 'qualified';
  const rows = rowsFrom(table, targetHeader).filter(row => row.display.includes('%'));
  if (!rows.length) return;
  const title = targetHeader === 'won title' ? 'Title frequency' : 'Qualification frequency';
  const target = root;
  placeVisual(target, createBarFigure('season-outcomes', title, 'Frequencies from the repeated custom season experiment; they describe the chosen rules only.', rows), table.closest('.studio-table-wrap')?.parentElement || null);
}

function decorateCareer(root) {
  const table = matchingTable(root, 'observed season timeline', 'ppg');
  if (!table) return;
  const rows = rowsFrom(table, 'ppg').filter(row => !/^gap$/i.test(row.display)).slice(0, 12);
  if (!rows.length) return;
  const target = table.closest('.studio-table-wrap')?.parentElement || root;
  placeVisual(target, createBarFigure('career-scoring', 'Observed scoring by season', 'Points per game across supplied observed rows. Missing seasons stay out of the chart.', rows, { suffix: ' PPG' }), table.closest('.studio-table-wrap'));
}

function observe(selector, decorate) {
  const root = document.querySelector(selector);
  if (!root) return;
  let queued = false;
  const run = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; decorate(root); });
  };
  new MutationObserver(run).observe(root, { childList: true, subtree: true });
  run();
}

observe('#gameResults', decorateGame);
observe('#chemistryContent', decorateChemistry);
observe('#forgeContent', decorateForge);
observe('#leagueResults', decorateLeague);
observe('#careerResults', decorateCareer);
