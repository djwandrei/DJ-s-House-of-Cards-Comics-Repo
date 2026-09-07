import { paletteForTeam, themeFor } from './basketball-palettes.js?v=20260907f';

// Appearance is a one-way consumer. It never changes rosters, rules, or scores.
const root = document.body;
export const COURT_TEAM_STORAGE_KEY = 'djhc-court-team-v1';
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

function readStoredTeam() {
  try {
    const stored = String(localStorage.getItem(COURT_TEAM_STORAGE_KEY) || '').trim();
    if (!stored) return '';
    const palette = paletteForTeam(stored);
    // Unknown or historical codes stay neutral rather than making an
    // arbitrary palette appear to be a supported team.
    return palette.id === 'djhc' && stored.toLowerCase() !== 'djhc' ? '' : palette.id;
  } catch {
    return '';
  }
}

function saveTeam(code) {
  try { localStorage.setItem(COURT_TEAM_STORAGE_KEY, code); } catch { /* appearance still works for this page */ }
}

export function setCourtTeam(code = '') {
  const supplied = typeof code === 'string' ? code.trim() : '';
  // A page may be showing a local/demo roster without a source team. Keep the
  // visitor's selected palette as a presentation preference instead of
  // dropping back to neutral every time that fixture is loaded.
  team = supplied || readStoredTeam();
  const palette = paletteForTeam(team);
  // A verified team selection follows the visitor through the fan suite.
  if (supplied) saveTeam(palette.id);
  applyAppearance();
}

function applyAppearance() {
  if (!root?.classList.contains('court-themed')) return;
  const palette = paletteForTeam(team);
  const mode = root.classList.contains('dark-mode') ? 'dark' : 'light';
  const key = `${palette.id}:${mode}`;
  const paletteChanged = Boolean(root.dataset.courtPalette && root.dataset.courtPalette !== palette.id);
  if (key !== previous) {
    previous = key;
    for (const [name, value] of Object.entries(themeFor(palette, mode))) {
      root.style.setProperty(`--court-${name.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`, value);
    }
    root.style.setProperty('--court-team-primary', palette.primary);
    root.style.setProperty('--court-team-highlight', palette.highlight);
    root.style.setProperty('--court-team-trim', palette.trim);
    root.dataset.courtPalette = palette.id;
    root.dataset.courtTeam = palette.id;
    root.dataset.courtMode = mode;
    root.style.colorScheme = mode;
  }
  document.querySelectorAll('.court-team-identity').forEach(node => {
    node.setAttribute('aria-label', `Current team-inspired page theme: ${palette.team}, ${palette.name}`);
    node.title = `${palette.team} · ${palette.name}`;
    if (paletteChanged && typeof node.animate === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.animate(
        [{ transform: 'translateY(-2px)', opacity: 0.82 }, { transform: 'none', opacity: 1 }],
        { duration: 260, easing: 'ease-out' },
      );
    }
  });
  document.querySelectorAll('[data-court-palette-name]').forEach(node => { node.textContent = palette.name; });
  document.querySelectorAll('[data-court-team-name]').forEach(node => { node.textContent = palette.team; });
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
  const teamName = document.createElement('span'); teamName.className = 'court-style__team'; teamName.dataset.courtTeamName = '';
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
  panel.append(name, teamName, note, modes); style.append(summary, panel);
  style.addEventListener('keydown', event => {
    if (event.key === 'Escape') { style.open = false; summary.focus(); }
  });
  document.addEventListener('pointerdown', event => { if (!style.contains(event.target)) style.open = false; });
  const identity = document.createElement('div');
  identity.className = 'court-team-identity';
  identity.setAttribute('aria-label', 'Current team-inspired page theme');
  identity.setAttribute('role', 'status');
  identity.setAttribute('aria-live', 'polite');
  identity.setAttribute('aria-atomic', 'true');
  const swatch = document.createElement('span');
  swatch.className = 'court-team-identity__swatch';
  swatch.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('span');
  copy.className = 'court-team-identity__copy';
  const eyebrow = document.createElement('small');
  eyebrow.className = 'court-team-identity__eyebrow';
  eyebrow.textContent = 'Team palette';
  const paletteName = document.createElement('strong');
  paletteName.className = 'court-team-identity__name';
  paletteName.dataset.courtPaletteName = '';
  const selectedTeam = document.createElement('span');
  selectedTeam.className = 'court-team-identity__team';
  selectedTeam.dataset.courtTeamName = '';
  copy.append(eyebrow, paletteName, selectedTeam);
  identity.append(swatch, copy);
  toolbar.append(identity, nav, style); main.prepend(toolbar);
  const current = links.querySelector('[aria-current="page"]');
  if (current) links.scrollLeft = Math.max(0, current.offsetLeft - links.offsetLeft - 20);
}

if (root?.classList.contains('court-themed')) {
  team = readStoredTeam();
  mountCourtToolbar();
  applyAppearance();
  new MutationObserver(applyAppearance).observe(root, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('storage', event => {
    if (event.key === COURT_TEAM_STORAGE_KEY) {
      team = readStoredTeam();
      previous = '';
      applyAppearance();
    }
    if (event.key === 'theme' && !document.getElementById('themeToggle')) {
      root.classList.toggle('dark-mode', event.newValue !== 'light');
      applyAppearance();
    }
  });
}
