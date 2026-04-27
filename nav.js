/**
 * Navigation helpers for the shared site header.
 * -----------------------------------------------------------------------------
 * This module keeps the primary navigation in sync with the current page,
 * controls the mobile menu, and manages the Sports Cards submenu for both
 * keyboard and pointer users.
 */

(() => {
  // Map body[data-page] values to the navigation link that should read as active.
  const PAGE_TO_NAV_TARGET = {
    home: 'index.html',
    shop: 'shop.html',
    'shop-hub': 'shop.html',
    'sports-hub': 'sports-cards.html',
    'sports-cards': 'sports-cards.html',
    'baseball-cards': 'sports-cards.html',
    'basketball-cards': 'sports-cards.html',
    'football-cards': 'sports-cards.html',
    comics: 'comics.html',
    collectibles: 'collectibles.html',
    wishlist: 'wishlist.html',
    about: 'about.html',
    contact: 'contact.html',
    admin: 'admin.html'
  };
  const PAGE_LABELS = {
    home: 'Home',
    shop: 'Shop',
    'shop-hub': 'Shop',
    'sports-hub': 'Sports Cards',
    'sports-cards': 'Sports Cards',
    'baseball-cards': 'Baseball Cards',
    'basketball-cards': 'Basketball Cards',
    'football-cards': 'Football Cards',
    comics: 'Comics',
    collectibles: 'Collectibles',
    wishlist: 'Wishlist',
    about: 'About',
    contact: 'Contact',
    admin: 'Admin Dashboard'
  };
  const COMPACT_NAV_BREAKPOINT = 900;
  // One shared breakpoint keeps the menu drawer and submenu behavior in sync.
  const COMPACT_NAV_QUERY = typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${COMPACT_NAV_BREAKPOINT}px)`)
    : null;
  const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function getCurrentPageLabel() {
    const pageKey = document.body.dataset.page || '';
    return PAGE_LABELS[pageKey] || 'Navigation';
  }

  function isCompactNavViewport() {
    return COMPACT_NAV_QUERY ? COMPACT_NAV_QUERY.matches : window.innerWidth <= COMPACT_NAV_BREAKPOINT;
  }

  // ---------------------------------------------------------------------------
  // Active-state management
  // ---------------------------------------------------------------------------

  /**
   * Apply the correct active/aria-current state to both top-level links and the
   * admin footer shortcut. The submenu special case avoids marking both the top
   * link and the current submenu link as aria-current at the same time.
   */
  function applyActiveNavState() {
    const pageKey = document.body.dataset.page || '';
    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    const targetFile = PAGE_TO_NAV_TARGET[pageKey] || currentFile;
    const links = [...document.querySelectorAll('.site-nav a, .admin-footer-link')];
    const navItems = [...document.querySelectorAll('.site-nav .primary-nav__item')];

    navItems.forEach((item) => item.classList.remove('is-current-section'));

    links.forEach((link) => {
      const href = link.getAttribute('href');
      const isCurrentPage = href === currentFile;
      const isSectionMatch = href === targetFile;
      const isSubmenuLink = Boolean(link.closest('.primary-nav__submenu'));
      const shouldBeActive = isCurrentPage || isSectionMatch;

      link.classList.toggle('active', shouldBeActive);
      link.removeAttribute('aria-current');

      if (!isCurrentPage) {
        return;
      }

      if (isSectionMatch && !isSubmenuLink) {
        const matchingSubmenuLink = links.find((candidate) => {
          if (candidate === link) return false;
          if (candidate.getAttribute('href') !== href) return false;
          return Boolean(candidate.closest('.primary-nav__submenu'));
        });

        if (matchingSubmenuLink) {
          return;
        }
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
    const isCompactNav = isCompactNavViewport;
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
      copy.textContent = 'Jump between departments, the wishlist, and contact links without losing your place.';

      mobileHeader.append(eyebrow, title, copy);
      nav.insertBefore(mobileHeader, nav.firstChild);
    }

    const mobileActions = nav.querySelector('.site-nav__mobile-actions');
    if (mobileActions) {
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

    if (window.DJ && typeof window.DJ.updateWishlistCount === 'function') {
      window.DJ.updateWishlistCount();
    }

    /**
     * Keep the off-canvas menu hidden from keyboard and assistive-tech users
     * while it is visually closed on small screens, without affecting desktop.
     */
    const syncMenuAccessibility = () => {
      const isOpen = nav.classList.contains('open');
      const compactNav = isCompactNav();
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

    const closeMenu = ({ restoreFocus = false } = {}) => {
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
      syncMenuAccessibility();
    };

    const openMenu = () => {
      lastFocusedBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      nav.hidden = false;
      nav.classList.add('open');
      updateMenuToggleState(true);
      document.body.classList.add('menu-open');
      syncMenuAccessibility();

      if (isCompactNav()) {
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

      if (isCompactNav()) {
        closeMenu();
      }
    });

    navBackdrop.addEventListener('click', () => {
      closeMenu({ restoreFocus: true });
    });

    const handleViewportChange = () => {
      if (!isCompactNav()) {
        closeMenu();
        syncMenuAccessibility();
        return;
      }

      syncMenuAccessibility();
    };

    if (!DJ.bindMediaQueryChange(COMPACT_NAV_QUERY, handleViewportChange)) {
      DJ.addSharedResizeListener(handleViewportChange, { runImmediately: false });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (nav.classList.contains('open')) {
          closeMenu({ restoreFocus: true });
        }
        return;
      }

      if (event.key !== 'Tab' || !nav.classList.contains('open') || !isCompactNav()) {
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
    const isCompactNav = isCompactNavViewport;
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
      if (isCompactNav()) return;
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
        setSubmenuState(item, willOpen, { focus: isCompactNav() ? 'first' : 'none' });
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
        if (isCompactNav()) return;
        clearCloseTimer(item);
        closeAllSubmenus(item);
        item.classList.add('is-hovered');
        setSubmenuState(item, true);
      });

      item.addEventListener('pointerleave', () => {
        if (isCompactNav()) return;
        scheduleDesktopClose(item);
      });

      submenu?.addEventListener('pointerenter', () => {
        if (isCompactNav()) return;
        clearCloseTimer(item);
      });

      submenu?.addEventListener('pointerleave', () => {
        if (isCompactNav()) return;
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
      if (!isCompactNav()) {
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
