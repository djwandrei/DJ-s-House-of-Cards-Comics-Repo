/* Page-only motion bridge for the existing Fix the Five renderer.
   It observes DOM state changes without touching board data, scores, storage,
   focus management, or the module's event handlers. */

const mountedPages = new WeakMap();

function motionReduced() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function restartAnimation(element, className) {
  if (!(element instanceof HTMLElement) || motionReduced()) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  element.addEventListener('animationend', () => element.classList.remove(className), { once: true });
}

function getMain(root) {
  if (root?.matches?.('.sd-game-main')) return root;
  return root?.querySelector?.('.sd-game-main') || document.querySelector('.sd-game-main');
}

export function mountSuperdesignPage(root = document) {
  const main = getMain(root);
  if (!main) return null;
  const existing = mountedPages.get(main);
  if (existing) return existing;

  const challengePanel = main.querySelector('#challengePanel');
  const completionPanel = main.querySelector('#completionPanel');
  const workspace = main.querySelector('#gameWorkspace');
  if (!challengePanel || !completionPanel || !workspace) return null;

  let challengeFrame = 0;
  let completionFrame = 0;

  const schedule = (element, className, type) => {
    if (type === 'challenge') {
      if (challengeFrame) return;
      challengeFrame = window.requestAnimationFrame(() => {
        challengeFrame = 0;
        restartAnimation(element, className);
      });
      return;
    }
    if (completionFrame) return;
    completionFrame = window.requestAnimationFrame(() => {
      completionFrame = 0;
      restartAnimation(element, className);
    });
  };

  const observer = new MutationObserver(records => {
    let challengeChanged = false;
    let completionShown = false;
    let workspaceShown = false;

    for (const record of records) {
      if (record.type === 'childList' && record.target === challengePanel) challengeChanged = true;
      if (record.type === 'childList' && record.target === completionPanel) completionShown = !completionPanel.hidden;
      if (record.type === 'attributes' && record.attributeName === 'hidden') {
        if (record.target === completionPanel) completionShown = !completionPanel.hidden;
        if (record.target === workspace) workspaceShown = !workspace.hidden;
      }
    }

    if (challengeChanged && !workspace.hidden) schedule(challengePanel, 'fix-five-panel-enter', 'challenge');
    if (completionShown) schedule(completionPanel, 'fix-five-completion-enter', 'completion');
    if (workspaceShown) schedule(workspace, 'fix-five-panel-enter', 'challenge');
  });

  observer.observe(main, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });

  const mounted = {
    main,
    disconnect() {
      observer.disconnect();
      if (challengeFrame) window.cancelAnimationFrame(challengeFrame);
      if (completionFrame) window.cancelAnimationFrame(completionFrame);
      mountedPages.delete(main);
    },
  };
  mountedPages.set(main, mounted);
  return mounted;
}

function autoMount() {
  mountSuperdesignPage(document);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount, { once: true });
  else autoMount();
}

export const mount = mountSuperdesignPage;
