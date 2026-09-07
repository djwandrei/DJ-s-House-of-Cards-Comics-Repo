import { paletteForTeam, themeFor } from './basketball-palettes.js?v=20260907c';

// Appearance is a one-way consumer. It never changes rosters, rules, or scores.
const root = document.body;
let team = '';
let previous = '';
const suiteRoot = new URL('./', import.meta.url);
const destinations = [
  ['Fan Tools', './', ''],
  ['Lineup Lab', '../lineup-lab/', 'lineup-lab'],
  ['Fix the Five', './fix-the-five/', 'fix-the-five'],
  ['Draft Night', './draft-night/', 'draft-night'],
  ['Player & Cards', './player-card-matchups/', ''],
  ['Workshop', './workshop/', ''],
];

export function setCourtTeam(code = '') {
  team = typeof code === 'string' ? code : '';
  applyAppearance();
}

function applyAppearance() {
  if (!root?.classList.contains('court-themed')) return;
  const palette = paletteForTeam(team);
  const mode = root.classList.contains('dark-mode') ? 'dark' : 'light';
  const key = `${palette.id}:${mode}`;
  if (key !== previous) {
    previous = key;
    for (const [name, value] of Object.entries(themeFor(palette, mode))) {
      root.style.setProperty(`--court-${name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`, value);
    }
    root.dataset.courtPalette = palette.id;
    root.dataset.courtMode = mode;
    root.style.colorScheme = mode;
  }
  document.querySelectorAll('[data-court-palette-name]').forEach(node => { node.textContent = palette.name; });
  document.querySelectorAll('button[data-court-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.courtMode === mode));
  });
}

function changeMode(mode) {
  const isDark = mode !== 'light';
  if (isDark === root.classList.contains('dark-mode')) return;
  // Storefront owns its theme. The standalone Lab shares the same preference
  // key without loading catalog, checkout, or site-header initialization.
  const existingToggle = document.getElementById('themeToggle');
  if (existingToggle) existingToggle.click();
  else {
    root.classList.toggle('dark-mode', isDark);
    try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch { /* session still works */ }
  }
  applyAppearance();
}

function mountCourtToolbar() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.court-toolbar')) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'court-toolbar';
  const nav = document.createElement('nav');
  nav.className = 'court-navigation';
  nav.setAttribute('aria-label', 'Basketball fan tools');
  const links = document.querySelector('.game-page-indicators') || document.createElement('div');
  links.className = 'game-page-indicators court-destinations';
  const oldNav = links.closest('.game-navigation');
  links.replaceChildren();
  for (const [label, relative, emblem] of destinations) {
    const link = document.createElement('a');
    const url = new URL(relative, suiteRoot);
    link.href = url.href;
    const currentPath = location.pathname.replace(/index\.html$/, '');
    if (currentPath === url.pathname || (emblem === 'lineup-lab' && root.classList.contains('lab-guided'))) link.setAttribute('aria-current', 'page');
    if (emblem) {
      const image = document.createElement('img');
      image.src = new URL(`../assets/games/${emblem}-emblem-20260907.webp`, suiteRoot).href;
      image.alt = ''; image.width = 28; image.height = 28;
      link.append(image);
    }
    link.append(document.createTextNode(label));
    links.append(link);
  }
  nav.append(links);
  // Retain game entry links and instructions; remove only the empty old nav.
  if (oldNav && !oldNav.children.length) oldNav.remove();
  const style = document.createElement('details');
  style.className = 'court-style';
  const summary = document.createElement('summary');
  summary.textContent = 'Court style';
  const panel = document.createElement('div');
  panel.className = 'court-style__panel';
  const name = document.createElement('strong'); name.dataset.courtPaletteName = '';
  const note = document.createElement('p');
  note.textContent = 'Team-inspired colors follow the selected team where available. Otherwise, DJHC colors stay in play.';
  const modes = document.createElement('div'); modes.className = 'court-mode-buttons';
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', 'Page color mode');
  for (const mode of ['dark', 'light']) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.courtMode = mode;
    button.textContent = mode === 'dark' ? 'Dark' : 'Light';
    button.addEventListener('click', () => changeMode(mode));
    modes.append(button);
  }
  panel.append(name, note, modes); style.append(summary, panel);
  style.addEventListener('keydown', event => {
    if (event.key === 'Escape') { style.open = false; summary.focus(); }
  });
  document.addEventListener('pointerdown', event => { if (!style.contains(event.target)) style.open = false; });
  toolbar.append(nav, style); main.prepend(toolbar);
  const current = links.querySelector('[aria-current="page"]');
  if (current) links.scrollLeft = Math.max(0, current.offsetLeft - links.offsetLeft - 20);
}

if (root?.classList.contains('court-themed')) {
  mountCourtToolbar();
  applyAppearance();
  new MutationObserver(applyAppearance).observe(root, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('storage', event => {
    if (event.key === 'theme' && !document.getElementById('themeToggle')) {
      root.classList.toggle('dark-mode', event.newValue !== 'light');
      applyAppearance();
    }
  });
}
