import { TOOL_REGISTRY, TOOL_STATUSES } from './registry.js?v=20260905a';

const STATUS_LABELS = Object.freeze({
  [TOOL_STATUSES.LIVE]: 'Live',
  [TOOL_STATUSES.PLANNED]: 'Planned',
  [TOOL_STATUSES.RESEARCH]: 'Research gated'
});

const KIND_LABELS = Object.freeze({
  tool: 'Fan tool',
  game: 'Fan game'
});

function appendText(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function appendMarker(parent, tool, className = 'tool-marker') {
  const marker = appendText(parent, 'span', className, tool.marker);
  marker.setAttribute('aria-hidden', 'true');
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
  card.setAttribute('aria-labelledby', titleId);

  const content = document.createElement('div');
  content.className = 'tools-featured-card__content';
  appendMarker(content, tool, 'tools-featured-card__marker');

  const copy = document.createElement('div');
  appendText(copy, 'h3', '', tool.title).id = titleId;
  appendText(copy, 'p', '', tool.summary);
  appendPills(copy, [STATUS_LABELS[tool.status], KIND_LABELS[tool.kind], tool.highlights[0] || tool.capabilities[0]], 'tools-featured-card__meta');
  content.append(copy);
  card.append(content);

  const link = document.createElement('a');
  link.className = 'button';
  link.href = tool.href;
  link.textContent = 'Launch tool';
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
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderTools, { once: true });
  } else {
    renderTools();
  }
}
