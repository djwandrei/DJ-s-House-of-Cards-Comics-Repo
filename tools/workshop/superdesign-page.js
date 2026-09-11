const mountedPages = new WeakMap();

function getPage(scope) {
  if (!scope) return null;
  if (scope.matches?.('.tool-workshop-page')) return scope;
  return scope.querySelector?.('.tool-workshop-page') || null;
}

function saveStateFromText(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('saved locally') && !text.includes('not saved')) return 'saved';
  if (text.includes('changes not saved') || text.includes('not saved')) return 'unsaved';
  return 'info';
}

function setDataAttribute(element, name, value) {
  if (!element) return;
  const nextValue = String(value);
  if (element.getAttribute(name) !== nextValue) {
    element.setAttribute(name, nextValue);
  }
}

function markChildren(container) {
  if (!container) return;
  [...container.children].forEach((child) => {
    setDataAttribute(child, 'data-workshop-enter', 'true');
  });
}

function decoratePage(page) {
  const picker = page.querySelector('#workshopToolPicker');
  const state = page.querySelector('#workshopState');
  const status = page.querySelector('#workshopStatus');
  const setupCard = page.querySelector('.workshop-setup-card');

  if (picker) {
    setDataAttribute(picker, 'data-workshop-choice-group', 'true');
    markChildren(picker);
  }

  ['#workshopFields', '#workshopStages', '#workshopResults', '#workshopGuardrails']
    .map((selector) => page.querySelector(selector))
    .forEach(markChildren);

  if (state) {
    const saveState = saveStateFromText(state.textContent);
    setDataAttribute(state, 'data-workshop-save-state', saveState);
  }

  if (status) {
    setDataAttribute(
      setupCard,
      'data-workshop-message-state',
      status.dataset.state || 'info',
    );
  }

  const selected = picker?.querySelector('[aria-pressed="true"]')?.dataset.workshopTool;
  if (picker && selected) {
    setDataAttribute(picker, 'data-workshop-selected', selected);
  } else if (picker) {
    picker.removeAttribute('data-workshop-selected');
  }
}

function createObserver(page) {
  if (typeof MutationObserver !== 'function') return null;

  const observer = new MutationObserver(() => decoratePage(page));
  observer.observe(page, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed', 'data-state', 'hidden'],
  });
  return observer;
}

function createMountedPage(page, observer) {
  const mounted = {
    disconnect() {
      observer?.disconnect();
      mountedPages.delete(page);
      page.removeAttribute('data-workshop-superdesign-mounted');
    },
  };
  setDataAttribute(page, 'data-workshop-superdesign-mounted', 'true');
  return mounted;
}

export function mountWorkshopSuperdesignPage(
  scope = typeof document === 'undefined' ? null : document,
) {
  const page = getPage(scope);
  if (!page) return null;

  const existing = mountedPages.get(page);
  if (existing) return existing;

  decoratePage(page);

  const observer = createObserver(page);
  const mounted = createMountedPage(page, observer);
  mountedPages.set(page, mounted);
  return mounted;
}

function autoMount() {
  mountWorkshopSuperdesignPage(document);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount, { once: true });
  } else {
    autoMount();
  }
}
