/**
 * Navigation helpers for the shared site header.
 * -----------------------------------------------------------------------------
 * This module keeps the primary navigation in sync with the current page,
 * controls the mobile menu, and manages the Sports Cards submenu for both
 * keyboard and pointer users.
 */

window.DJ = window.DJ || {};

(() => {
  const SPORTS_CARDS_HUB_TARGET = 'shop.html#sports-cards';

  // Keep each page's active navigation target and drawer label together.
  const PAGE_NAV_CONFIG = Object.freeze({
    home: { target: 'index.html', label: 'Home' },
    shop: { target: 'shop.html', label: 'Shop' },
    'shop-hub': { target: 'shop.html', label: 'Shop' },
    'sports-hub': { target: SPORTS_CARDS_HUB_TARGET, label: 'Sports Cards' },
    'baseball-cards': { target: SPORTS_CARDS_HUB_TARGET, label: 'Baseball Cards' },
    'basketball-cards': { target: SPORTS_CARDS_HUB_TARGET, label: 'Basketball Cards' },
    'football-cards': { target: SPORTS_CARDS_HUB_TARGET, label: 'Football Cards' },
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
    'scout-studio': { target: '/tools/', label: 'Scout Studio' },
    policies: { target: 'about.html', label: 'Policies & Authenticity' },
    policy: { target: 'about.html', label: 'Policies & Authenticity' },
    'sell-trade-want-list': { target: 'contact.html', label: 'Sell, Trade & Want List' }
  });
  // Phones and compact tablets use the accessible drawer. Narrow desktop
  // widths retain the full horizontal menu so discovery stays visible beside
  // the catalog search rather than becoming a second hidden interaction.
  const COMPACT_NAV_BREAKPOINT = 900;
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
    // Fan-suite pages replace the storefront list with their dedicated six
    // destinations in basketball-theme.js. Do not append the generic link
    // while that replacement is being mounted (or when script order changes).
    if (document.body.dataset.page === 'fan-tools') return;

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
   * Keep the legacy Sports Cards page available for old bookmarks while
   * sending the shared menu directly to the unified Shop sports section.
   */
  function normalizeSportsCardsHubLinks() {
    const sportsItem = document.querySelector('.site-nav .primary-nav__item--has-submenu');
    if (!sportsItem) return;

    const links = sportsItem.querySelectorAll(
      ':scope > .primary-nav__item-group > a[href="sports-cards.html"], :scope > .primary-nav__submenu > li:first-child > a[href="sports-cards.html"]'
    );
    links.forEach((link) => {
      link.setAttribute('href', SPORTS_CARDS_HUB_TARGET);
    });
  }

  /**
   * Keep the account and shopping shortcuts from the homepage available in
   * every shared header. The compact drawer still exposes the full text links
   * from the primary navigation, while desktop headers get the same icon rail.
   */
  function ensureSharedHeaderUtility() {
    const headerInner = document.querySelector('.site-header .header-inner');
    if (!headerInner || document.body.dataset.page === 'home') return null;

    const existingUtility = headerInner.querySelector('.home-header-utility');
    if (existingUtility) return existingUtility;

    const utility = document.createElement('nav');
    utility.className = 'home-header-utility';
    utility.setAttribute('aria-label', 'Account and shopping tools');
    const getSharedHeaderHref = (filename) => (
      headerInner.querySelector(`.site-nav a[href$="${filename}"]`)?.getAttribute('href')
      || filename
    );
    const accountHref = getSharedHeaderHref('account.html');
    const wishlistHref = getSharedHeaderHref('wishlist.html');
    const cartHref = getSharedHeaderHref('cart.html');
    utility.innerHTML = `
      <a aria-label="Account" class="home-header-utility__icon" href="${accountHref}" title="Account">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"></circle><path d="M4.5 21a7.5 7.5 0 0 1 15 0"></path></svg>
      </a>
      <a aria-label="Wishlist" class="home-header-utility__icon" href="${wishlistHref}" title="Wishlist">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"></path></svg>
        <span class="home-header-utility__count" data-wishlist-count="0">0</span>
      </a>
      <a aria-label="Cart" class="home-header-utility__icon" data-cart-link href="${cartHref}" title="Cart">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16l-1.2 13H5.2L4 7Z"></path><path d="M9 7V5a3 3 0 0 1 6 0v2"></path></svg>
        <span class="home-header-utility__count" data-cart-count="0">0</span>
      </a>
    `;

    const nav = headerInner.querySelector('.site-nav');
    headerInner.insertBefore(utility, nav || headerInner.firstElementChild);
    window.DJ.updateWishlistCount?.();
    window.DJ.updateCartCount?.();
    return utility;
  }

  /**
   * Bind only the homepage's existing search surface. Interior templates use
   * the shared menu treatment without receiving a second search field.
   */
  function ensureSharedHeaderSearch() {
    if (document.body.dataset.page !== 'home') return null;
    return document.querySelector('.site-header .home-header-search');
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
    // CSS collapses closed submenus without adding `hidden` to every child.
    // Keep keyboard focus in the open drawer by considering only elements the
    // browser can actually render and focus at the current breakpoint.
    const getVisibleFocusableMenuElements = () => [...nav.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => (
      element instanceof HTMLElement
      && !element.hasAttribute('hidden')
      && !element.closest('[hidden]')
      && getComputedStyle(element).display !== 'none'
      && getComputedStyle(element).visibility !== 'hidden'
      && element.getClientRects().length > 0
    ));

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
        const firstFocusable = getVisibleFocusableMenuElements()[0];
        if (firstFocusable) {
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
    window.DJ.bindMediaQueryChange(COMPACT_NAV_QUERY, handleViewportChange);
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

      const focusableElements = getVisibleFocusableMenuElements();

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

    window.DJ.addSharedResizeListener(() => {
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
    ensureSharedHeaderUtility();
    ensureFanToolsLink();
    normalizeSportsCardsHubLinks();
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

