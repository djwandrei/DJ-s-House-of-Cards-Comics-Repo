const mountedPages = new WeakMap();

const EMBEDDED_TOOL_IDS = new Set(['lineup-dna']);

function findHubPage(scope) {
  if (scope?.matches?.('.fan-tools-page[data-page="fan-tools"]')) return scope;
  return scope?.querySelector?.('.fan-tools-page[data-page="fan-tools"]') || null;
}

function addStatusLabel(card) {
  if (!card || card.nodeType !== 1 || typeof card.querySelector !== 'function' || card.querySelector('[data-hub-status]')) return;

  const embedded = EMBEDDED_TOOL_IDS.has(card.dataset.toolId);
  const status = (card.ownerDocument || document).createElement('span');
  status.className = 'hub-card-status';
  status.dataset.hubStatus = embedded ? 'embedded' : 'available';
  status.dataset.hubStatusLabel = embedded ? 'inside-lab' : 'available-now';
  status.textContent = embedded ? 'Inside Lab' : 'Available now';
  card.append(status);
  card.classList.add('hub-card');
}

function decorateLiveCards(page) {
  page.querySelectorAll('#toolsFeatured .tools-featured-card').forEach(addStatusLabel);
}

/**
 * Add the draft's live-status treatment to the registry-rendered hub cards.
 * Calling this more than once for the same page is safe.
 */
export function mountFanToolsHubSuperdesign(scope = document) {
  const page = findHubPage(scope);
  if (!page) return null;

  const existing = mountedPages.get(page);
  if (existing) {
    decorateLiveCards(page);
    return existing;
  }

  const state = { observer: null };
  const featured = page.querySelector('#toolsFeatured');
  if (featured && typeof MutationObserver !== 'undefined') {
    state.observer = new MutationObserver(() => decorateLiveCards(page));
    state.observer.observe(featured, { childList: true });
  }

  mountedPages.set(page, state);
  decorateLiveCards(page);
  return state;
}

if (typeof document !== 'undefined') {
  const boot = () => mountFanToolsHubSuperdesign(document);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
