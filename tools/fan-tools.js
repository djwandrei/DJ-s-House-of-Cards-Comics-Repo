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
  'scout-studio': ['Explore the validated 2017–26 package', 'Inspect observed shared-floor evidence', 'Run Game, Season, or Career Labs'],
});

const CARD_DEFINITIONS = Object.freeze({
  'lineup-lab': {
    uses: 'The team, season, priorities, inclusions, and exclusions you choose.',
    result: 'A lineup or rotation that follows the selected rules.',
  },
  'lineup-dna': {
    uses: 'The five selected in Lineup Lab and their assigned roles.',
    result: 'A role-coverage explanation and one-swap comparison.',
  },
  'fix-the-five': {
    uses: 'A fixed player pool and the rules for one challenge board.',
    result: 'Your place among the allowed swaps on that same board; a 0–100 score compares choices only within it.',
  },
  'draft-night': {
    uses: 'The presented player pool and role rules for one challenge board.',
    result: 'A legal five and its rank among the combinations on that same board.',
  },
  'card-matchup-explorer': {
    uses: 'Your player search and verified player-to-card mappings.',
    result: 'Matching card records from the DJHC collection.',
  },
  'workshop': {
    uses: 'The preview tool and setup options you select locally.',
    result: 'A saved local setup, not a finished tool result.',
  },
  'rotation-rescue': {
    uses: 'A historical team brief, build mode, and the constraints you choose.',
    result: 'A reviewable setup for a five or full rotation; the connected optimizer is still being built.',
  },
  'scouts-call': {
    uses: 'A source-labeled opponent brief and the counter-lineup priorities you select.',
    result: 'A planned coaching comparison, not a live matchup or player assignment.',
  },
  'what-breaks-this-five': {
    uses: 'A defined five-player case file and the role trade-off you want to inspect.',
    result: 'An explainable role-coverage review once the reviewed case definitions are connected.',
  },
  'collection-lineup-builder': {
    uses: 'Your local or explicitly saved player-card collection and challenge rules.',
    result: 'A collection-limited lineup without changing catalog inventory or sale state.',
  },
  'era-roster-challenges': {
    uses: 'A versioned historical brief, roster facts, and the selected challenge rules.',
    result: 'A replayable historical challenge with a disclosed scoring boundary.',
  },
  'trade-package-builder': {
    uses: 'A hypothetical player package and the before-and-after lineup context.',
    result: 'A resettable role and skill-family comparison, never a transaction.',
  },
  'nba-analytics-explorer': {
    uses: 'A validated play-by-play package, cohort, and comparison recipe.',
    result: 'A research view only after licensed source coverage and model outputs are ready.',
  },
  'role-evolution-reel': {
    uses: 'Public multi-season player summaries and labeled denominator rules.',
    result: 'A source-scoped career role-shift comparison without causal claims.',
  },
  'era-translation-challenge': {
    uses: 'Complete league-season cohorts, position filters, and minimum samples.',
    result: 'An era-relative comparison whose cohort and thresholds are visible.',
  },
  'archetype-cohort-lab': {
    uses: 'Era, position, style preferences, and an explicit similarity recipe.',
    result: 'A cohort-bounded historical similarity view, not a player-equivalence verdict.',
  },
  'scout-studio': {
    uses: 'The available player pool, board, and historical view you choose.',
    result: 'An exploratory view of the selected records, not a prediction.',
  },
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

function appendDefinitionRows(parent, tool, className = 'tools-featured-card__definitions') {
  const definitions = CARD_DEFINITIONS[tool.id];
  if (!definitions) return;
  const list = document.createElement('dl');
  list.className = className;
  [['Uses', definitions.uses], ['Result', definitions.result]].forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = className.replace(/s$/, '');
    appendText(row, 'dt', '', label);
    appendText(row, 'dd', '', value);
    list.append(row);
  });
  parent.append(list);
}

function appendHighlights(parent, tool) {
  return;
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
  appendDefinitionRows(copy, tool);
  appendHighlights(copy, tool);
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
  appendDefinitionRows(copy, tool, 'tool-roadmap-card__definitions');

  const footer = document.createElement('div');
  footer.className = 'tool-roadmap-card__footer';
  appendText(footer, 'span', 'tool-roadmap-card__status', STATUS_LABELS[tool.status]);
  appendText(footer, 'span', 'tool-roadmap-card__dependency', `Needs: ${tool.dependencies[0]}`);
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
  appendDefinitionRows(copy, tool, 'tool-research-card__definitions');
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
