import { TOOL_REGISTRY, TOOL_STATUSES } from './registry.js?v=20260909b';

const STATUS_LABELS = Object.freeze({
  [TOOL_STATUSES.LIVE]: 'Live',
  [TOOL_STATUSES.PLANNED]: 'Planned',
  [TOOL_STATUSES.RESEARCH]: 'Research gated'
});

const KIND_LABELS = Object.freeze({
  tool: 'Fan tool',
  game: 'Fan game'
});
const PLAY_LABELS = Object.freeze({
  'lineup-lab': ['Choose a team and season, set priorities, then review your five', 'Open Lineup Lab'],
  'lineup-dna': ['Review role coverage, find a gap, then test one replacement', 'Explore Lineup DNA'],
  'fix-the-five': ['Read the fixed board, choose one legal swap, then reveal your place', 'Play Fix the Five'],
  'draft-night': ['Choose five players by role, lock the lineup, then read the board result', 'Play Draft Night'],
  'card-matchup-explorer': ['Search a player, review identity-linked cards, then browse the collection', 'Compare players & cards'],
  'scout-studio': ['Choose a team, inspect observed evidence, then run a repeatable lab', 'Open Scout Studio'],
});

const CARD_BULLETS = Object.freeze({
  'lineup-lab': ['Build a starting five or full rotation', 'Try a historical team-season', 'Lock or exclude players'],
  'lineup-dna': ['See which roles your five covers', 'Find a thin or missing role', 'Test one replacement'],
  'fix-the-five': ['Choose one legal replacement', 'Lock your move', 'Reveal a board result'],
  'draft-night': ['Pick five players by role', 'Build your lineup', 'Reveal your place on the board'],
  'card-matchup-explorer': ['Search a player', 'See verified card matches', 'Jump back to the Lab'],
  'scout-studio': ['Explore the validated 2020–26 package', 'Inspect observed shared-floor evidence', 'Run Game, Season, or Career Labs'],
});

export function filterPlayableTools(filter = 'all') {
  return TOOL_REGISTRY.filter(tool => tool.status === TOOL_STATUSES.LIVE && (filter === 'all' || (filter === 'games' ? tool.kind === 'game' : tool.kind === 'tool')));
}

