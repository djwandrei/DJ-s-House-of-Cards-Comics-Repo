/* Small, state-aware motion layer translated from the approved Superdesign drafts.
   Motion is decorative: it never delays data, changes a result, or hides a control. */
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const revealSelectors = [
  '.tools-featured-card', '.tool-roadmap-card', '.tool-research-card',
  '.page-hero-card', '.fix-five-workspace', '.matchup-workspace',
  '.workshop-shell', '.studio-source', '.studio-workbench-intro',
  '.studio-method', '.hero-outcomes', '.workflow-shell', '.panel',
  '.workshop-tool-choice', '.studio-roadmap > article'
].join(',');

function reveal(node) {
  if (!(node instanceof HTMLElement) || node.hidden || node.dataset.sdMotionReady === 'true') return;
  node.dataset.sdMotionReady = 'true';
  node.classList.add('sd-reveal');
  if (reducedMotion()) {
    node.classList.add('sd-reveal-visible');
    return;
  }
  requestAnimationFrame(() => node.classList.add('sd-reveal-visible'));
}

function decorate(root = document) {
  root.querySelectorAll?.(revealSelectors).forEach(reveal);
  if (root.matches?.(revealSelectors)) reveal(root);
}

function animatePanel(node) {
  if (!(node instanceof HTMLElement) || node.hidden) return;
  reveal(node);
  if (reducedMotion()) return;
  node.classList.remove('sd-panel-enter');
  void node.offsetWidth;
  node.classList.add('sd-panel-enter');
  node.addEventListener('animationend', () => node.classList.remove('sd-panel-enter'), { once: true });
}

function init() {
  decorate();
  const main = document.querySelector('main');
  if (!main) return;

  const canObserveVisibility = 'IntersectionObserver' in window;
  const visibilityObserver = canObserveVisibility ? new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('sd-reveal-visible');
        visibilityObserver.unobserve(entry.target);
      }
    });
  }, { threshold: .08, rootMargin: '0px 0px -36px' }) : null;
  if (reducedMotion() || !visibilityObserver) {
    main.querySelectorAll('.sd-reveal').forEach(node => node.classList.add('sd-reveal-visible'));
  } else {
    main.querySelectorAll('.sd-reveal').forEach(node => visibilityObserver.observe(node));
  }

  let decorationQueued = false;
  const queueDecoration = () => {
    if (decorationQueued) return;
    decorationQueued = true;
    queueMicrotask(() => {
      decorationQueued = false;
      decorate(main);
    });
  };
  const stateObserver = new MutationObserver(records => {
    records.forEach(record => {
      if (record.type === 'childList' && record.addedNodes.length) queueDecoration();
      if (record.type === 'attributes' && record.attributeName === 'hidden') animatePanel(record.target);
    });
  });
  stateObserver.observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });

  document.addEventListener('pointerdown', event => {
    const button = event.target.closest?.('button, .button, .button-secondary');
    if (!button || reducedMotion()) return;
    button.classList.remove('sd-press');
    requestAnimationFrame(() => button.classList.add('sd-press'));
    window.setTimeout(() => button.classList.remove('sd-press'), 180);
  }, { passive: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();

export { animatePanel, decorate, init, reducedMotion };
