const cssHref = new URL('./blueprint.css?v=20260909m', import.meta.url).href;

function loadStyles() {
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === cssHref)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cssHref;
  link.dataset.blueprintStyles = cssHref;
  document.head.append(link);
}

function addDefinitions() {
  const details = document.createElement('details');
  details.className = 'blueprint-definitions';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Definitions';
  details.append(summary);

  const definitions = [
    ['Observed', 'Recorded events or reconstructed possessions in the stated package window.'],
    ['Rate per 100', 'A pace-neutral description of the recorded sample, not a forecast.'],
    ['Sample size', 'The attempts, minutes, or possessions behind a displayed value.'],
    ['Coverage', 'Which source fields were present and usable; missing fields remain missing.']
  ];
  const list = document.createElement('dl');
  definitions.forEach(([term, description]) => {
    const item = document.createElement('div');
    const title = document.createElement('dt');
    title.textContent = term;
    const body = document.createElement('dd');
    body.textContent = description;
    item.append(title, body);
    list.append(item);
  });
  details.append(list);
  return details;
}

function makeShell(panel) {
  if (panel.dataset.blueprintMounted === 'true') return panel.querySelector('.blueprint-layout');
  const heading = panel.querySelector('.studio-section-heading');
  const question = panel.querySelector('.studio-question');
  const content = panel.querySelector('#blueprintContent');
  if (!heading || !question || !content) return null;

  const title = heading.querySelector(':scope > div');
  const playerLabel = heading.querySelector('label[for="playerSelect"]');
  const compareLabel = heading.querySelector('label[for="compareSelect"]');
  const layout = document.createElement('div');
  layout.className = 'blueprint-layout';
  const aside = document.createElement('aside');
  aside.className = 'blueprint-sidebar studio-panel';
  aside.setAttribute('aria-label', 'Player Blueprint controls');
  const asideHeading = document.createElement('div');
  asideHeading.className = 'blueprint-sidebar__heading';
  const eyebrow = document.createElement('span');
  eyebrow.className = 'studio-eyebrow';
  eyebrow.textContent = 'Scout Studio / Player view';
  const headingText = document.createElement('h3');
  headingText.textContent = 'Blueprint controls';
  asideHeading.append(eyebrow, headingText);
  aside.append(asideHeading, playerLabel, compareLabel, question, addDefinitions());

  const main = document.createElement('div');
  main.className = 'blueprint-main';
  const titleBar = document.createElement('div');
  titleBar.className = 'blueprint-titlebar';
  titleBar.append(title);
  main.append(titleBar, content);
  layout.append(aside, main);
  heading.remove();
  panel.append(layout);
  panel.dataset.blueprintMounted = 'true';
  return layout;
}

function decorateMetricCards(content) {
  const metrics = content.querySelector('.studio-metrics');
  if (!metrics) return;
  metrics.classList.add('blueprint-metrics');
  metrics.querySelectorAll('.studio-metric').forEach((card, index) => {
    card.classList.add('blueprint-metric');
    card.dataset.blueprintAccent = String(index % 4);
  });
}

function addShotBars(content) {
  const section = [...content.querySelectorAll('section')].find(item => item.querySelector('h3')?.textContent.trim() === 'Shot tendency map');
  if (!section) return;
  section.classList.add('blueprint-shot-map');
  const table = section.querySelector('.studio-table-wrap table');
  if (!table) return;
  const headers = [...(table.tHead?.rows[0]?.cells || [])].map(cell => cell.textContent.trim().toLowerCase());
  const shareIndex = headers.findIndex(header => header === 'share of all attempts');
  if (shareIndex < 0) return;
  const rows = [...table.tBodies].flatMap(body => [...body.rows]);
  const signature = rows.map(row => [...row.cells].map(cell => cell.textContent.trim()).join('|')).join('||');
  const existing = section.querySelector('.blueprint-zone-bars');
  if (existing?.dataset.blueprintSource === signature) return;
  existing?.remove();
  const bars = document.createElement('figure');
  bars.className = 'blueprint-zone-bars';
  bars.dataset.blueprintSource = signature;
  const caption = document.createElement('figcaption');
  const captionTitle = document.createElement('strong');
  captionTitle.textContent = 'Shot share visual';
  const captionNote = document.createElement('span');
  captionNote.textContent = 'Recorded attempt share by zone. Use the table below for exact attempts and accuracy.';
  caption.append(captionTitle, captionNote);
  const plot = document.createElement('div');
  plot.className = 'blueprint-zone-bars__plot';
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', 'Recorded shot attempt share by zone');
  rows.forEach(row => {
    const cells = [...row.cells];
    const shareText = cells[shareIndex]?.textContent.trim() || '';
    const parsedShare = Number.parseFloat(shareText);
    const share = shareText.includes('%') ? parsedShare : parsedShare <= 1 ? parsedShare * 100 : parsedShare;
    if (!cells[0] || !Number.isFinite(share) || !cells[shareIndex]) return;
    const line = document.createElement('div');
    line.className = 'blueprint-zone-bar';
    const label = document.createElement('span');
    label.textContent = cells[0].textContent;
    const track = document.createElement('span');
    track.className = 'blueprint-zone-bar__track';
    const fill = document.createElement('span');
    fill.className = 'blueprint-zone-bar__fill';
    fill.style.setProperty('--blueprint-bar', `${Math.max(0, Math.min(100, share))}%`);
    track.append(fill);
    const value = document.createElement('span');
    value.textContent = cells[shareIndex].textContent;
    line.append(label, track, value);
    plot.append(line);
  });
  if (plot.children.length) {
    const values = [...plot.children].map(line => `${line.firstElementChild?.textContent}: ${line.lastElementChild?.textContent}`).join('; ');
    plot.setAttribute('aria-label', `Recorded shot attempt share by zone. ${values}`);
    bars.append(caption, plot);
    section.querySelector('h3')?.after(bars);
  }
}

function decorateContent(content) {
  content.classList.add('blueprint-content');
  content.querySelector('.studio-sample')?.classList.add('blueprint-summary');
  content.querySelector('.studio-metrics')?.previousElementSibling?.classList.add('blueprint-intro');
  content.querySelectorAll('[data-blueprint-comparison]').forEach(node => node.closest('section')?.classList.add('blueprint-comparison'));
  decorateMetricCards(content);
  addShotBars(content);
}

export function mountBlueprintWorkbench() {
  const panel = document.getElementById('blueprintPanel');
  if (!panel) return;
  loadStyles();
  const layout = makeShell(panel);
  const content = layout?.querySelector('#blueprintContent');
  if (!content || content.dataset.blueprintObserver === 'true') return;
  content.dataset.blueprintObserver = 'true';
  let decorating = false;
  const decorate = () => {
    if (decorating) return;
    decorating = true;
    decorateContent(content);
    decorating = false;
  };
  new MutationObserver(decorate).observe(content, { childList: true, subtree: true });
  decorate();
}
