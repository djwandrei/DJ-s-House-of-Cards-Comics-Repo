import { TOOL_REGISTRY, TOOL_STATUSES } from './registry.js?v=20260907c';

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
  'lineup-lab': ['Make the coaching calls', 'Choose a team → set your plan → meet your lineup', 'Build my lineup'],
  'lineup-dna': ['Discover what makes a five tick', 'Build a group → read its strengths → test one swap', 'Explore Lineup DNA'],
  'fix-the-five': ['One swap can change everything', 'Read the board → lock a swap → reveal the tradeoff', 'Fix the Five'],
  'draft-night': ['You’re on the clock. No rush.', 'Five picks → one lineup → reveal your board rank', 'Start drafting'],
  'card-matchup-explorer': ['Put your collector instincts to work', 'Choose players → compare the context → explore cards', 'Compare players & cards'],
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

function appendPills(parent, items, className) {
  const list = document.createElement('div');
  list.className = className;
  items.filter(Boolean).forEach((item) => appendText(list, 'span', '', item));
  parent.append(list);
  return list;
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
  if (play) appendText(copy, 'span', 'tools-play-eyebrow', play[0]);
  appendText(copy, 'h3', '', tool.title).id = titleId;
  appendText(copy, 'p', '', tool.summary);
  if (play) appendText(copy, 'p', 'tools-play-path', play[1]);
  appendPills(copy, [STATUS_LABELS[tool.status], KIND_LABELS[tool.kind], tool.highlights[0] || tool.capabilities[0]], 'tools-featured-card__meta');
  content.append(copy);
  card.append(content);

  const link = document.createElement('a');
  link.className = 'button';
  link.href = tool.href;
  link.textContent = play?.[2] || 'Launch tool';
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
  const capabilities = panel.querySelector('[data-live-capabilities]');
  if (marker) marker.textContent = tool.marker;
  if (title) title.textContent = tool.title;
  if (summary) summary.textContent = tool.summary;
  if (capabilities) {
    capabilities.replaceChildren();
    const highlights = tool.highlights.length ? tool.highlights : tool.capabilities;
    highlights.slice(0, 3).forEach((capability) => appendText(capabilities, 'span', '', capability));
  }
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
  if (!featured || !roadmap || !research) return;

  const liveTools = filterRegistry(TOOL_STATUSES.LIVE);
  const plannedTools = filterRegistry(TOOL_STATUSES.PLANNED);
  const researchTools = filterRegistry(TOOL_STATUSES.RESEARCH);

  featured.replaceChildren(...liveTools.map(createFeaturedTool));
  roadmap.replaceChildren(...plannedTools.map(createRoadmapCard));
  research.replaceChildren(...researchTools.map(createResearchTool));
  enhanceLiveSpotlight(liveTools[0]);
  updateStatusSummary(countRegistryByStatus());
  bindPlayPicker();
}

function bindPlayPicker() {
  const filters = [...document.querySelectorAll('[data-play-filter]')];
  const cards = [...document.querySelectorAll('#toolsFeatured .tools-featured-card')];
  const status = document.getElementById('playStatus');
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
