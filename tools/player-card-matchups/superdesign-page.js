/* Page-local behavior bridge for Player & Card Matchups.
   It only clears a stale handoff affordance when a new lookup begins. The
   existing lookup module remains the source of truth for verified results. */

const mountedPages = new WeakMap();

function getPage(scope) {
  if (!scope) return null;
  if (typeof Element !== 'undefined'
    && scope instanceof Element
    && scope.matches('body.matchup-page')) return scope;
  return scope.querySelector?.('body.matchup-page') || null;
}

function disableHandoff(page) {
  const handoff = page?.querySelector?.('#labHandoff');
  if (!handoff) return;

  handoff.classList.add('is-disabled');
  handoff.setAttribute('aria-disabled', 'true');
  handoff.setAttribute('tabindex', '-1');
  handoff.removeAttribute('href');
}

export function mountPlayerCardMatchupsSuperdesign(
  scope = typeof document === 'undefined' ? null : document,
) {
  const page = getPage(scope);
  if (!page) return null;

  const existing = mountedPages.get(page);
  if (existing) return existing;

  const form = page.querySelector('#playerSearchForm');
  const handoff = page.querySelector('#labHandoff');
  if (!form || !handoff) return null;

  const onSubmit = () => disableHandoff(page);
  form.addEventListener('submit', onSubmit);

  const mounted = {
    disconnect() {
      form.removeEventListener('submit', onSubmit);
      mountedPages.delete(page);
    },
  };
  mountedPages.set(page, mounted);
  return mounted;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      mountPlayerCardMatchupsSuperdesign(document);
    }, { once: true });
  } else {
    mountPlayerCardMatchupsSuperdesign(document);
  }
}

export default mountPlayerCardMatchupsSuperdesign;