function appendText(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function appendMarker(parent, tool, className = 'tool-marker') {
  const marker = appendText(parent, 'span', className, tool.emblem ? '' : tool.marker);
  marker.setAttribute('aria-hidden', 'true');
  if (tool.emblem) {
    const image = document.createElement('img');
    image.src = new URL(tool.emblem, import.meta.url).href;
    image.alt = '';
    image.width = 96;
    image.height = 96;
    image.loading = 'lazy';
    image.decoding = 'async';
    marker.classList.add('has-game-emblem');
    marker.append(image);
  }
  return marker;
}

function createFeaturedTool(tool) {
  const card = document.createElement('article');
  const titleId = `tool-title-${tool.id}`;
  card.className = 'tools-featured-card';
  card.dataset.toolId = tool.id;
  card.dataset.toolKind = tool.kind;
  card.setAttribute('aria-labelledby', titleId);

  const content = document.createElement('div');
  content.className = 'tools-featured-card__content';
  appendMarker(content, tool, 'tools-featured-card__marker');

  const copy = document.createElement('div');
  const play = PLAY_LABELS[tool.id];
  appendText(copy, 'h3', '', tool.title).id = titleId;
  appendText(copy, 'p', '', tool.summary);
  if (play) {
    const path = appendText(copy, 'p', 'tools-play-path', 'How it works: ' + play[0]);
    path.setAttribute('aria-label', 'How it works');
  }
  const bullets = document.createElement('ul');
  bullets.className = 'tools-featured-card__bullets';
  (CARD_BULLETS[tool.id] || tool.capabilities.slice(0, 3)).forEach(item => appendText(bullets, 'li', '', item));
  copy.append(bullets);
  content.append(copy);
  card.append(content);

  const link = document.createElement('a');
  link.className = 'button';
  link.href = tool.href;
  link.textContent = play?.[1] || 'Open tool';
  card.append(link);
  return card;
}

function createRoadmapCard(tool) {
  const card = document.createElement('article');
  const titleId = `tool-title-${tool.id}`;
  card.className = 'tool-roadmap-card';
  card.dataset.toolId = tool.id;
  card.dataset.toolStatus = tool.status;
  card.setAttribute('aria-labelledby', titleId);
  appendMarker(card, tool, 'tool-roadmap-card__marker');

  const copy = document.createElement('div');
  appendText(copy, 'h3', '', tool.title).id = titleId;
  appendText(copy, 'p', 'tool-roadmap-card__summary', tool.summary);

  const footer = document.createElement('div');
  footer.className = 'tool-roadmap-card__footer';
  appendText(footer, 'span', 'tool-roadmap-card__status', STATUS_LABELS[tool.status]);
  appendText(footer, 'span', 'tool-roadmap-card__dependency', `Depends on: ${tool.dependencies[0]}`);
  if (tool.href) {
    const link = document.createElement('a');
    link.className = 'tool-roadmap-card__link';
    link.href = tool.href;
    const label = tool.launchLabel || 'Open tool';
    link.textContent = label;
    link.setAttribute('aria-label', `${label} for ${tool.title}`);
    footer.append(link);
  }
  copy.append(footer);
  card.append(copy);
  return card;
}

function createResearchTool(tool) {
  const card = document.createElement('article');
  const titleId = `tool-title-${tool.id}`;
  card.className = 'tool-research-card';
  card.dataset.toolId = tool.id;
  card.dataset.toolStatus = tool.status;
  card.setAttribute('aria-labelledby', titleId);
  appendMarker(card, tool, 'tool-research-card__marker');

  const copy = document.createElement('div');
  appendText(copy, 'h3', '', tool.title).id = titleId;
  appendText(copy, 'p', '', tool.summary);
  appendText(copy, 'small', '', `Required evidence: ${tool.dependencies[0]}`);
  card.append(copy);
  appendText(card, 'span', 'tool-research-card__status', STATUS_LABELS[tool.status]);
  return card;
}

function filterRegistry(status) {
  if (status === 'all') return TOOL_REGISTRY;
  return TOOL_REGISTRY.filter((tool) => tool.status === status);
}

function formatToolsStatus(status, count) {
  const noun = count === 1 ? 'fan tool' : 'fan tools';
  if (status === 'all') return `Showing ${count} ${noun}.`;
  return `Showing ${count} ${STATUS_LABELS[status].toLowerCase()} ${noun}.`;
}

function countRegistryByStatus() {
  return Object.freeze({
    [TOOL_STATUSES.LIVE]: filterRegistry(TOOL_STATUSES.LIVE).length,
    [TOOL_STATUSES.PLANNED]: filterRegistry(TOOL_STATUSES.PLANNED).length,
    [TOOL_STATUSES.RESEARCH]: filterRegistry(TOOL_STATUSES.RESEARCH).length
  });
}

export { countRegistryByStatus, filterRegistry, formatToolsStatus };

function enhanceLiveSpotlight(tool) {
  const panel = document.getElementById('toolsLiveSpotlight');
  if (!panel || !tool) return;

  const marker = panel.querySelector('[data-live-marker]');
  const title = panel.querySelector('[data-live-title]');
  const summary = panel.querySelector('[data-live-summary]');
  if (marker) {
    marker.replaceChildren();
    marker.classList.toggle('has-game-emblem', Boolean(tool.emblem));
    if (tool.emblem) {
      const image = document.createElement('img');
      image.src = new URL(tool.emblem, import.meta.url).href;
      image.alt = '';
      image.width = 64;
      image.height = 64;
      image.decoding = 'async';
      marker.append(image);
    } else marker.textContent = tool.marker;
  }
  if (title) title.textContent = tool.title;
  if (summary) summary.textContent = tool.summary;
  const link = panel.querySelector('[data-live-link]');
  if (link) { link.href = tool.href; link.textContent = 'Open ' + tool.title; }
}

function updateStatusSummary(counts) {
  Object.entries(counts).forEach(([status, count]) => {
    document.querySelectorAll(`[data-status-count="${status}"]`).forEach((element) => {
      element.textContent = String(count);
    });
  });

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const status = document.getElementById('toolsStatus');
  if (status) {
    status.textContent = `${total} fan ${total === 1 ? 'experience' : 'experiences'}: ${counts.live} live, ${counts.planned} planned, and ${counts.research} research gated.`;
  }
}

function renderTools() {
  const featured = document.getElementById('toolsFeatured');
  const roadmap = document.getElementById('toolsGrid');
  const research = document.getElementById('toolsResearch');
  if (!featured) return;

  const liveTools = filterRegistry(TOOL_STATUSES.LIVE);
  const plannedTools = filterRegistry(TOOL_STATUSES.PLANNED);
  const researchTools = filterRegistry(TOOL_STATUSES.RESEARCH);

  featured.replaceChildren(...liveTools.map(createFeaturedTool));
  roadmap?.replaceChildren(...plannedTools.map(createRoadmapCard));
  research?.replaceChildren(...researchTools.map(createResearchTool));
  enhanceLiveSpotlight(liveTools[0]);
  updateStatusSummary(countRegistryByStatus());
  bindPlayPicker();
}

function bindPlayPicker() {
  const filters = [...document.querySelectorAll('[data-play-filter]')];
  const cards = [...document.querySelectorAll('#toolsFeatured .tools-featured-card')];
  const status = document.getElementById('playStatus');
  if (!filters.length && !document.getElementById('suggestPlay')) return;
  let selection = 'all';
  let suggestedId = '';
  const apply = filter => {
    selection = filter;
    const ids = new Set(filterPlayableTools(filter).map(tool => tool.id));
    cards.forEach(card => { card.hidden = !ids.has(card.dataset.toolId); card.classList.remove('is-suggested'); });
    filters.forEach(control => control.setAttribute('aria-pressed', String(control.dataset.playFilter === filter)));
    if (status) status.textContent = `${ids.size} ${filter === 'games' ? 'games' : filter === 'tools' ? 'tools' : 'experiences'} to explore. Choose one to get started.`;
  };
  filters.forEach(control => control.addEventListener('click', () => apply(control.dataset.playFilter)));
  document.getElementById('suggestPlay')?.addEventListener('click', () => {
    const choices = filterPlayableTools(selection).filter(tool => tool.id !== suggestedId);
    const tool = choices[Math.floor(Math.random() * choices.length)];
    if (!tool) return;
    suggestedId = tool.id;
    const card = cards.find(item => item.dataset.toolId === tool.id);
    cards.forEach(item => item.classList.toggle('is-suggested', item === card));
    if (status) status.textContent = `Your next play: ${tool.title}. ${PLAY_LABELS[tool.id]?.[0] || tool.summary}`;
    card?.querySelector('a')?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  });
  apply('all');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTools, { once: true });
  } else {
    renderTools();
  }
}
