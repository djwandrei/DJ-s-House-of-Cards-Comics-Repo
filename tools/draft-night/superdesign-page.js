/* Page-local enhancement only: replay a short reveal cue when the real game
   replaces its live board or completion content. It never changes game state. */

const mountedRoots = new WeakSet();

function reducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function markForReveal(node) {
  if (!(node instanceof HTMLElement) || node.hidden) return;
  node.classList.remove('sd-stage-enter');
  if (reducedMotion()) return;
  requestAnimationFrame(() => {
    if (node.isConnected && !node.hidden) node.classList.add('sd-stage-enter');
  });
}

function directChildren(node) {
  return [...node.children].filter(child => child instanceof HTMLElement);
}

export function mountDraftNightSuperdesign(root = document) {
  const main = root?.matches?.('.draft-night-main')
    ? root
    : root?.querySelector?.('.draft-night-main');
  if (!(main instanceof HTMLElement) || mountedRoots.has(main)) return main || null;

  mountedRoots.add(main);
  const targets = [main.querySelector('#draftPanel'), main.querySelector('#completionPanel')].filter(Boolean);
  targets.forEach(target => directChildren(target).forEach(markForReveal));

  const observer = new MutationObserver(records => {
    records.forEach(record => {
      if (record.type !== 'childList') return;
      const target = record.target instanceof HTMLElement ? record.target : null;
      if (!targets.includes(target)) return;
      [...record.addedNodes]
        .filter(node => node instanceof HTMLElement)
        .forEach(markForReveal);
    });
  });
  targets.forEach(target => observer.observe(target, { childList: true }));

  return main;
}

function autoMount() {
  mountDraftNightSuperdesign();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount, { once: true });
else autoMount();
