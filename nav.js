/**
 * Navigation helpers for the shared site header.
 * -----------------------------------------------------------------------------
 * This module keeps the primary navigation in sync with the current page,
 * controls the mobile menu, and manages the Sports Cards submenu for both
 * keyboard and pointer users.
 */

window.DJ = window.DJ || {};

(() => {
  // Keep each page's active navigation target and drawer label together.
  const PAGE_NAV_CONFIG = Object.freeze({
    home: { target: 'index.html', label: 'Home' },
    shop: { target: 'shop.html', label: 'Shop' },
    'shop-hub': { target: 'shop.html', label: 'Shop' },
    'sports-hub': { target: 'sports-cards.html', label: 'Sports Cards' },
    'baseball-cards': { target: 'sports-cards.html', label: 'Baseball Cards' },
    'basketball-cards': { target: 'sports-cards.html', label: 'Basketball Cards' },
    'football-cards': { target: 'sports-cards.html', label: 'Football Cards' },
    comics: { target: 'comics.html', label: 'Comics' },
    collectibles: { target: 'collectibles.html', label: 'Collectibles' },
    wishlist: { target: 'wishlist.html', label: 'Wishlist' },
    cart: { target: 'cart.html', label: 'Cart' },
    'checkout-success': { target: 'cart.html', label: 'Checkout submitted' },
    account: { target: 'account.html', label: 'Account' },
    about: { target: 'about.html', label: 'About' },
    contact: { target: 'contact.html', label: 'Contact' },
    admin: { target: 'admin.html', label: 'Admin Dashboard' },
    inbox: { target: 'admin.html', label: 'Admin Inbox' },
    metrics: { target: 'admin.html', label: 'Conversion & Performance Metrics' },
    offer: { target: 'shop.html', label: 'Make an Offer' },
    'fan-tools': { target: '/tools/', label: 'Fan Tools' },
    policies: { target: 'about.html', label: 'Policies & Authenticity' },
    policy: { target: 'about.html', label: 'Policies & Authenticity' },
    'sell-trade-want-list': { target: 'contact.html', label: 'Sell, Trade & Want List' }
  });
  // CSS converts the header to its drawer layout at this exact width.
  const COMPACT_NAV_BREAKPOINT = 1180;
  // One shared breakpoint keeps the menu drawer and submenu behavior in sync.
  const COMPACT_NAV_QUERY = typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${COMPACT_NAV_BREAKPOINT}px)`)
    : null;
  const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  window.DJ.PAGE_NAV_CONFIG = PAGE_NAV_CONFIG;
  window.DJ.COMPACT_NAV_BREAKPOINT = COMPACT_NAV_BREAKPOINT;

  function getCurrentPageLabel() {
    const pageKey = document.body.dataset.page || '';
    return PAGE_NAV_CONFIG[pageKey]?.label || 'Navigation';
  }

  function isCompactNavViewport() {
    // innerWidth remains current even in webviews where an existing
    // MediaQueryList object's .matches value can lag after rotation.
    return window.innerWidth <= COMPACT_NAV_BREAKPOINT;
  }

  function dedupePrimaryNavLinks() {
    const navList = document.querySelector('.site-nav .primary-nav__list');
    if (!navList) return;

    const seen = new Set();
    [...navList.children].forEach((item) => {
      const link = item.querySelector(':scope > a[href], :scope > .primary-nav__item-group > a[href]');
      if (!link) return;

      const label = link.textContent.trim().toLowerCase();
      const href = link.getAttribute('href') || '';
      const key = `${href}|${label}`;
      if (seen.has(key)) {
        item.remove();
        return;
      }

      seen.add(key);
    });
  }

  /**
   * Keep the future tools area discoverable without copying another link into
   * every static page template. The hub owns the roadmap; this link only
   * provides a stable entry point from the shared storefront header.
   */
  function ensureFanToolsLink() {
    const navList = document.querySelector('.site-nav .primary-nav__list');
    if (!navList || navList.querySelector('[data-fan-tools-link="true"]')) return;

    const item = document.createElement('li');
    item.className = 'primary-nav__item';

    const link = document.createElement('a');
    link.className = 'primary-nav__link';
    link.href = '/tools/';
    link.dataset.fanToolsLink = 'true';
    link.textContent = 'Fan Tools';
    item.append(link);

    const aboutItem = navList.querySelector('a[href="about.html"]')?.closest('.primary-nav__item');
    navList.insertBefore(item, aboutItem || null);
  }

  /**
   * Give every storefront page the same header search surface as the
   * homepage. The static templates intentionally keep their lightweight
   * fallback header; this enhancement adds the richer search chooser whenever
   * JavaScript is available without changing page-specific content.
   */
  function ensureSharedHeaderSearch() {
    const headerInner = document.querySelector('.site-header .header-inner');
    if (!headerInner) return null;

    const existing = headerInner.querySelector('.home-header-search');
    if (existing) return existing;

    const form = document.createElement('form');
    form.className = 'home-header-search shared-header-search';
    form.id = 'siteHeaderSearch';
    form.setAttribute('role', 'search');
    form.innerHTML = `
      <label class="sr-only" for="siteHeaderSearchInput">Search the DJHC catalog</label>
      <div class="home-header-search__bar">
        <svg aria-hidden="true" class="home-header-search__icon" focusable="false" viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="6.5"></circle>
          <path d="m16 16 4 4"></path>
        </svg>
        <input autocomplete="off" id="siteHeaderSearchInput" name="search" placeholder="Search player, title, year, set, or category" type="search">
        <button aria-controls="siteHeaderSearchScope" aria-expanded="false" id="siteHeaderSearchSubmit" type="submit">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="6.5"></circle>
            <path d="m16 16 4 4"></path>
          </svg>
          <span>Search</span>
        </button>
      </div>
      <div class="home-search-scope" hidden id="siteHeaderSearchScope">
        <p class="sr-only" id="siteHeaderSearchStatus" role="status"></p>
        <div class="home-search-scope__heading">
          <span>Choose where to search</span>
          <strong id="siteHeaderSearchScopeTerm"></strong>
        </div>
        <div class="home-search-scope__links">
          <a data-search-base="baseball-cards.html" href="baseball-cards.html">Baseball</a>
          <a data-search-base="basketball-cards.html" href="basketball-cards.html">Basketball</a>
          <a data-search-base="football-cards.html" href="football-cards.html">Football</a>
          <a data-search-base="comics.html" href="comics.html">Comics</a>
          <a data-search-base="collectibles.html" href="collectibles.html">Collectibles</a>
        </div>
      </div>`;

    const nav = headerInner.querySelector('.site-nav');
    headerInner.insertBefore(form, nav || null);
    return form;
  }

  function initSharedHeaderSearch(form) {
    if (!form || form.id === 'homeCatalogSearch' || form.dataset.searchBound === 'true') {
      return;
    }

    const input = form.querySelector('input[type="search"]');
    const submit = form.querySelector('button[type="submit"]');
    const scope = form.querySelector('.home-search-scope');
    const term = form.querySelector('.home-search-scope__heading strong');
    const status = form.querySelector('[role="status"]');
    if (!input || !submit || !scope || !term || !status) return;
    form.dataset.searchBound = 'true';

    const closeScope = () => {
      scope.hidden = true;
      submit.setAttribute('aria-expanded', 'false');
      status.textContent = '';
    };

    const updateScope = ({ announce = false } = {}) => {
      const query = input.value.trim();
      if (!query) {
        closeScope();
        input.focus();
        status.textContent = 'Enter a search term before choosing a department.';
        return false;
      }

      term.textContent = `“${query}”`;
      scope.querySelectorAll('[data-search-base]').forEach((link) => {
        link.href = `${link.dataset.searchBase}?search=${encodeURIComponent(query)}`;
      });
      scope.hidden = false;
      submit.setAttribute('aria-expanded', 'true');
      if (announce) status.textContent = `Choose a department to search for ${query}.`;
      return true;
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      updateScope({ announce: true });
    });

    input.addEventListener('input', () => {
      if (!scope.hidden) updateScope();
    });

    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        updateScope({ announce: true });
      } else if (event.key === 'Escape' && !scope.hidden) {
        closeScope();
        input.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (!form.contains(event.target)) closeScope();
    });
  }

  // ---------------------------------------------------------------------------
  // Active-state management
  // ---------------------------------------------------------------------------

  /**
   * Apply the correct active/aria-current state to top-level links. The submenu
   * special case avoids marking both the top link and the current submenu link
   * as aria-current at the same time.
   */
  function applyActiveNavState() {
    dedupePrimaryNavLinks();
    const pageKey = document.body.dataset.page || '';
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    const targetFile = PAGE_NAV_CONFIG[pageKey]?.target || currentFile;
    const links = [...document.querySelectorAll('.site-nav a')];
    const navItems = [...document.querySelectorAll('.site-nav .primary-nav__item')];
    const findPreferredLink = (candidates = []) => (
      candidates.find((link) => !link.closest('.primary-nav__submenu'))
      || candidates[0]
      || null
    );
    const currentLink = findPreferredLink(links.filter((link) => link.getAttribute('href') === currentFile));
    const sectionLink = currentLink
      ? null
      : findPreferredLink(links.filter((link) => link.getAttribute('href') === targetFile));
    const activeLink = currentLink || sectionLink;

    navItems.forEach((item) => item.classList.remove('is-current-section'));

    links.forEach((link) => {
      const href = link.getAttribute('href');
      const isSectionMatch = href === targetFile;
      const shouldBeActive = link === activeLink || isSectionMatch;

      link.classList.toggle('active', shouldBeActive);
      link.removeAttribute('aria-current');

      if (link !== activeLink) {
        return;
      }

      link.setAttribute('aria-current', 'page');

      const navItem = link.closest('.primary-nav__item');
      if (navItem) {
        navItem.classList.add('is-current-section');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Mobile menu behavior
  // ---------------------------------------------------------------------------

  /**
   * Wire the main menu toggle, escape-to-close support, resize cleanup, and the
   * outside-click handler used on small screens.
   */
  function initPrimaryNav() {
    const nav = document.getElementById('siteNav');
    const navToggle = document.getElementById('navToggle');

    if (!nav || !navToggle || document.body.dataset.primaryNavBound === 'true') {
      return;
    }
    document.body.dataset.primaryNavBound = 'true';

    let lastFocusedBeforeOpen = null;
    const submenuItems = [...nav.querySelectorAll('.primary-nav__item--has-submenu')];
    const submenuToggleButtons = [...nav.querySelectorAll('.submenu-toggle')];

    if (!nav.querySelector('.site-nav__mobile-header')) {
      const mobileHeader = document.createElement('div');
      mobileHeader.className = 'site-nav__mobile-header';

      const eyebrow = document.createElement('span');
      eyebrow.className = 'site-nav__eyebrow';
      eyebrow.textContent = 'Navigate the collection';

      const title = document.createElement('strong');
      title.className = 'site-nav__mobile-title';
      title.textContent = getCurrentPageLabel();

      const copy = document.createElement('p');
      copy.textContent = 'Move between sports cards, comics, collectibles, fan tools, wishlist, and account tools.';

      mobileHeader.append(eyebrow, title, copy);
      nav.insertBefore(mobileHeader, nav.firstChild);
    }

    const mobileActions = nav.querySelector('.site-nav__mobile-actions');
    if (mobileActions && !mobileActions.querySelector('#themeToggle')) {
      mobileActions.remove();
    }

    let navBackdrop = document.querySelector('.site-nav-backdrop');
    if (!navBackdrop) {
      navBackdrop = document.createElement('button');
      navBackdrop.className = 'site-nav-backdrop';
      navBackdrop.type = 'button';
      navBackdrop.tabIndex = -1;
      navBackdrop.setAttribute('aria-label', 'Close menu');
      document.body.appendChild(navBackdrop);
    }

    window.DJ.updateWishlistCount();

    /**
     * Keep the off-canvas menu hidden from keyboard and assistive-tech users
     * while it is visually closed on small screens, without affecting desktop.
     */
    const syncMenuAccessibility = (compactNav = isCompactNavViewport()) => {
      const isOpen = nav.classList.contains('open');
      const shouldHide = compactNav && !isOpen;
      nav.setAttribute('aria-hidden', String(shouldHide));

      if (nav.hidden !== shouldHide) {
        nav.hidden = shouldHide;
      }

      if (shouldHide) {
        nav.setAttribute('inert', '');
      } else {
        nav.removeAttribute('inert');
      }
    };

    const updateMenuToggleState = (isOpen) => {
      navToggle.setAttribute('aria-expanded', String(isOpen));
      navToggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
      navToggle.setAttribute('data-state', isOpen ? 'open' : 'closed');
      const label = navToggle.querySelector('.button-label');
      if (label) {
        label.textContent = isOpen ? 'Close' : 'Menu';
      }
    };

    const closeMenu = ({ restoreFocus = false, compactNav } = {}) => {
      nav.classList.remove('open');
      updateMenuToggleState(false);
      document.body.classList.remove('menu-open');
      submenuItems.forEach((item) => {
        item.classList.remove('is-open');
      });
      submenuToggleButtons.forEach((button) => {
        button.setAttribute('aria-expanded', 'false');
      });

      if (restoreFocus && lastFocusedBeforeOpen && typeof lastFocusedBeforeOpen.focus === 'function') {
        lastFocusedBeforeOpen.focus();
      }

      lastFocusedBeforeOpen = null;
      syncMenuAccessibility(compactNav);
    };

    const openMenu = () => {
      lastFocusedBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      nav.hidden = false;
      nav.classList.add('open');
      updateMenuToggleState(true);
      document.body.classList.add('menu-open');
      syncMenuAccessibility();

      if (isCompactNavViewport()) {
        const firstFocusable = nav.querySelector(FOCUSABLE_SELECTOR);
        if (firstFocusable instanceof HTMLElement) {
          window.setTimeout(() => {
            firstFocusable.focus();
          }, 40);
        }
      }
    };

    navToggle.addEventListener('click', () => {
      const isOpen = nav.classList.contains('open');
      if (isOpen) {
        closeMenu({ restoreFocus: true });
      } else {
        openMenu();
      }
    });

    nav.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link || !nav.contains(link)) {
        return;
      }

      if (isCompactNavViewport()) {
        closeMenu();
      }
    });

    navBackdrop.addEventListener('click', () => {
      closeMenu({ restoreFocus: true });
    });

    const handleViewportChange = (event) => {
      // MediaQueryList events carry the settled breakpoint state even in
      // browsers where innerWidth is updated a moment after the resize event.
      // The window-resize fallback has no `matches` property and uses the live
      // viewport width instead.
      const compactNav = typeof event?.matches === 'boolean'
        ? event.matches
        : isCompactNavViewport();
      if (!compactNav) {
        closeMenu({ compactNav: false });
        return;
      }

      syncMenuAccessibility(true);
    };

    // Some embedded browsers and device-emulation environments do not emit a
    // reliable MediaQueryList change event. Accessibility state is inexpensive
    // to synchronize, so update it directly instead of risking a throttled frame
    // leaving desktop navigation hidden after a rotate or window resize.
    DJ.bindMediaQueryChange(COMPACT_NAV_QUERY, handleViewportChange);
    window.addEventListener('resize', handleViewportChange, { passive: true });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (nav.classList.contains('open')) {
          closeMenu({ restoreFocus: true });
        }
        return;
      }

      if (event.key !== 'Tab' || !nav.classList.contains('open') || !isCompactNavViewport()) {
        return;
      }

      const focusableElements = [...nav.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => (
        element instanceof HTMLElement
        && !element.hasAttribute('hidden')
        && !element.closest('[hidden]')
      ));

      if (!focusableElements.length) {
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (!nav.classList.contains('open')) {
        return;
      }

      if (nav.contains(event.target) || navToggle.contains(event.target)) {
        return;
      }

      closeMenu();
    });

    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) {
        return;
      }

      applyActiveNavState();
      closeMenu();
      syncMenuAccessibility();
    });

    updateMenuToggleState(false);
    syncMenuAccessibility();
  }

  // ---------------------------------------------------------------------------
  // Submenu behavior
  // ---------------------------------------------------------------------------

  /**
   * The sports submenu opens on button press for touch devices and remains fully
   * keyboard accessible. Desktop users still get standard hover behavior from CSS.
   */
  function initSubmenuToggles() {
    const nav = document.getElementById('siteNav');
    if (!nav || document.body.dataset.submenuNavBound === 'true') {
      return;
    }
    document.body.dataset.submenuNavBound = 'true';

    const submenuItems = nav.querySelectorAll('.primary-nav__item--has-submenu');
    const closeTimers = new WeakMap();

    const getSubmenuLinks = (item) => [...item.querySelectorAll('.primary-nav__submenu a')]
      .filter((link) => link instanceof HTMLElement);

    const setSubmenuState = (item, willOpen, options = {}) => {
      const { focus = 'none' } = options;
      const button = item.querySelector('.submenu-toggle');
      item.classList.toggle('is-open', willOpen);
      if (button) {
        button.setAttribute('aria-expanded', String(willOpen));
      }

      if (!willOpen) {
        if (focus === 'toggle' && button instanceof HTMLElement) {
          button.focus();
        }
        return;
      }

      const links = getSubmenuLinks(item);
      if (!links.length) {
        return;
      }

      if (focus === 'first') {
        links[0].focus();
      } else if (focus === 'last') {
        links[links.length - 1].focus();
      }
    };

    const clearCloseTimer = (item) => {
      const timer = closeTimers.get(item);
      if (timer) {
        window.clearTimeout(timer);
        closeTimers.delete(item);
      }
    };

    const closeAllSubmenus = (exceptItem = null) => {
      submenuItems.forEach((item) => {
        if (item === exceptItem) {
          clearCloseTimer(item);
          return;
        }

        item.classList.remove('is-hovered');
        setSubmenuState(item, false);
      });
    };

    const scheduleDesktopClose = (item) => {
      if (isCompactNavViewport()) return;
      clearCloseTimer(item);
      const timer = window.setTimeout(() => {
        item.classList.remove('is-hovered');
        setSubmenuState(item, false);
        closeTimers.delete(item);
      }, 140);
      closeTimers.set(item, timer);
    };

    submenuItems.forEach((item) => {
      const button = item.querySelector('.submenu-toggle');
      const submenu = item.querySelector('.primary-nav__submenu');
      if (!button) {
        return;
      }

      button.setAttribute('aria-haspopup', 'true');
      if (submenu?.id) {
        button.setAttribute('aria-controls', submenu.id);
      }

      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        clearCloseTimer(item);
        item.classList.remove('is-hovered');
        const willOpen = !item.classList.contains('is-open');
        closeAllSubmenus(item);
        setSubmenuState(item, willOpen, { focus: isCompactNavViewport() ? 'first' : 'none' });
      });

      button.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
          return;
        }

        event.preventDefault();
        closeAllSubmenus(item);
        setSubmenuState(item, true, { focus: event.key === 'ArrowUp' ? 'last' : 'first' });
      });

      submenu?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          setSubmenuState(item, false, { focus: 'toggle' });
          return;
        }

        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
          return;
        }

        const links = getSubmenuLinks(item);
        if (!links.length) {
          return;
        }

        const currentIndex = links.findIndex((link) => link === document.activeElement);
        if (currentIndex === -1) {
          return;
        }

        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        const nextIndex = (currentIndex + direction + links.length) % links.length;
        links[nextIndex].focus();
      });

      item.addEventListener('pointerenter', () => {
        if (isCompactNavViewport()) return;
        clearCloseTimer(item);
        closeAllSubmenus(item);
        item.classList.add('is-hovered');
        setSubmenuState(item, true);
      });

      item.addEventListener('pointerleave', () => {
        if (isCompactNavViewport()) return;
        scheduleDesktopClose(item);
      });

      submenu?.addEventListener('pointerenter', () => {
        if (isCompactNavViewport()) return;
        clearCloseTimer(item);
      });

      submenu?.addEventListener('pointerleave', () => {
        if (isCompactNavViewport()) return;
        scheduleDesktopClose(item);
      });
    });

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      if (event.target.closest('.primary-nav__item--has-submenu')) {
        return;
      }

      closeAllSubmenus();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeAllSubmenus();
      }
    });

    DJ.addSharedResizeListener(() => {
      if (!isCompactNavViewport()) {
        closeAllSubmenus();
      }
    }, { runImmediately: false });

    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) {
        return;
      }

      closeAllSubmenus();
    });
  }

  // Run navigation setup as soon as the shared header exists. The fallback for
  // already-interactive documents makes the menu resilient if this deferred
  // script is restored from cache after DOMContentLoaded has already fired.
  function bootNavigation() {
    const headerSearch = ensureSharedHeaderSearch();
    initSharedHeaderSearch(headerSearch);
    ensureFanToolsLink();
    applyActiveNavState();
    initPrimaryNav();
    initSubmenuToggles();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootNavigation, { once: true });
  } else {
    bootNavigation();
  }
})();

