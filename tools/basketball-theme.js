import { palettes, paletteForTeam, themeFor } from './basketball-palettes.js?v=20260908a';

// Appearance is a one-way consumer. It never changes rosters, rules, or scores.
const root = document.body;
export const COURT_TEAM_STORAGE_KEY = 'djhc-court-team-v1';
let team = '';
let previous = '';
const suiteRoot = new URL('./', import.meta.url);
const destinations = [
  ['Fan Tools', './', '../assets/games/fan-tools-emblem.svg'],
  ['Lineup Lab', '../lineup-lab/', '../assets/games/lineup-lab-emblem-20260907.webp'],
  ['Fix the Five', './fix-the-five/', '../assets/games/fix-the-five-emblem-20260907.webp'],
  ['Draft Night', './draft-night/', '../assets/games/draft-night-emblem-20260907.webp'],
  ['Scout Studio', './scout-studio/', '../assets/games/fan-tools-emblem.svg'],
  ['Player & Cards', './player-card-matchups/', '../assets/games/card-matchups-emblem.svg'],
  ['Workshop', './workshop/', '../assets/games/workshop-emblem.svg'],
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
  document.querySelectorAll('[data-court-team-select]').forEach(select => {
    select.value = palette.id;
    select.setAttribute('aria-label', `Choose team colors; current palette is ${palette.team}`);
  });
}

function isCurrentDestination(url, label) {
  const currentPath = location.pathname.replace(/index\.html$/, '').replace(/\/$/, '');
  const destinationPath = url.pathname.replace(/index\.html$/, '').replace(/\/$/, '');
  return currentPath === destinationPath || (label === 'Lineup Lab' && root.classList.contains('lab-guided'));
}

function mountFanSuiteHeader() {
  const list = document.querySelector('.site-nav .primary-nav__list');
  if (!list || list.dataset.fanSuiteMounted === 'true') return;
  list.dataset.fanSuiteMounted = 'true';
  list.replaceChildren();
  for (const [label, relative, emblem] of destinations) {
    const item = document.createElement('li');
    item.className = 'primary-nav__item fan-suite-nav__item';
    const link = document.createElement('a');
    link.className = 'primary-nav__link fan-suite-nav__link';
    const url = new URL(relative, suiteRoot);
    link.href = url.href;
    link.dataset.fanSuiteDestination = label;
    if (label === 'Fan Tools') link.dataset.fanToolsLink = 'true';
    if (isCurrentDestination(url, label)) link.setAttribute('aria-current', 'page');
    if (emblem) {
      const image = document.createElement('img');
      image.src = new URL(emblem, suiteRoot).href;
      image.alt = '';
      image.width = 24;
      image.height = 24;
      image.loading = 'lazy';
      image.decoding = 'async';
      link.append(image);
    }
    link.append(document.createTextNode(label));
    item.append(link);
    list.append(item);
  }
  document.querySelector('.site-header')?.classList.add('fan-suite-header');
  document.querySelector('.site-nav')?.classList.add('fan-suite-nav');
}

function mountCourtToolbar() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.court-toolbar')) return;
  const toolbar = document.createElement('div');
  toolbar.className = 'court-toolbar';
  // The fan-suite destinations now live in the site header. Remove the old
  // page-local game navigation so the same choices are not presented twice.
  document.querySelectorAll('.game-navigation').forEach(node => node.remove());
  const style = document.createElement('details');
  style.className = 'court-team-picker';
  const summary = document.createElement('summary');
  summary.textContent = 'Team colors';
  const panel = document.createElement('div');
  panel.className = 'court-team-picker__panel';
  const name = document.createElement('strong'); name.dataset.courtPaletteName = '';
  const teamName = document.createElement('span'); teamName.className = 'court-team-picker__team'; teamName.dataset.courtTeamName = '';
  const note = document.createElement('p');
  note.textContent = 'Choose the team-inspired colors used across the fan tools. This never changes the roster or score.';
  const label = document.createElement('label');
  label.className = 'court-team-picker__label';
  label.textContent = 'Palette';
  const select = document.createElement('select');
  select.dataset.courtTeamSelect = '';
  select.setAttribute('aria-label', 'Choose team colors');
  palettes.forEach(palette => {
    const option = document.createElement('option');
    option.value = palette.id;
    option.textContent = `${palette.team} · ${palette.name}`;
    select.append(option);
  });
  select.addEventListener('change', () => setCourtTeam(select.value));
  label.append(select);
  panel.append(name, teamName, note, label); style.append(summary, panel);
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
  toolbar.append(identity, style); main.prepend(toolbar);
}

if (root?.classList.contains('court-themed')) {
  team = readStoredTeam();
  mountFanSuiteHeader();
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
