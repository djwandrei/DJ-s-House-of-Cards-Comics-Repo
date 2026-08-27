import { TOOL_REGISTRY, TOOL_STATUSES } from './registry.js';

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

function appendList(parent, items, className) {
  const list = document.createElement('ul');
  list.className = className;
  items.forEach((item) => appendText(list, 'li', '', item));
  parent.append(list);
  return list;
}

function createToolCard(tool) {
  const card = document.createElement('article');
  card.className = `tool-card tool-card--${tool.status}`;
  card.dataset.toolId = tool.id;
  card.dataset.toolStatus = tool.status;

  appendText(card, 'span', 'tool-card__eyebrow', tool.eyebrow);
  const heading = document.createElement('div');
  heading.className = 'tool-card__heading';
  appendText(heading, 'h3', '', tool.title);
  appendText(heading, 'span', `tool-card__status tool-card__status--${tool.status}`, STATUS_LABELS[tool.status]);
  card.append(heading);

  appendText(card, 'p', 'tool-card__summary', tool.summary);
  appendText(card, 'span', 'tool-card__kind', KIND_LABELS[tool.kind] || 'Fan experience');
  appendList(card, tool.capabilities, 'tool-card__list');

  const details = document.createElement('dl');
  details.className = 'tool-card__details';
  appendText(details, 'dt', '', 'Needs');
  appendText(details, 'dd', '', tool.dependencies.join(' · '));
  appendText(details, 'dt', '', 'Build boundary');
  appendText(details, 'dd', '', tool.implementationNotes);
  card.append(details);

  const actions = document.createElement('div');
  actions.className = 'tool-card__actions';
  if (tool.href) {
    const link = document.createElement('a');
    link.className = 'button';
    link.href = tool.href;
    link.textContent = 'Open tool';
    actions.append(link);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'button-secondary tool-card__planned-action';
    placeholder.setAttribute('aria-disabled', 'true');
    placeholder.textContent = STATUS_LABELS[tool.status];
    actions.append(placeholder);
  }
  card.append(actions);
  return card;
}

function filterRegistry(status) {
  if (status === 'all') return TOOL_REGISTRY;
  return TOOL_REGISTRY.filter((tool) => tool.status === status);
}

export { filterRegistry };

function renderTools(status = 'all') {
  const grid = document.getElementById('toolsGrid');
  const statusElement = document.getElementById('toolsStatus');
  if (!grid || !statusElement) return;

  const tools = filterRegistry(status);
  grid.replaceChildren(...tools.map(createToolCard));
  const label = status === 'all' ? 'all fan tools' : `${STATUS_LABELS[status].toLowerCase()} fan tools`;
  statusElement.textContent = `Showing ${tools.length} ${label}.`;
}

function initFanTools() {
  const filters = [...document.querySelectorAll('[data-tool-filter]')];
  if (!filters.length) return;

  filters.forEach((filter) => {
    filter.addEventListener('click', () => {
      const status = filter.dataset.toolFilter || 'all';
      filters.forEach((button) => {
        button.setAttribute('aria-pressed', String(button === filter));
      });
      renderTools(status);
    });
  });

  renderTools('all');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFanTools, { once: true });
  } else {
    initFanTools();
  }
}
