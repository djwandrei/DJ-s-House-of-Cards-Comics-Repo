/**
 * Storefront catalog controller.
 * -----------------------------------------------------------------------------
 * This module powers every product-facing experience on the site: loading product
 * data from static JSON or Supabase, normalizing product records, rendering cards,
 * filtering and faceting, syncing filters to the URL, handling wishlist actions,
 * and rendering the product details modal.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const CATALOG_LOADING_MESSAGE = 'Loading current inventory...';
  const FILTER_EMPTY_TITLE = 'No items match those filters.';
  const FILTER_EMPTY_COPY = 'Clear filters or ask DJ.';
  const WISHLIST_EMPTY_COPY = 'No saved items yet. Browse the collection, tap the heart on anything you like, and come back here to compare your shortlist before contacting DJ.';

  // Per-page configuration keeps page-specific copy, locked categories, and
  // filter labeling in one place instead of scattering those differences across
  // the rendering logic below.
  const PAGE_CONFIG = {
    shop: {
      allowedCategories: null,
      searchLabel: 'Search inventory',
      searchPlaceholder: 'Player, title, team, publisher, or keyword',
      helperText: 'Examples: Jordan rookie, All-Star, PSA, Marvel, Giants.'
    },
    'sports-hub': {
      allowedCategories: ['Baseball', 'Basketball', 'Football'],
      searchLabel: 'Search all sports cards',
      searchPlaceholder: 'Player, set, team, slab, parallel, or keyword',
      helperText: 'Examples: Jordan rookie, Brady auto, Topps Chrome, PSA 9, All-Star.'
    },
    comics: {
      allowedCategories: ['Comics'],
      searchLabel: 'Search comics',
      searchPlaceholder: 'Title, character, issue number, publisher, or keyword',
      helperText: 'Examples: Spider-Man, Batman, #1, Venom, newsstand, key issue.'
    },
    collectibles: {
      allowedCategories: ['Collectibles', 'Other'],
      searchLabel: 'Search collectibles',
      searchPlaceholder: 'Autograph, jersey, display, signed, memorabilia, or keyword',
      helperText: 'Examples: signed ball, jersey, autograph, display piece, photo.'
    },
    'baseball-cards': {
      allowedCategories: ['Baseball'],
      searchLabel: 'Search baseball cards',
      searchPlaceholder: 'Player, set, team, slab, parallel, or keyword',
      helperText: 'Examples: Mays, Mantle, rookie, Topps, PSA 5, autograph.'
    },
    'basketball-cards': {
      allowedCategories: ['Basketball'],
      searchLabel: 'Search basketball cards',
      searchPlaceholder: 'Player, set, team, slab, refractor, or keyword',
      helperText: 'Examples: Jordan, Kobe, rookie, auto, refractor, PSA 10.'
    },
    'football-cards': {
      allowedCategories: ['Football'],
      searchLabel: 'Search football cards',
      searchPlaceholder: 'Player, set, team, slab, rookie, or keyword',
      helperText: 'Examples: Brady, Mahomes, rookie, auto, patch, PSA 9.'
    }
  };

  // Each page reads from a smaller source file where possible so the storefront
  // only downloads the data needed for that page. Wishlist intentionally uses the
  // full catalog so saved items can always be resolved.
  const PRODUCT_SOURCE_BY_PAGE = {
    home: 'products-featured.json',
    'shop-hub': 'products-sports.json',
    'sports-hub': 'products-sports.json',
    'baseball-cards': 'products-baseball.json',
    'basketball-cards': 'products-basketball.json',
    'football-cards': 'products-football.json',
    comics: 'products-comics.json',
    collectibles: 'products-collectibles.json',
    wishlist: 'products-public.json',
    cart: 'products-public.json'
  };
  const BOOTSTRAP_SOURCE_BY_SOURCE = {
    'products-baseball.json': 'products-bootstrap-baseball.json',
    'products-basketball.json': 'products-bootstrap-basketball.json',
    'products-football.json': 'products-bootstrap-football.json',
    'products-comics.json': 'products-bootstrap-comics.json',
    'products-collectibles.json': 'products-bootstrap-collectibles.json'
  };

  const DEFAULT_PRODUCT_SOURCE = 'products-public.json';
  const staticProductCache = new Map();
  const catalogBootstrapCache = new Map();
  const normalizedSourceCache = new Map();
  const catalogPageCache = new Map();
  const filteredCatalogResultsCache = new Map();
  const catalogProductsSignatureCache = new WeakMap();
  const productCardGalleryCache = new WeakMap();
  const FILTERED_RESULTS_CACHE_LIMIT = 18;
  const CATALOG_BACKGROUND_HYDRATION_DELAY = 2500;
  const gridProductLookups = new WeakMap();
  const gridProductSequences = new WeakMap();
  const DEFAULT_RENDER_BATCH_SIZE = 24;
  const DESKTOP_FILTER_BREAKPOINT = 900;
  const FILTER_SIDEBAR_VISIBILITY_KEY = 'catalogSidebarVisible';
  const SIDEBAR_DEFAULT_OPEN_PAGES = new Set([
    'baseball-cards',
    'basketball-cards',
    'football-cards',
    'comics',
    'collectibles',
    'wishlist'
  ]);
  const PAGE_RENDER_BATCH_SIZES = {
    wishlist: 18,
    collectibles: 20
  };
  const DEFAULT_CATALOG_ITEMS_PER_PAGE = 48;
  const CATALOG_ITEMS_PER_PAGE_OPTIONS = [24, 48, 72];
  // One ordered map drives sort validation, labels, and both select controls.
  const DEFAULT_CATALOG_SORT = 'nameAsc';
  const CATALOG_SORT_LABELS = Object.freeze({
    nameAsc: 'Name A to Z',
    nameDesc: 'Name Z to A',
    priceAsc: 'Price low to high',
    priceDesc: 'Price high to low',
    yearAsc: 'Oldest first',
    yearDesc: 'Newest first'
  });
  const PRODUCT_LINK_PARAM = 'item';
  const MODAL_FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const FILTER_PANEL_FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

  let debounceTimer = 0;
  let updateMobileFilterState = null;
  let currentCatalogPage = 1;
  let currentCatalogItemsPerPage = DEFAULT_CATALOG_ITEMS_PER_PAGE;
  let wishlistPageRefreshTimer = 0;
  let catalogRenderRequestId = 0;
  let wishlistRenderRequestId = 0;
  let cartRenderRequestId = 0;
  let linkedProductAutoOpenedId = null;
  let activeModalProductId = null;
  let activeModalContextProducts = [];
  let modalSlabStatsRequestId = 0;
  let nbaSlabStatsModulePromise = null;
  let cartActionFeedbackTimer = 0;

  function setFilterPanelDescendantsFocusable(filterPanel, enabled) {
    if (!filterPanel) return;
    filterPanel.querySelectorAll(FILTER_PANEL_FOCUSABLE_SELECTOR).forEach((element) => {
      if (!(element instanceof HTMLElement)) return;
      if (enabled) {
        if (element.dataset.filterPanelPreviousTabindex != null) {
          const previous = element.dataset.filterPanelPreviousTabindex;
          if (previous) element.setAttribute('tabindex', previous);
          else element.removeAttribute('tabindex');
          delete element.dataset.filterPanelPreviousTabindex;
        }
        return;
      }

      if (element.dataset.filterPanelPreviousTabindex == null) {
        element.dataset.filterPanelPreviousTabindex = element.getAttribute('tabindex') || '';
      }
      element.setAttribute('tabindex', '-1');
    });
  }

  const PRODUCT_ATTRIBUTE_ORDER = [
    'Autograph',
    'Rookie',
    'Serial Numbered',
    'One of One',
    'Short Print',
    'Memorabilia',
    'Parallel/Variety',
    'Insert',
    'Error'
  ];
  const KNOWN_PRODUCT_ATTRIBUTES = new Set(PRODUCT_ATTRIBUTE_ORDER);
  const PRODUCT_ATTRIBUTE_ORDER_INDEX = new Map(
    PRODUCT_ATTRIBUTE_ORDER.map((attribute, index) => [attribute, index])
  );
  const PRODUCT_ATTRIBUTE_ALIASES = new Map([
    ['auto', 'Autograph'],
    ['autographed', 'Autograph'],
    ['autograph', 'Autograph'],
    ['signed', 'Autograph'],
    ['rookie', 'Rookie'],
    ['rc', 'Rookie'],
    ['serial numbered', 'Serial Numbered'],
    ['numbered', 'Serial Numbered'],
    ['one of one', 'One of One'],
    ['1 of 1', 'One of One'],
    ['1/1', 'One of One'],
    ['short print', 'Short Print'],
    ['ssp', 'Short Print'],
    ['memorabilia', 'Memorabilia'],
    ['relic', 'Memorabilia'],
    ['jersey', 'Memorabilia'],
    ['patch', 'Memorabilia'],
    ['parallel', 'Parallel/Variety'],
    ['parallel/variety', 'Parallel/Variety'],
    ['parallel / variety', 'Parallel/Variety'],
    ['parallel/variation', 'Parallel/Variety'],
    ['variation', 'Parallel/Variety'],
    ['variety', 'Parallel/Variety'],
    ['insert', 'Insert'],
    ['error', 'Error'],
    ['err', 'Error']
  ]);
  const REMOVED_VIDEO_GAME_LISTING_IDS = new Set([
    2700, 2701, 2702, 2703, 2704, 2705, 2706, 2707, 2708, 2709,
    2710, 2711, 2713, 2714, 2715, 2716, 2717, 2718, 2719
  ]);
  const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const SEARCH_ALIAS_RULES = [
    [/\brc\b/g, ' rookie '],
    [/\bauto\b/g, ' autograph '],
    [/\bsig\b/g, ' signature '],
    [/\bspiderman\b/g, ' spider man '],
    [/\bplayoff\b/g, ' playoffs ']
  ];

  function parseConditionDetails(rawCondition = '') {
    const raw = String(rawCondition || '').trim();
    const defaultUngradedCondition = 'Near Mint or Better';
    const rawParts = raw
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    const uniqueRawParts = [];
    const seenRawParts = new Set();
    rawParts.forEach((part) => {
      const key = part.toLowerCase();
      if (seenRawParts.has(key)) return;
      seenRawParts.add(key);
      uniqueRawParts.push(part);
    });
    const hasUngradedPart = uniqueRawParts.some((part) => /^ungraded$/i.test(part));
    const hasGuideRangePart = uniqueRawParts.some((part) => /^guide range listed$/i.test(part));
    const displayRaw = hasUngradedPart
      ? 'Ungraded'
      : (uniqueRawParts.length ? uniqueRawParts.join(' | ') : raw);
    const ungradedCondition = displayRaw.toLowerCase() === 'near mint or better'
      ? defaultUngradedCondition
      : (displayRaw || defaultUngradedCondition);
    const companyMatch = displayRaw.match(/\b(PSA\/DNA|PSA|BGS|BVG|BCCG|SGC|CGC|CSG|HGA|GMA|ISA|BECKETT)\b/i);

    if (companyMatch) {
      const company = companyMatch[1].toUpperCase() === 'BECKETT' ? 'Beckett' : companyMatch[1].toUpperCase();
      let grade = displayRaw.slice((companyMatch.index || 0) + companyMatch[0].length).trim();
      grade = grade.replace(/^[\s:\u2013\u2014-]+/, '').trim();
      if (!grade) grade = 'Authenticated';

      // Authenticated-only cards are certified, but not numerically graded.
      // Keep their exact condition visible while leaving them in the Ungraded facet.
      const hasNumericGrade = /(?:^|\s)(?:10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)(?:\s|$)/i.test(grade);
      const authenticatedOnly = /authentic|authenticated|certified/i.test(displayRaw) && !hasNumericGrade;
      if (authenticatedOnly) {
        return { raw, status: 'Ungraded', company, grade, summary: displayRaw, compact: displayRaw };
      }

      return { raw, status: 'Graded', company, grade, summary: `Graded | ${company} ${grade}`.trim(), compact: `${company} ${grade}`.trim() };
    }

    if (hasUngradedPart || hasGuideRangePart || /^ungraded$/i.test(ungradedCondition)) {
      return { raw, status: 'Ungraded', company: '', grade: '', summary: 'Ungraded', compact: 'Ungraded' };
    }

    return { raw, status: 'Ungraded', company: '', grade: '', summary: ungradedCondition, compact: ungradedCondition };
  }

  function shouldSuppressCollectibleCondition(item = {}, category = '', conditionInfo = {}) {
    if (!/collectibles/i.test(String(category || ''))) return false;
    if (conditionInfo.status === 'Graded' || conditionInfo.company || conditionInfo.grade) return false;

    const raw = String(conditionInfo.raw || item.condition || '').trim();
    if (!raw) return false;
    if (/\b(?:poor|fair|good|very good|excellent|mint|near mint|nm|graded|psa|sgc|bgs|cgc|beckett)\b/i.test(raw)) {
      return false;
    }

    return /\b(?:autographed?|signed|signature|multi[- ]signed|memorabilia|collectible|baseball|bat|ball|postcard|photo|display|program)\b/i.test(raw);
  }

  function hasSerialNumberingContext(value = '') {
    return /\b(?:gold|silver|bronze|blue|red|green|purple|orange|pink|black|aqua|yellow|fuchsia|lime|cyan|white|emerald|sepia|tie-dye|rainbow|platinum|foil|border|parallel|refractor|prizm|holo|shimmer|wave|lava|pulsar|speckle|mojo|ice|glitter|chrome|optic|choice|cosmic|sapphire|x-?fractor|die[- ]cut|press proof|aspirations|status|mirror|prime|the finals|playoff ticket|premium stock|masterpieces|limited|numbered|serial|short print|sp|ssp|auto|autographs?|au|signatures?|sigs?|patch|relic|memorabilia|jersey|materials?|swatch|prospect)\b/.test(value);
  }

  function hasSerialNumberedSignal(item = {}, excelFields = {}) {
    // Serial-number checks intentionally avoid generated description text.
    // Descriptions can inherit old workbook mistakes, while the title carries
    // the reliable numbering context buyers actually see. Be conservative:
    // vintage card numbers such as "John Long/18 Magic Johnson AS/237" are
    // not serial-numbered without a surrounding parallel/limited-print signal.
    const titleText = [
      item.name || '',
      excelFields['Title'] || '',
      item.condition || '',
      item.legacyImageLabel || ''
    ].join(' ').toLowerCase();
    const explicitSerialText = /\bserial[- ](?:ly[- ])?numbered\b|\bnumbered\s+(?:to|\/)\s*\d+\b|\blimited\s+to\s+\d+\b|\bone\s+of\s+one\b|\b1\s*of\s*1\b|\b1\/1\b/.test(titleText);
    if (explicitSerialText) return true;

    const hasSlashSerial = titleText.split(/\s+\+\s+/).some((segment) => {
      const matches = segment.matchAll(/\/\s*(\d{1,4})\b/g);
      for (const match of matches) {
        const denominator = Number(match[1]);
        const after = segment.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 30);
        if (/^\s*(?:cards?|pcs?|boxes?|packs?)\b/.test(after)) continue;
        const before = segment.slice(Math.max(0, (match.index || 0) - 90), match.index || 0);
        // A common denominator alone is not enough. Vintage multi-player card
        // numbers such as "Long/18 Magic Johnson AS/237" otherwise look like
        // serial numbering even though there is no parallel or limited context.
        if (denominator >= 1900 && denominator <= 2035 && !hasSerialNumberingContext(before)) continue;
        if (!hasSerialNumberingContext(before)) continue;
        return true;
      }
      return false;
    });
    if (hasSlashSerial) return true;

    return false;
  }

  function normalizeProductAttribute(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (KNOWN_PRODUCT_ATTRIBUTES.has(raw)) return raw;

    const key = raw
      .toLowerCase()
      .replace(/\s*\/\s*/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
    return PRODUCT_ATTRIBUTE_ALIASES.get(key) || '';
  }

  function splitProductAttributeValue(value = '') {
    if (Array.isArray(value)) return value.flatMap((entry) => splitProductAttributeValue(entry));
    return String(value || '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function pushProductAttribute(attributes, value) {
    const attribute = normalizeProductAttribute(value);
    if (!attribute || attributes.includes(attribute)) return;
    attributes.push(attribute);
  }

  function sortProductAttributes(attributes = []) {
    return [...attributes].sort((a, b) => {
      const aOrder = PRODUCT_ATTRIBUTE_ORDER_INDEX.get(a) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = PRODUCT_ATTRIBUTE_ORDER_INDEX.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.localeCompare(b);
    });
  }

  function deriveProductAttributes(item = {}) {
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const excelFields = metadata.excelFields && typeof metadata.excelFields === 'object' ? metadata.excelFields : {};
    const autographedValue = String(excelFields['C:Autographed'] || '').trim().toLowerCase();
    const isWorkbookBackedListing = Object.keys(excelFields).length > 0;
    // Workbook listings define their own attributes. Keep the reconciled
    // array authoritative so wording such as "Autographed: No" in a
    // description cannot manufacture an Autograph tag at render time. A small
    // field-derived fallback supports older source rows that lack the array.
    if (isWorkbookBackedListing) {
      const attributes = [];
      const sourceAttributes = Array.isArray(item.attributes)
        ? item.attributes
        : splitProductAttributeValue(excelFields['C:Features']);
      sourceAttributes.forEach((attribute) => pushProductAttribute(attributes, attribute));
      if (autographedValue === 'yes') pushProductAttribute(attributes, 'Autograph');
      return sortProductAttributes(attributes);
    }
    const conditionNotes = Array.isArray(metadata.conditionNotes)
      ? metadata.conditionNotes.join(' ')
      : (metadata.conditionNotes || '');
    const featuresText = String(excelFields['C:Features'] || '').toLowerCase();
    const featureSet = new Set(featuresText.split('|').map((value) => value.trim()).filter(Boolean));
    const text = [
      item.name || '',
      item.description || '',
      item.condition || '',
      conditionNotes,
      item.priceLabel || '',
      item.playerAthlete || '',
      metadata.playerAthlete || '',
      item.team || '',
      item.legacyImageLabel || '',
      excelFields['Title'] || '',
      excelFields['Description'] || '',
      excelFields['C:Features'] || '',
      excelFields['C:Autographed'] || '',
      excelFields['C:Player/Athlete'] || '',
      excelFields['C:Team'] || '',
      excelFields['CD:Professional Grader - (ID: 27501)'] || '',
      excelFields['CD:Grade - (ID: 27502)'] || ''
    ].join(' ').toLowerCase();
    const attributes = [];
    if (!featureSet.size && Array.isArray(item.attributes)) {
      item.attributes.forEach((attribute) => {
        // Re-evaluate serial numbering from the current title/features instead
        // of trusting stale derived attributes from earlier imports.
        if (normalizeProductAttribute(attribute) === 'Serial Numbered') return;
        pushProductAttribute(attributes, attribute);
      });
    }
    splitProductAttributeValue(excelFields['C:Features']).forEach((feature) => pushProductAttribute(attributes, feature));
    const hasAutographLanguage = (
      /\bauto(?:s|graph(?:ed|s)?|graphed|s)?\b|\bau\b|\bsigned\b|\bsignatures\b|\bsigs?\b|\bink\b|\bscript(?:s)?\b|\binscriptions?\b|\bpenmanship\b|\bsignature(?!\s+rookies)\b|\bpsa\/dna certified authentic\b|\b(?:sticker|on-card|hard-signed)\s+auto\b/.test(text)
      || /\bsignature\s+(?:series|shots|marks|materials|patch|jersey|memorabilia|autographs?)\b/.test(text)
    );
    const hasOneOfOneLanguage = /\bone\s+of\s+one\b|\b1\s*of\s*1\b|\b1\/1\b|\bprinting plate\b|\bpre[- ]production proof\b/.test(text);
    const hasShortPrintLanguage = /\bshort[- ]print\b|\bssp\b/.test(text);
    const hasMemorabiliaLanguage = (
      /\bmemorabilia\b|\brelics?\b|\bjerseys?\b|\bjsy\b|\bpatch(?:es)?\b|\bswatches?\b|\bfabric\b|\bmaterials?\b|\bgame[- ](?:used|worn|bat)\b|\bpiece\s+of\s+the\s+game\b|\bplayer[- ]worn\b|\bclubhouse collection\b|\bby the letter\b/.test(text)
      || /\b(?:black gold|throwback|rookie team|team|throwback)\s+threads\b|\bhot numbers game used\b|\bauthentic fabric\b|\bfabric of the future\b|\bsp game bat edition\b|\bbat kings\b|\bautograph-bat\b/.test(text)
    );
    const hasParallelLanguage = (
      /\bparallel\b|\bvariation\b|\bvariety\b|\brefractors?\b|\bprizms?\b|\bfoils?\b|\bholo(?:foil)?\b|\bshimmer\b|\bwave\b|\blava\b|\bpulsar\b|\bspeckle\b|\bmojo\b|\bice\b|\bglitter\b|\bsapphire\b|\bx-?fractor\b|\bdie[- ]cut\b|\bpress proof\b/.test(text)
      || /\b(?:gold|silver|bronze|blue|red|green|purple|orange|pink|black|aqua|yellow|fuchsia|lime|cyan|white|emerald|sepia)\s+(?:border|foil|parallel|refractor|prizm|holo|wave|shimmer|glitter|proof)\b/.test(text)
    );
    const hasInsertLanguage = /\binserts?\b|\bcase hit\b|\bvariation insert\b/.test(text);
    const hasErrorLanguage = /\berrors?\b|\berr\b|\bwrong back\b|\bmisspell(?:ed|ing)\b|\bmisprint\b/.test(text);

    if (/\brookies?\b|\brc\b|\brookie related\b|\brated rookie\b|\bpre[- ]rookie\b/.test(text)) pushProductAttribute(attributes, 'Rookie');
    if (hasAutographLanguage || autographedValue === 'yes') pushProductAttribute(attributes, 'Autograph');
    if (hasSerialNumberedSignal(item, excelFields)) pushProductAttribute(attributes, 'Serial Numbered');
    if (hasOneOfOneLanguage) pushProductAttribute(attributes, 'One of One');
    if (hasShortPrintLanguage) pushProductAttribute(attributes, 'Short Print');
    if (hasMemorabiliaLanguage) pushProductAttribute(attributes, 'Memorabilia');
    if (hasParallelLanguage) pushProductAttribute(attributes, 'Parallel/Variety');
    if (hasInsertLanguage) pushProductAttribute(attributes, 'Insert');
    if (hasErrorLanguage) pushProductAttribute(attributes, 'Error');

    return sortProductAttributes(attributes);
  }

  function renderAttributeTags(attributes = [], options = {}) {
    if (!Array.isArray(attributes) || !attributes.length) return '';
    const className = options.className || 'product-attribute-list';
    return `<div class="${DJ.escapeHtml(className)}">${attributes.map((attribute) => `<span class="product-attribute-pill">${DJ.escapeHtml(attribute)}</span>`).join('')}</div>`;
  }

  function getProductCardAttributes(attributes = []) {
    if (!Array.isArray(attributes) || !attributes.length) return [];

    // Keep grid cards aligned with the normalized product attributes so buyer
    // signals such as Rookie, Insert, and Short Print are not hidden.
    return attributes.filter((attribute) => KNOWN_PRODUCT_ATTRIBUTES.has(String(attribute || '').trim()));
  }

  /**
   * Preserve human-friendly name casing inside product-card pills without
   * forcing every underlying catalog record to be perfectly title-cased first.
   */
  function formatDisplayName(value = '') {
    const normalizeToken = (token = '') => {
      const raw = String(token || '').trim();
      if (!raw) return '';
      if (/^([A-Z]\.){1,4}$/.test(raw)) return raw.toUpperCase();
      if (/^[A-Z]{2,3}$/.test(raw)) return raw;
      if (/^(ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(raw)) return raw.toUpperCase();
      if (/^(jr|sr)\.?$/i.test(raw)) return `${raw.charAt(0).toUpperCase()}${raw.charAt(1).toLowerCase()}.`;

      return raw.split(/([-'/])/).map((segment) => {
        if (!segment || /^[-'/]$/.test(segment)) return segment;
        if (/^([A-Z]\.){1,4}$/.test(segment)) return segment.toUpperCase();
        if (/^[A-Z]{2,3}$/.test(segment)) return segment;
        if (/^(ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(segment)) return segment.toUpperCase();

        const lower = segment.toLowerCase();
        if (/^mc[a-z]/.test(lower)) {
          return `Mc${lower.charAt(2).toUpperCase()}${lower.slice(3)}`;
        }

        return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
      }).join('');
    };

    return String(value || '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split(/\s+/).map(normalizeToken).join(' '))
      .join(' | ');
  }

  // ---------------------------------------------------------------------------
  // Catalog metadata and filter helpers
  // ---------------------------------------------------------------------------

  function badgeLabel(category) {
    const labels = {
      Comics: 'Comic Book',
      Collectibles: 'Collectible',
      Other: 'Collectible'
    };

    return labels[category] || category;
  }

  function getProductPriceLabel(product = {}) {
    const displayPrice = DJ.displayPrice(product);
    if (/contact/i.test(displayPrice)) return 'Availability';
    return 'Price';
  }

  function isDirectCheckoutCandidate(product = {}) {
    return DJ.isDirectCheckoutEligible(product);
  }

  function getProductActionLabel(product = {}, context = 'card') {
    if (isDirectCheckoutCandidate(product)) return 'Buy It Now';
    return context === 'modal' ? 'Ask About This Item' : 'Ask DJ';
  }

  function getProductContextLabel(product = {}) {
    const normalizedCategory = String(product.category || '').trim().toLowerCase();
    if (normalizedCategory === 'comics') return 'Publisher';
    if (normalizedCategory === 'collectibles' || normalizedCategory === 'other') return 'Collection';
    return 'Team';
  }

  function getProductPrimaryContext(product = {}) {
    return normalizeTeamFacetValue(product.team, product);
  }

  const GENERIC_TEAM_FACET_VALUES = new Set([
    'baseball',
    'basketball',
    'football',
    'comics',
    'collectibles',
    'other',
    'sports cards',
    'mlb',
    'nba',
    'nfl',
    'legacy baseball import',
    'legacy basketball import',
    'legacy football import',
    'overtime elite'
  ]);

  const GENERIC_TEAM_FACET_PATTERNS = [
    /\b(import|current catalog|unknown|not listed)\b/i,
    /\b(baseball|basketball|football)\s+(cards?|only|import)\b/i,
    /\b(bowman|chronicles|contenders|donruss|fleer|hoops|leaf|mosaic|panini|press pass|prizm|sage|score board|select|topps|upper deck)\b/i,
    /\b(19|20)\d{2}(?:-\d{2})?\s+(rookie|insert|chrome|finest|signature|platinum|heritage|draft)\b/i
  ];

  function isGenericTeamFacetValue(value, product = {}) {
    const rawValue = String(value || '').trim();
    const normalizedValue = rawValue.toLowerCase();

    if (!normalizedValue) {
      return true;
    }

    const normalizedComparisons = [
      product.category,
      product.sport,
      product.league,
      product.sourcePage
    ].map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);

    if (GENERIC_TEAM_FACET_VALUES.has(normalizedValue) || normalizedComparisons.includes(normalizedValue)) {
      return true;
    }

    return GENERIC_TEAM_FACET_PATTERNS.some((pattern) => pattern.test(rawValue));
  }

  function normalizeTeamFacetValue(value, product = {}) {
    const rawValue = String(value || '').trim();
    return isGenericTeamFacetValue(rawValue, product) ? '' : rawValue;
  }

  function renderModalFactStrip(product = {}, galleryCount = 1, displayPrice = DJ.displayPrice(product)) {
    // Keep condition/grade as the single source of truth in the quick facts.
    // The meta grid below intentionally skips it so modals do not show
    // duplicated values such as "Ungraded | Ungraded | Guide range listed".
    const guideRange = DJ.priceRangeLabel(product);
    const conditionFactValue = product.conditionCompact || product.conditionFacet || '';
    const facts = [
      {
        label: getProductPriceLabel(product),
        value: displayPrice,
        tone: 'price'
      },
      ...(guideRange ? [{
        label: 'Guide range',
        value: guideRange
      }] : []),
      ...(conditionFactValue ? [{
        label: product.conditionFacet === 'Graded' ? 'Grade' : 'Condition',
        value: conditionFactValue
      }] : [])
    ];

    if (Number.isFinite(Number(galleryCount)) && Number(galleryCount) > 1) {
      facts.push({ label: 'Photos', value: String(galleryCount) });
    }

    if (product.id != null && product.id !== '') {
      facts.push({ label: 'Listing ID', value: `#${product.id}` });
    }

    const sourcePage = String(product.sourcePage || '').trim();
    if (sourcePage && facts.length < 4) {
      facts.push({ label: 'Source', value: sourcePage });
    }

    return `
      <div class="modal-fact-strip" aria-label="Quick listing facts">
        ${facts.map((fact) => `
          <div class="modal-fact${fact.tone ? ` modal-fact--${DJ.escapeHtml(fact.tone)}` : ''}">
            <span>${DJ.escapeHtml(fact.label)}</span>
            <strong>${DJ.escapeHtml(fact.value)}</strong>
          </div>
        `).join('')}
      </div>
    `;
  }

  function renderModalMetaGrid(product = {}) {
    const contextValue = getProductPrimaryContext(product);
    const playerAthlete = String(product.playerAthlete || '').trim();
    // These are context fields only; price and condition live in the fact strip
    // where shoppers can scan them quickly without repeated labels.
    const entries = [
      ['Year', product.yearLabel && product.yearLabel !== 'Year not listed' ? product.yearLabel : 'Not listed'],
      [getProductContextLabel(product), contextValue],
      ['Sport', product.sport || product.category],
      ['League', product.league],
      ['Player / Athlete', playerAthlete ? formatDisplayName(playerAthlete) : '']
    ].filter(([, value]) => String(value || '').trim());

    return `
      <div class="modal-meta-grid">
        ${entries.map(([label, value]) => `
          <p><strong>${DJ.escapeHtml(label)}:</strong> ${DJ.escapeHtml(value)}</p>
        `).join('')}
      </div>
    `;
  }

  function buildProductImageAlt(product = {}, options = {}) {
    const yearLabel = String(product.yearLabel || product.year || '').trim();
    const name = String(product.name || '').trim();
    const team = String(normalizeTeamFacetValue(product.team, product) || '').trim();
    const category = String(product.category || product.sport || 'Item').trim();
    const photoIndex = Number(options.photoIndex);
    const photoCount = Number(options.photoCount);
    const isGalleryPhoto = Number.isFinite(photoIndex) && photoIndex > 0;

    const normalizedName = name.toLowerCase();
    const shouldPrefixYear = yearLabel && !normalizedName.startsWith(yearLabel.toLowerCase());
    const base = [shouldPrefixYear ? yearLabel : '', name].filter(Boolean).join(' ').trim() || category;
    const details = [];

    if (team && !base.toLowerCase().includes(team.toLowerCase())) {
      details.push(team);
    }

    if (category && !base.toLowerCase().includes(category.toLowerCase())) {
      details.push(`${category.toLowerCase()} listing`);
    }

    if (isGalleryPhoto) {
      details.push(`photo ${photoIndex}${Number.isFinite(photoCount) && photoCount > 1 ? ` of ${photoCount}` : ''}`);
    } else if (options.context === 'modal') {
      details.push('full-size product photo');
    } else {
      details.push('product photo');
    }

    return [base, ...details].filter(Boolean).join(', ');
  }

  function getTeamFacetLabel(config = {}) {
    if (config.teamLabel) return config.teamLabel;
    const page = document.body.dataset.page || '';
    if ((config.allowedCategories || []).length === 1 && config.allowedCategories[0] === 'Comics') return 'Publisher';
    if (['sports-cards', 'baseball-cards', 'basketball-cards', 'football-cards'].includes(page)) return 'Team';
    return 'Team / Publisher';
  }

  function parseMultiValueParams(params, key) {
    const values = params.getAll(key)
      .flatMap((value) => String(value || '').split(','))
      .map((value) => value.trim())
      .filter(Boolean);

    return [...new Set(values)];
  }

  function cssEscapeValue(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }

    return String(value)
      .split('\\').join('\\\\')
      .split('"').join('\\"');
  }

  function getCheckedFacetValues(name) {
    return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((input) => input.value);
  }

  function getRenderBatchSize(page = document.body.dataset.page || '') {
    return PAGE_RENDER_BATCH_SIZES[page] || DEFAULT_RENDER_BATCH_SIZE;
  }

  function sanitizeCatalogPage(value) {
    const page = Number.parseInt(value, 10);
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  function sanitizeItemsPerPage(value) {
    const parsed = Number.parseInt(value, 10);
    return CATALOG_ITEMS_PER_PAGE_OPTIONS.includes(parsed)
      ? parsed
      : DEFAULT_CATALOG_ITEMS_PER_PAGE;
  }

  function getPaginationState(totalItems) {
    const totalCount = Math.max(0, Number(totalItems) || 0);
    const perPage = sanitizeItemsPerPage(currentCatalogItemsPerPage);
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const page = Math.min(Math.max(1, sanitizeCatalogPage(currentCatalogPage)), totalPages);
    const startIndex = totalCount ? (page - 1) * perPage : 0;
    const endIndex = Math.min(startIndex + perPage, totalCount);

    currentCatalogPage = page;
    currentCatalogItemsPerPage = perPage;

    return {
      page,
      perPage,
      totalPages,
      totalCount,
      startIndex,
      endIndex
    };
  }

  function getVisiblePageNumbers(page, totalPages, maxVisible = 9) {
    if (totalPages <= maxVisible) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    // Keep the first and last pages reachable while centering the current page.
    // Ellipses make large catalogs less overwhelming without hiding navigation.
    const middleSlots = Math.max(3, maxVisible - 4);
    const halfWindow = Math.floor(middleSlots / 2);
    let start = Math.max(2, page - halfWindow);
    const end = Math.min(totalPages - 1, start + middleSlots - 1);
    start = Math.max(2, Math.min(start, end - middleSlots + 1));

    const pages = [1];
    if (start > 2) pages.push(start === 3 ? 2 : 'start-ellipsis');
    for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
      pages.push(pageNumber);
    }
    if (end < totalPages - 1) pages.push(end === totalPages - 2 ? totalPages - 1 : 'end-ellipsis');
    pages.push(totalPages);
    return pages;
  }

  /**
   * Build the catalog facet counts in a single pass so large category pages do
   * not repeatedly traverse the same product list just to populate filters.
   */
  function buildFacetSummary(products = []) {
    const conditionCounts = new Map();
    const attributeCounts = new Map();
    const teamCounts = new Map();

    for (const product of (Array.isArray(products) ? products : [])) {
      const condition = String(product?.conditionFacet || '').trim();
      if (condition) {
        conditionCounts.set(condition, (conditionCounts.get(condition) || 0) + 1);
      }

      const team = String(product?._teamFacet || '').trim();
      if (team) {
        teamCounts.set(team, (teamCounts.get(team) || 0) + 1);
      }

      const attributes = Array.isArray(product?.attributes) ? product.attributes : [];
      for (const rawAttribute of attributes) {
        const attribute = String(rawAttribute || '').trim();
        if (attribute) {
          attributeCounts.set(attribute, (attributeCounts.get(attribute) || 0) + 1);
        }
      }
    }

    return {
      conditionCounts,
      attributeCounts,
      teamCounts,
      availableAttributes: PRODUCT_ATTRIBUTE_ORDER.filter((attribute) => attributeCounts.has(attribute)),
      teamValues: [...teamCounts.keys()].sort((left, right) => TEXT_COLLATOR.compare(left, right))
    };
  }

  function toCountedFacetOptions(values = [], countMap = new Map(), selectedValues = []) {
    const selected = new Set(selectedValues);
    const options = [];

    for (const rawValue of (Array.isArray(values) ? values : [])) {
      const value = String(rawValue || '').trim();
      if (value) {
        options.push({ value, count: countMap.get(value) || 0, selected: selected.has(value) });
      }
    }

    return options.sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      if (left.count !== right.count) return right.count - left.count;
      return TEXT_COLLATOR.compare(left.value, right.value);
    });
  }

  function getSortLabel(value = DEFAULT_CATALOG_SORT) {
    return Object.hasOwn(CATALOG_SORT_LABELS, value) ? CATALOG_SORT_LABELS[value] : value;
  }

  function syncToolbarSortControl(value = DEFAULT_CATALOG_SORT) {
    const toolbarSort = document.getElementById('toolbarSortSelect');
    if (toolbarSort && toolbarSort.value !== value) {
      toolbarSort.value = value;
    }
  }

  function normalizeSearchString(value = '') {
    let normalized = String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/([a-z])['\u2019\u2018\u02bc]([a-z])/g, '$1$2')
      .replace(/&/g, ' and ')
      .replace(/#/g, ' number ')
      .replace(/([a-z])(\d)/gi, '$1 $2')
      .replace(/(\d)([a-z])/gi, '$1 $2');

    SEARCH_ALIAS_RULES.forEach(([pattern, replacement]) => {
      normalized = normalized.replace(pattern, replacement);
    });

    return normalized
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function tokenizeSearchString(value = '') {
    return [...new Set(
      normalizeSearchString(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length > 1 || /^\d+$/.test(token))
    )];
  }

  /**
   * Compile the shopper's raw search text once per render so the filter loop does
   * not repeatedly normalize and tokenize the same query for every product card.
   */
  function createSearchQueryState(query = '') {
    const normalizedQuery = normalizeSearchString(query);
    if (!normalizedQuery) {
      return null;
    }

    return {
      normalizedQuery,
      tokens: tokenizeSearchString(query)
    };
  }

  function matchesSearchQuery(product, queryState) {
    const normalizedQuery = typeof queryState === 'string'
      ? normalizeSearchString(queryState)
      : queryState?.normalizedQuery || '';
    if (!normalizedQuery) return true;

    const tokens = typeof queryState === 'string'
      ? tokenizeSearchString(queryState)
      : Array.isArray(queryState?.tokens) ? queryState.tokens : [];
    const searchableText = product?._searchNormalized || '';
    if (searchableText.includes(normalizedQuery)) {
      return true;
    }

    return tokens.every((token) => searchableText.includes(token));
  }

  function buildFacetMarkup({ name, label, options, selectedValues = [], emptyText = 'No options available', collapsedCount = 5 }) {
    const selected = new Set(selectedValues);
    const normalizedOptions = (Array.isArray(options) ? options : []).map((option) => (
      typeof option === 'string'
        ? { value: option, count: null }
        : { value: option?.value, count: option?.count ?? null }
    )).filter((option) => option.value);
    const hasOptions = normalizedOptions.length > 0;
    const shouldCollapse = hasOptions && normalizedOptions.length > collapsedCount;

    if (!hasOptions) {
      return `
        <label class="facet-label-row"><span>${DJ.escapeHtml(label)}</span></label>
        <div class="locked-filter-note locked-filter-note--empty">${DJ.escapeHtml(emptyText)}</div>
      `;
    }

    return `
      <label class="facet-label-row">
        <span>${DJ.escapeHtml(label)}</span>
        <span class="facet-label-meta">${normalizedOptions.length} option${normalizedOptions.length === 1 ? '' : 's'}</span>
      </label>
      <div class="facet-group${shouldCollapse ? ' facet-group--collapsible' : ''}" data-facet-name="${DJ.escapeHtml(name)}">
        <div class="facet-options">
          ${normalizedOptions.map((option, index) => `
            <label class="facet-option${index >= collapsedCount ? ' facet-option--extra' : ''}">
              <input type="checkbox" name="${DJ.escapeHtml(name)}" value="${DJ.escapeHtml(option.value)}"${selected.has(option.value) ? ' checked' : ''}>
              <span>
                <span class="facet-option-text">${DJ.escapeHtml(option.value)}</span>
                ${option.count != null ? `<span class="facet-option-count">${DJ.escapeHtml(`(${option.count})`)}</span>` : ''}
              </span>
            </label>
          `).join('')}
        </div>
        ${shouldCollapse ? '<button type="button" class="facet-toggle" aria-expanded="false">Show more</button>' : ''}
      </div>
    `;
  }

  /**
   * Normalize raw product records into a single predictable shape used by the UI.
   * That lets the storefront mix static JSON, local overrides, and remote rows
   * without every rendering function needing to understand each source format.
   */
  function normalizeProducts(items) {
    return items.map((item) => {
      const category = item.category || 'Other';
      const price = item.price === '' || item.price === undefined ? null : item.price;
      const numericYear = Number(item.year);
      const year = Number.isFinite(numericYear) && numericYear > 0 ? numericYear : null;
      const yearLabel = year ? String(year) : 'Year not listed';
      const team = normalizeTeamFacetValue(item.team, {
        category,
        sport: item.sport,
        league: item.league,
        sourcePage: item.sourcePage
      });
      const rawCondition = item.condition || '';
      const conditionInfo = parseConditionDetails(rawCondition);
      const suppressCondition = shouldSuppressCollectibleCondition(item, category, conditionInfo);
      const conditionSummary = suppressCondition ? '' : conditionInfo.summary;
      const conditionFacet = suppressCondition ? '' : conditionInfo.status;
      const conditionCompact = suppressCondition ? '' : conditionInfo.compact;
      const description = item.description || '';
      const searchableDescription = description.replace(/\s+/g, ' ').trim().slice(0, 280);
      const sport = item.sport || (category === 'Collectibles' ? 'Other' : category);
      const league = item.league || '';
      const playerAthlete = item.playerAthlete || '';
      const quantityAvailable = DJ.availableQuantity(item);
      const saleStatus = String(item.saleStatus || 'available').trim().toLowerCase();
      const checkoutEnabled = item.checkoutEnabled !== false;
      const photoHostPageUrl = DJ.safeExternalUrl(item.photoHostPageUrl);
      const image = item.image || DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other;
      const attributes = deriveProductAttributes(item);
      // Public catalog sources are projected before delivery. Keep this
      // defensive normalization for old cached data or local admin previews,
      // without retaining non-shopper fields in long-lived product objects.
      const {
        metadata: _metadata,
        htmlFullLink: _htmlFullLink,
        htmlImageUrls: _htmlImageUrls,
        itemPhotoUrl: _itemPhotoUrl,
        itemPhotoUrls: _itemPhotoUrls,
        ...storefrontItem
      } = item;

      return {
        ...storefrontItem,
        category,
        price,
        year,
        yearLabel,
        team,
        rawCondition,
        condition: conditionSummary,
        conditionFacet,
        conditionCompany: suppressCondition ? '' : conditionInfo.company,
        conditionGrade: suppressCondition ? '' : conditionInfo.grade,
        conditionCompact,
        description,
        sport,
        league,
        playerAthlete,
        quantityAvailable,
        copyCount: quantityAvailable,
        saleStatus,
        checkoutEnabled,
        photoHostPageUrl,
        image,
        attributes,
        _price: DJ.payablePrice({ price }),
        _conditionLower: conditionFacet.toLowerCase(),
        _teamFacet: team,
        _searchNormalized: normalizeSearchString([
          item.name || '',
          team,
          category,
          sport,
          league,
          playerAthlete,
          searchableDescription,
          yearLabel,
          conditionSummary,
          attributes.join(' ')
        ].join(' ').toLowerCase())
      };
    });
  }

  function filterStorefrontProducts(items = []) {
    const seenListings = new Set();
    return (Array.isArray(items) ? items : []).filter((item) => {
      if (item?.isDeleted === true) {
        return false;
      }
      if (['hidden', 'archived', 'sold'].includes(String(item?.saleStatus || '').toLowerCase())) {
        return false;
      }

      if (REMOVED_VIDEO_GAME_LISTING_IDS.has(Number(item?.id))) {
        return false;
      }

      // Import history can contain the same physical listing under multiple
      // IDs. Hide only exact buyer-visible duplicates; differently priced
      // copies and distinct photos remain separate listings.
      const duplicateKey = [
        item?.name,
        item?.category,
        item?.team,
        item?.year,
        item?.condition,
        item?.price,
        item?.priceLabel || item?.displayPrice,
        item?.image
      ].map((value) => String(value ?? '').trim().toLowerCase()).join('\u001f');

      if (seenListings.has(duplicateKey)) {
        return false;
      }
      seenListings.add(duplicateKey);
      return true;
    });
  }

  function getProductSource(page = document.body.dataset.page || '') {
    return PRODUCT_SOURCE_BY_PAGE[page] || DEFAULT_PRODUCT_SOURCE;
  }

  async function getCatalogPageProducts(config = {}) {
    const source = getProductSource();
    const allowedCategories = Array.isArray(config.allowedCategories) ? config.allowedCategories : [];
    const allowedKey = allowedCategories.length
      ? allowedCategories.join('|')
      : 'all';
    const cacheKey = `${source}::${allowedKey}`;

    if (catalogPageCache.has(cacheKey)) {
      return catalogPageCache.get(cacheKey);
    }

    const allProducts = await loadProducts({ source });
    const allowedCategorySet = new Set(allowedCategories);
    const allowedProducts = allowedCategories.length
      ? allProducts.filter((product) => allowedCategorySet.has(product.category))
      : allProducts;

    const context = { allProducts, allowedProducts };
    catalogPageCache.set(cacheKey, context);
    return context;
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  /**
   * Fetch a static JSON source once and cache the pending promise so repeated calls
   * do not trigger duplicate network requests during the same page lifecycle.
   */
  async function fetchStaticProducts(source) {
    if (staticProductCache.has(source)) {
      return staticProductCache.get(source);
    }

    const pendingRequest = (async () => {
      const productAssetUrl = DJ.versionedProductAsset(source);
      // Let the browser/service worker revalidate catalog JSON instead of
      // pinning older payloads with force-cache across storefront deploys.
      const response = await fetch(productAssetUrl, { cache: 'default' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })();

    staticProductCache.set(source, pendingRequest);

    try {
      return await pendingRequest;
    } catch (error) {
      staticProductCache.delete(source);
      throw error;
    }
  }

  async function fetchCatalogBootstrap(source) {
    const bootstrapSource = BOOTSTRAP_SOURCE_BY_SOURCE[source];
    if (!bootstrapSource) {
      return null;
    }

    if (catalogBootstrapCache.has(source)) {
      return catalogBootstrapCache.get(source);
    }

    const pendingRequest = (async () => {
      const bootstrapAssetUrl = DJ.versionedProductAsset(bootstrapSource);
      const response = await fetch(bootstrapAssetUrl, { cache: 'default' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.products)) {
        throw new Error(`Invalid bootstrap catalog ${bootstrapSource}.`);
      }

      return {
        source: payload.source || source,
        total: Number.isFinite(Number(payload.total)) ? Number(payload.total) : payload.products.length,
        products: payload.products
      };
    })();

    catalogBootstrapCache.set(source, pendingRequest);

    try {
      return await pendingRequest;
    } catch (error) {
      catalogBootstrapCache.delete(source);
      throw error;
    }
  }

  function withTimeout(promise, timeoutMs, label = 'Request') {
    let timeoutId = 0;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => {
      window.clearTimeout(timeoutId);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function getVisibleFocusableElements(container) {
    if (!container) return [];
    return [...container.querySelectorAll(FILTER_PANEL_FOCUSABLE_SELECTOR)].filter((element) => (
      element instanceof HTMLElement
      && !element.disabled
      && !element.closest('[hidden]')
      && element.getClientRects().length > 0
    ));
  }

  function setFilterDrawerBackgroundInert(filterPanel, overlay, enabled) {
    if (!filterPanel) return;
    const stateKey = 'filterDrawerBackgroundInert';
    const setElementState = (element) => {
      if (!(element instanceof HTMLElement)) return;

      if (enabled) {
        if (element.dataset[stateKey] === 'true') return;
        element.dataset[stateKey] = 'true';
        element.dataset.filterDrawerPreviousAriaHidden = element.getAttribute('aria-hidden') || '';
        element.dataset.filterDrawerPreviousInert = element.hasAttribute('inert') ? 'true' : 'false';
        element.setAttribute('aria-hidden', 'true');
        element.setAttribute('inert', '');
        return;
      }

      if (element.dataset[stateKey] !== 'true') return;
      const previousAriaHidden = element.dataset.filterDrawerPreviousAriaHidden;
      const wasInert = element.dataset.filterDrawerPreviousInert === 'true';
      if (previousAriaHidden) element.setAttribute('aria-hidden', previousAriaHidden);
      else element.removeAttribute('aria-hidden');
      if (wasInert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
      delete element.dataset[stateKey];
      delete element.dataset.filterDrawerPreviousAriaHidden;
      delete element.dataset.filterDrawerPreviousInert;
    };

    let activeBranch = filterPanel;
    while (activeBranch?.parentElement) {
      const parent = activeBranch.parentElement;
      [...parent.children].forEach((sibling) => {
        if (sibling === activeBranch || sibling === overlay) return;
        setElementState(sibling);
      });
      if (parent === document.body) break;
      activeBranch = parent;
    }
  }

  /**
   * Resolve with the first successful source rather than the first settled
   * source. Promise.race() would make one fast remote rejection win before the
   * delayed static fallback has an opportunity to succeed.
   */
  function firstSuccessfulResult(promises = [], label = 'Catalog sources') {
    return new Promise((resolve, reject) => {
      const pending = Array.isArray(promises) ? promises.filter(Boolean) : [];
      if (!pending.length) {
        reject(new Error(`${label} are unavailable.`));
        return;
      }

      const errors = [];
      let rejected = 0;
      pending.forEach((promise) => {
        Promise.resolve(promise).then(resolve, (error) => {
          errors.push(error);
          rejected += 1;
          if (rejected !== pending.length) return;

          const failure = new Error(`${label} are unavailable.`);
          failure.causes = errors;
          reject(failure);
        });
      });
    });
  }

  function getCatalogTimingValue(configKey, fallbackValue, minValue, maxValue) {
    const rawValue = Number(window.DJ_BACKEND_CONFIG?.[configKey]);
    if (!Number.isFinite(rawValue)) return fallbackValue;
    return Math.min(maxValue, Math.max(minValue, Math.round(rawValue)));
  }

  async function getStaticSourceResult(source, origin = 'static') {
    const isFilePreview = window.location.protocol === 'file:';

    // Local file previews cannot reliably fetch JSON in every browser, so keep
    // the generated JS bundles as the first fallback there. Live HTTP/HTTPS
    // pages should prefer JSON to avoid parsing multi-megabyte script bundles.
    if (isFilePreview) {
      const bundledProducts = await DJ.loadPreloadedProductsForSource(source).catch(() => null);
      if (bundledProducts) {
        return { products: bundledProducts, origin: `${origin}-bundle` };
      }
    }

    try {
      return {
        products: await fetchStaticProducts(source),
        origin
      };
    } catch (error) {
      const bundledProducts = await DJ.loadPreloadedProductsForSource(source).catch(() => null);
      if (bundledProducts) {
        return { products: bundledProducts, origin: `${origin}-bundle` };
      }

      throw error;
    }
  }

  function isLegacyStaticProduct(product = {}) {
    return Boolean(
      String(product.legacyImageLabel || '').trim()
      || String(product.sourcePage || '').trim()
      || /legacy/i.test(String(product.description || ''))
    );
  }

  function isPlaceholderCatalogImage(value = '') {
    return /(?:placeholder-[^/]+\.svg|clubhouse-sign\.png)$/i.test(String(value || ''));
  }

  function hasPlaceholderCatalogImage(product = {}) {
    const gallery = Array.isArray(product.imageGallery) ? product.imageGallery : [];
    return isPlaceholderCatalogImage(product.image) || gallery.some(isPlaceholderCatalogImage);
  }

  function hasUsableStaticImage(product = {}) {
    return Boolean(String(product.image || '').trim() && !isPlaceholderCatalogImage(product.image));
  }

  function parseCatalogPriceValue(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    const numericText = String(value || '').replace(/[$,]/g, '').trim();
    if (!numericText) {
      return null;
    }

    const numericValue = Number(numericText);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  function hasMissingCatalogPrice(product = {}) {
    return parseCatalogPriceValue(product.price) == null
      || /contact/i.test(String(product.priceLabel || product.displayPrice || ''));
  }

  function hasUsableStaticPrice(product = {}) {
    return parseCatalogPriceValue(product.price) != null;
  }

  function getCatalogPriceDisplay(product = {}) {
    return String(product.priceLabel || product.displayPrice || '').trim();
  }

  function shouldOverlayStaticPrice(product = {}, staticProduct = {}) {
    const staticPrice = parseCatalogPriceValue(staticProduct.price);
    if (staticPrice == null) {
      return false;
    }

    const remotePrice = parseCatalogPriceValue(product.price);
    if (remotePrice == null || Math.abs(remotePrice - staticPrice) > 0.001) {
      return true;
    }

    const staticDisplay = getCatalogPriceDisplay(staticProduct);
    const remoteDisplay = getCatalogPriceDisplay(product);
    if (!staticDisplay) {
      return false;
    }

    return !remoteDisplay
      || /contact/i.test(remoteDisplay)
      || remoteDisplay !== staticDisplay;
  }

  async function applyStaticLegacyListingOverlay(source, remoteProducts = []) {
    if (!Array.isArray(remoteProducts) || !remoteProducts.length) {
      return remoteProducts;
    }

    const staticProducts = await fetchStaticProducts(source).catch((error) => {
      console.warn(`Could not load static Legacy listing overlay for ${source}; using remote listing details.`, error);
      return null;
    });
    if (!Array.isArray(staticProducts) || !staticProducts.length) {
      return remoteProducts;
    }

    const staticProductsById = new Map(
      staticProducts
        .map((product) => [Number(product.id), product])
        .filter(([productId]) => Number.isFinite(productId))
    );
    if (!staticProductsById.size) {
      return remoteProducts;
    }

    return remoteProducts.map((product) => {
      const staticProduct = staticProductsById.get(Number(product.id));
      if (!staticProduct) {
        return product;
      }

      const staticDescription = String(staticProduct.description || '').trim();
      const remoteDescription = String(product.description || '').trim();
      const shouldOverlayLegacyFields = !(
        remoteDescription === staticDescription
        && (product.sourcePage || !staticProduct.sourcePage)
        && (product.legacyImageLabel || !staticProduct.legacyImageLabel)
      ) && isLegacyStaticProduct(staticProduct);
      const shouldOverlayImage = hasPlaceholderCatalogImage(product) && hasUsableStaticImage(staticProduct);
      const shouldOverlayPrice = hasMissingCatalogPrice(product)
        ? hasUsableStaticPrice(staticProduct)
        : shouldOverlayStaticPrice(product, staticProduct);

      if (!shouldOverlayLegacyFields && !shouldOverlayImage && !shouldOverlayPrice) {
        return staticProduct.hasThumbnail === true && product.hasThumbnail !== true
          ? { ...product, hasThumbnail: true }
          : product;
      }

      const syncedProduct = { ...product };

      if (staticProduct.hasThumbnail === true) {
        syncedProduct.hasThumbnail = true;
      }

      if (shouldOverlayLegacyFields) {
        syncedProduct.description = staticDescription;
        syncedProduct.sourcePage = product.sourcePage || staticProduct.sourcePage;
        syncedProduct.legacyImageLabel = product.legacyImageLabel || staticProduct.legacyImageLabel;
      }

      if (shouldOverlayImage) {
        const staticGallery = Array.isArray(staticProduct.imageGallery) && staticProduct.imageGallery.length
          ? staticProduct.imageGallery
          : [staticProduct.image];
        syncedProduct.image = staticProduct.image;
        syncedProduct.imageGallery = staticGallery;
      }

      if (shouldOverlayPrice) {
        syncedProduct.price = parseCatalogPriceValue(staticProduct.price);
        const staticDisplay = getCatalogPriceDisplay(staticProduct)
          || DJ.currency(syncedProduct.price);
        syncedProduct.priceLabel = staticDisplay;
        syncedProduct.displayPrice = staticDisplay;
      }

      return syncedProduct;
    });
  }

  async function getBestAvailableSourceResult(source) {
    const preloaded = DJ.getPreloadedProductsForSource(source);
    if (preloaded) {
      return { products: preloaded, origin: 'preloaded' };
    }

    if (window.location.protocol === 'file:') {
      return getStaticSourceResult(source, 'preloaded');
    }

    if (window.DJ_BACKEND_CONFIG?.preferStaticCatalog === true) {
      try {
        // The category snapshots are generated from the same canonical catalog
        // used for Supabase sync, are substantially smaller than remote rows,
        // and avoid making product images compete with duplicate data requests.
        return await getStaticSourceResult(source, 'static-primary');
      } catch (error) {
        console.warn(`Static catalog was not ready for ${source}; trying the remote catalog.`, error);
      }
    }

    if (DJ.remoteCatalog?.isConfigured()) {
      // Remote data is preferred, but the static catalog is fully deploy-synced.
      // Race it against the local product bundle so a slow backend, stalled SDK
      // CDN, or mobile network hiccup never leaves shoppers on a loading state.
      const remoteCatalogTimeoutMs = getCatalogTimingValue('remoteCatalogTimeoutMs', 3200, 800, 10000);
      const staticCatalogFallbackDelayMs = getCatalogTimingValue('staticCatalogFallbackDelayMs', 350, 0, 5000);
      let sourceSelected = false;
      const remotePromise = withTimeout(
        DJ.remoteCatalog.listProducts({
          source,
          featuredOnly: source === 'products-featured.json'
        }),
        remoteCatalogTimeoutMs,
        'Remote catalog'
      ).then((remote) => {
        if (Array.isArray(remote)) {
          return { products: remote, origin: 'remote' };
        }
        throw new Error('Remote catalog did not return a product list.');
      }).catch((error) => {
        if (!sourceSelected) {
          console.warn(`Remote catalog was not ready for ${source}; waiting for the static fallback.`, error);
        }
        throw error;
      });

      const staticFallbackPromise = delay(staticCatalogFallbackDelayMs)
        .then(() => getStaticSourceResult(source, 'static-fast-fallback'))
        .catch((error) => {
          if (!sourceSelected) {
            console.warn(`Static catalog fallback was not ready for ${source}; waiting for the remote catalog.`, error);
          }
          throw error;
        });

      try {
        const result = await firstSuccessfulResult([remotePromise, staticFallbackPromise], 'Remote and static catalog sources');
        sourceSelected = true;
        return result;
      } catch (error) {
        console.warn(`Remote and static catalog sources both failed for ${source}.`, error);
        throw error;
      }
    }

    return getStaticSourceResult(source);
  }

  /**
   * Keep the stored wishlist aligned with the currently available catalog.
   * This prevents deleted or backend-removed listings from inflating badge counts
   * on pages outside the dedicated wishlist view.
   */
  function hasUsableCatalogSnapshot(products) {
    return Array.isArray(products) && products.length > 0;
  }

  function reconcileWishlistIds(products, options = {}) {
    const shouldPersist = options.persist !== false;
    const currentWishlist = DJ.getWishlist();
    // A transient remote/static failure must never be interpreted as an empty
    // catalog and erase shopper state. A successful non-empty snapshot can
    // still prune listings that were genuinely removed.
    if (!hasUsableCatalogSnapshot(products)) return currentWishlist;

    const validIds = new Set(products.map((product) => Number(product.id)).filter(Number.isFinite));
    const reconciledWishlist = currentWishlist.filter((productId) => validIds.has(Number(productId)));

    if (shouldPersist && reconciledWishlist.length !== currentWishlist.length) {
      DJ.setWishlist(reconciledWishlist);
    }

    return reconciledWishlist;
  }

  /**
   * Load products from the configured source, preferring the remote backend when it
   * is enabled, while still falling back to static JSON if the backend is offline.
   */
  async function loadProducts(options = {}) {
    const source = options.source || getProductSource();

    if (!options.force && normalizedSourceCache.has(source)) {
      return normalizedSourceCache.get(source);
    }

    const pending = (async () => {
      try {
        const { products: sourceProducts, origin } = await getBestAvailableSourceResult(source);
        const syncedSourceProducts = origin === 'remote'
          ? await applyStaticLegacyListingOverlay(source, sourceProducts)
          : sourceProducts;
        const normalizedProducts = normalizeProducts(filterStorefrontProducts(syncedSourceProducts));
        catalogPageCache.clear();
        filteredCatalogResultsCache.clear();

        if (source === DEFAULT_PRODUCT_SOURCE) {
          reconcileWishlistIds(normalizedProducts, { persist: true });
        }

        return normalizedProducts;
      } catch (error) {
        const preloadedFallback = DJ.getPreloadedProductsForSource(source)
          || await DJ.loadPreloadedProductsForSource(source).catch(() => null);
        const fallbackProducts = preloadedFallback || await fetchStaticProducts(source).catch(() => []);

        if (fallbackProducts.length) {
          console.warn(`Using static fallback products for ${source} after the preferred catalog source failed.`, error);
        } else {
          console.error(`Failed to load products from ${source}:`, error);
        }

        const normalizedFallback = normalizeProducts(filterStorefrontProducts(fallbackProducts));
        catalogPageCache.clear();
        filteredCatalogResultsCache.clear();

        if (source === DEFAULT_PRODUCT_SOURCE) {
          reconcileWishlistIds(normalizedFallback, { persist: true });
        }

        return normalizedFallback;
      }
    })();

    normalizedSourceCache.set(source, pending);

    try {
      return await pending;
    } catch (error) {
      normalizedSourceCache.delete(source);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Product card rendering and interaction helpers
  // ---------------------------------------------------------------------------

  function getPriorityProductCardCount() {
    // Product grids sit below their page hero and filter controls, so card
    // thumbnails should not compete with the actual LCP image during startup.
    // After the shell is painted, prioritize the first visible row so shoppers
    // are not left waiting on lazy image heuristics for the cards they can see.
    const page = document.body.dataset.page || '';
    if (page === 'wishlist') return 2;
    if (['baseball-cards', 'basketball-cards', 'football-cards', 'comics', 'collectibles'].includes(page)) {
      return 4;
    }
    return 0;
  }

  function getProductCardGallery(product = {}) {
    const cacheableProduct = product && typeof product === 'object';
    const cachedGallery = cacheableProduct ? productCardGalleryCache.get(product) : null;
    if (cachedGallery) return cachedGallery;

    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const sourceGallery = Array.isArray(product.imageGallery) && product.imageGallery.length ? product.imageGallery : null;
    const gallery = [];

    if (sourceGallery) {
      const seen = sourceGallery.length > 1 ? new Set() : null;
      for (const image of sourceGallery) {
        const normalizedImage = String(image || '').trim();
        if (!normalizedImage || seen?.has(normalizedImage)) continue;
        seen?.add(normalizedImage);
        gallery.push(normalizedImage);
      }
    } else {
      const normalizedImage = String(product.image || '').trim();
      if (normalizedImage) gallery.push(normalizedImage);
    }

    const resolvedGallery = gallery.length ? gallery : [fallback];
    if (cacheableProduct) productCardGalleryCache.set(product, resolvedGallery);
    return resolvedGallery;
  }

  function getProductCardImageCandidates(product = {}, image = '') {
    return product.hasThumbnail === true
      ? DJ.getThumbnailAssetCandidates(image)
      : DJ.getAssetUrlCandidates(image);
  }

  function getProductCardImageData(product = {}, index = 0) {
    const gallery = getProductCardGallery(product);
    const requestedIndex = Number(index);
    const safeIndex = Number.isFinite(requestedIndex)
      ? ((requestedIndex % gallery.length) + gallery.length) % gallery.length
      : 0;
    const image = gallery[safeIndex];
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const candidates = getProductCardImageCandidates(product, image);
    const source = candidates[0] || DJ.safeAssetUrl(image);
    const alt = buildProductImageAlt(product, {
      context: 'card',
      photoIndex: safeIndex + 1,
      photoCount: gallery.length
    });

    return {
      alt,
      candidates,
      count: gallery.length,
      fallback,
      index: safeIndex,
      source
    };
  }

  function renderProductCardGalleryControls(product = {}, galleryCount = 1) {
    if (galleryCount <= 1) return '';
    return `
          <button type="button" class="product-card-gallery-button product-card-gallery-button--prev" data-card-gallery-step="-1" aria-label="${DJ.escapeHtml(`Previous photo for ${product.name}`)}">
            <span aria-hidden="true">&#8249;</span>
          </button>
          <button type="button" class="product-card-gallery-button product-card-gallery-button--next" data-card-gallery-step="1" aria-label="${DJ.escapeHtml(`Next photo for ${product.name}`)}">
            <span aria-hidden="true">&#8250;</span>
          </button>
          <span class="product-card-gallery-count" data-card-gallery-count-label>1 / ${galleryCount}</span>`;
  }

  function renderProductCard(product, wishlistIds, options = {}) {
    const isWishlisted = wishlistIds.has(Number(product.id));
    const heart = isWishlisted ? '\u2665' : '\u2661';
    const accessibilitySummary = [product.yearLabel || product.year || '', getProductPrimaryContext(product), product.league || '', product.conditionCompact || product.conditionFacet || '']
      .filter(Boolean)
      .map((part) => DJ.escapeHtml(part))
      .join(' | ');
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const summaryId = `product-card-summary-${product.id}`;
    const displayPrice = DJ.displayPrice(product);
    const priceLabel = getProductPriceLabel(product);
    const pricingClass = /contact/i.test(displayPrice) ? 'product-pricing product-pricing--inquiry' : 'product-pricing';
    const cardImage = getProductCardImageData(product, 0);
    const cardGalleryCount = cardImage.count;
    const cardHasGallery = cardGalleryCount > 1;
    const cardAttributes = getProductCardAttributes(product.attributes);
    const wishlistActionLabel = isWishlisted ? 'Remove from wishlist' : 'Add to wishlist';
    const isDirectCheckout = isDirectCheckoutCandidate(product);
    const availableQuantity = DJ.availableQuantity(product);
    const quickActionLabel = getProductActionLabel(product);
    const titleId = `product-card-title-${product.id}`;
    const cardImageSizes = [
      '(max-width: 640px) calc(100vw - 3rem)',
      '(max-width: 900px) 31vw',
      '(max-width: 1280px) 22vw',
      '210px'
    ].join(', ');
    // Give above-the-fold cards a real loading priority, while keeping the rest
    // lazy so large catalog pages stay light on bandwidth and CPU.
    const imagePriority = options.imagePriority === 'high' ? 'high' : 'low';
    const imageLoading = imagePriority === 'high' ? 'eager' : 'lazy';
    const mediaGalleryAttrs = cardHasGallery
      ? ` data-card-gallery="true" data-card-gallery-index="0" data-card-gallery-count="${cardGalleryCount}"`
      : '';

    return `
      <article class="product-card" data-product-id="${product.id}" data-product-category="${DJ.escapeHtml(product.category)}" aria-labelledby="${titleId}" aria-describedby="${summaryId}">
        <button type="button" class="wishlist-button product-card-wishlist${isWishlisted ? ' filled' : ''}" aria-pressed="${isWishlisted ? 'true' : 'false'}" aria-label="${DJ.escapeHtml(`${wishlistActionLabel}: ${product.name}`)}" title="${DJ.escapeHtml(`${wishlistActionLabel}: ${product.name}`)}">${heart}</button>
        <div class="product-media${cardHasGallery ? ' product-media--gallery' : ''}"${mediaGalleryAttrs}>
          <img data-card-gallery-image src="${DJ.escapeHtml(cardImage.source)}" data-asset-candidates="${DJ.escapeHtml(cardImage.candidates.join('\n'))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(cardImage.fallback || fallback))}" alt="${DJ.escapeHtml(cardImage.alt)}" title="${DJ.escapeHtml(cardImage.alt)}" width="320" height="320" sizes="${DJ.escapeHtml(cardImageSizes)}" loading="${imageLoading}" decoding="async" fetchpriority="${imagePriority}">
          ${renderProductCardGalleryControls(product, cardGalleryCount)}
        </div>
        <div class="product-content">
          <h2 id="${titleId}">${DJ.escapeHtml(product.name)}</h2>
          <span class="sr-only" id="${summaryId}">${accessibilitySummary || 'Catalog listing'}</span>
          ${cardAttributes.length ? `<div class="product-card-chip-rail">${renderAttributeTags(cardAttributes)}</div>` : ''}
          <div class="product-card-footer">
            <div class="${pricingClass}">
              <span class="product-price-label">${DJ.escapeHtml(priceLabel)}</span>
              <div class="product-pricing-values">
                <div class="product-price">${DJ.escapeHtml(displayPrice)}</div>
                ${isDirectCheckout ? `<span class="product-inventory">${DJ.escapeHtml(`${availableQuantity} available`)}</span>` : ''}
              </div>
            </div>
            <div class="product-actions product-card-actions" aria-label="Listing actions" role="group">
              <button type="button" class="details-button" data-product-details aria-label="${DJ.escapeHtml(`View details for ${product.name}`)}" aria-describedby="${summaryId}" aria-haspopup="dialog">Details</button>
              ${isDirectCheckout ? `<button type="button" class="button-secondary add-cart-button" data-product-cart aria-label="${DJ.escapeHtml(`Add to Cart: ${product.name}`)}" aria-describedby="${summaryId}">Add to Cart</button>` : ''}
              <a class="offer-button" data-product-offer href="offer.html?item=${encodeURIComponent(product.id)}" aria-label="${DJ.escapeHtml(`Make an offer for ${product.name}`)}" aria-describedby="${summaryId}">Make Offer</a>
              <button type="button" class="buy-button${isDirectCheckout ? '' : ' buy-button--inquiry'}" data-product-buy data-checkout-button aria-label="${DJ.escapeHtml(`${quickActionLabel} for ${product.name}`)}" aria-describedby="${summaryId}">${DJ.escapeHtml(quickActionLabel)}</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderLoadingProductCards(count = 4) {
    return Array.from({ length: Math.max(1, count) }, () => `
      <article class="product-card product-card--loading" aria-hidden="true">
        <div class="product-media">
          <span class="product-skeleton product-skeleton--image"></span>
        </div>
        <div class="product-content">
          <span class="product-skeleton product-skeleton--title"></span>
          <span class="product-skeleton product-skeleton--title product-skeleton--title-short"></span>
          <div class="product-card-chip-rail">
            <div class="product-topline">
              <span class="product-skeleton product-skeleton--badge"></span>
              <span class="product-skeleton product-skeleton--meta"></span>
            </div>
            <div class="product-card-summary">
              <div class="product-meta-pills">
                <span class="product-skeleton product-skeleton--pill"></span>
                <span class="product-skeleton product-skeleton--pill product-skeleton--pill-wide"></span>
              </div>
            </div>
            <div class="product-meta-inline-list">
              <span class="product-skeleton product-skeleton--pill"></span>
              <span class="product-skeleton product-skeleton--pill"></span>
            </div>
          </div>
          <div class="product-card-footer">
            <div class="product-pricing">
              <span class="product-skeleton product-skeleton--label"></span>
              <span class="product-skeleton product-skeleton--price"></span>
            </div>
          </div>
        </div>
      </article>
    `).join('');
  }

  function renderProductGridLoadingState(container, options = {}) {
    if (!container) return;
    const count = Number.isFinite(Number(options.count)) ? Number(options.count) : 4;
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = renderLoadingProductCards(count);
  }

  function clearProductGridLoadingState(container) {
    if (!container) return;
    container.removeAttribute('aria-busy');
  }

  function getProductGridRenderSignature(products = [], wishlistIds = new Set()) {
    // Filtering can fire repeatedly while typing. Include only buyer-visible
    // fields so local admin edits and fresh catalog prices repaint without
    // losing the cheap "same visible cards" short-circuit.
    return (Array.isArray(products) ? products : [])
      .map((product) => [
        Number(product.id),
        wishlistIds.has(Number(product.id)) ? 1 : 0,
        product.name || '',
        DJ.displayPrice(product) || '',
        product.condition || '',
        product.image || ''
      ].join(':'))
      .join('|');
  }

  function setCatalogLoadingState(message = CATALOG_LOADING_MESSAGE) {
    const resultsCount = document.getElementById('resultsCount');
    const resultsSummary = document.getElementById('resultsSummary');
    const resultsLive = document.getElementById('resultsLive');
    const activeFiltersWrap = document.getElementById('activeFilters');

    if (resultsCount) resultsCount.textContent = CATALOG_LOADING_MESSAGE;
    if (resultsSummary) resultsSummary.textContent = message;
    if (resultsLive) resultsLive.textContent = 'Loading available items.';
    if (activeFiltersWrap) activeFiltersWrap.innerHTML = '';
  }

  async function ensureCustomerAccountBridge() {
    if (DJ.payments?.startCheckout) {
      return DJ.payments;
    }

    await DJ.loadScriptsInOrder([
      DJ.versionedProductAsset('backend-config.js'),
      DJ.versionedProductAsset('supabase-client.js'),
      DJ.versionedProductAsset('payments.js')
    ]);
    return DJ.payments || null;
  }

  function isNbaSlabStatsCandidate(product = {}) {
    return String(product.category || '').trim().toLowerCase() === 'basketball'
      && String(product.league || '').trim().toUpperCase() === 'NBA';
  }

  async function ensureNbaSlabStatsBridge() {
    await DJ.loadScriptsInOrder([
      DJ.versionedProductAsset('backend-config.js'),
      DJ.versionedProductAsset('supabase-client.js')
    ]);
    if (!DJ.remoteCatalog?.getNbaProductSlabStats) return null;

    if (!nbaSlabStatsModulePromise) {
      nbaSlabStatsModulePromise = import(DJ.versionedProductAsset('nba-slab-stats.mjs'))
        .catch((error) => {
          nbaSlabStatsModulePromise = null;
          throw error;
        });
    }
    return nbaSlabStatsModulePromise;
  }

  function hydrateNbaSlabStatsPanel(product, requestId) {
    const container = document.getElementById('nbaSlabStatsPanel');
    if (!container) return;

    const isCurrent = () => (
      requestId === modalSlabStatsRequestId
      && Number(activeModalProductId) === Number(product.id)
      && container.isConnected
      && document.getElementById('productModal')?.classList.contains('active')
    );

    ensureNbaSlabStatsBridge()
      .then((statsModule) => {
        if (!isCurrent() || !statsModule?.mountNbaSlabStatsPanel) return;
        return statsModule.mountNbaSlabStatsPanel(container, product, { isCurrent });
      })
      .catch((error) => {
        if (!isCurrent()) return;
        container.hidden = true;
        container.replaceChildren();
        console.warn('NBA Slab-to-Stats panel could not be initialized.', error);
      });
  }

  function hydrateCustomerAccountAfterPaint() {
    const hydrate = () => {
      ensureCustomerAccountBridge()
        .then((payments) => payments?.hydrateAccount?.())
        .catch((error) => console.warn('Customer account could not be synced.', error));
    };

    if (document.getElementById('productContainer')) {
      window.setTimeout(() => DJ.scheduleIdle(hydrate, 1600), 8000);
      return;
    }

    DJ.scheduleIdle(hydrate, 1200);
  }

  async function buyNow(product, options = {}) {
    const sendPurchaseInquiry = () => {
      openPurchaseInquiry(product);
    };

    try {
      const payments = await ensureCustomerAccountBridge();
      if (payments?.startCheckout) {
        payments.startCheckout(product, { ...options, fallback: sendPurchaseInquiry });
        return;
      }
    } catch (error) {
      console.warn('Secure checkout could not be loaded; opening the purchase inquiry instead.', error);
    }

    sendPurchaseInquiry();
  }

  function addToCart(product, quantity = 1) {
    if (!isDirectCheckoutCandidate(product)) {
      openPurchaseInquiry(product);
      return false;
    }

    const available = DJ.availableQuantity(product);
    const productId = DJ.normalizeProductId(product.id);
    if (!productId) {
      showCartActionFeedback('This listing is not available to add to cart right now.', 'error');
      return false;
    }

    const existing = DJ.getCart().find((item) => item.productId === productId);
    const requested = DJ.normalizeCartQuantity(quantity);
    const nextQuantity = Math.min(available, (existing?.quantity || 0) + requested);
    if (nextQuantity <= (existing?.quantity || 0)) {
      showCartActionFeedback(`Only ${available} available for this listing.`, 'error');
      return false;
    }

    DJ.updateCartQuantity(productId, nextQuantity);
    showCartActionFeedback(`${product.name} added to cart.`, 'success');
    DJ.trackEvent?.('add_to_cart', { productId, category: product.category });
    return true;
  }

  async function checkoutCart(products = []) {
    const productLookup = createProductLookup(products);
    const items = DJ.getCart()
      .map((item) => ({
        ...item,
        product: productLookup.get(Number(item.productId)) || null
      }))
      .filter((item) => item.product);
    if (!items.length) return;

    try {
      const payments = await ensureCustomerAccountBridge();
      if (payments?.startCartCheckout) {
        payments.startCartCheckout(items, { returnPath: '/cart.html' });
      }
    } catch (error) {
      console.error('Secure cart checkout could not be loaded.', error);
      DJ.setStatus('cartStatus', 'Secure checkout could not be loaded. Please try again.', 'error');
    }
  }

  function openPurchaseInquiry(product) {
    const listingUrl = getProductShareUrl(product);
    const descriptionExcerpt = getProductDescriptionExcerpt(product);
    const sourcePage = String(product.sourcePage || '').trim();
    const subject = encodeURIComponent(`Purchase Inquiry: ${product.name}`);
    const body = encodeURIComponent(
      `Hello DJ,

I'm interested in "${product.name}" (${product.yearLabel || product.year || 'Year not listed'}, ${product.condition || 'Condition not listed'}) listed for ${DJ.displayPrice(product)}.

Listing ID: ${product.id || 'Not listed'}
${sourcePage ? `Source page: ${sourcePage}\n` : ''}${descriptionExcerpt ? `Description: ${descriptionExcerpt}\n` : ''}
Page: ${document.title}
Listing link: ${listingUrl}

Please let me know if it is still available.

Thank you.`
    );
    window.location.href = `mailto:djscardscomics13@gmail.com?subject=${subject}&body=${body}`;
  }

  function getProductDescriptionExcerpt(product = {}, maxLength = 420) {
    const description = String(product.description || '').replace(/\s+/g, ' ').trim();
    if (!description) return '';
    if (description.length <= maxLength) return description;
    return `${description.slice(0, maxLength - 3).trim().replace(/[.,;:]*$/, '')}...`;
  }

  function getLinkedProductId() {
    const params = new URLSearchParams(window.location.search);
    const rawId = params.get(PRODUCT_LINK_PARAM);
    const productId = Number(rawId);
    return Number.isFinite(productId) && productId > 0 ? productId : null;
  }

  function getProductShareUrl(product) {
    const productId = Number(product?.id);
    const url = new URL(window.location.href);
    if (Number.isFinite(productId) && productId > 0) {
      url.searchParams.set(PRODUCT_LINK_PARAM, String(productId));
    }
    return url.toString();
  }

  function replaceProductUrl(product = null) {
    if (!window.history?.replaceState) return;
    const url = new URL(window.location.href);
    const productId = Number(product?.id);

    if (Number.isFinite(productId) && productId > 0) {
      url.searchParams.set(PRODUCT_LINK_PARAM, String(productId));
    } else {
      url.searchParams.delete(PRODUCT_LINK_PARAM);
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState({}, '', nextUrl);
    }
  }

  function maybeOpenLinkedProduct(products = []) {
    const linkedProductId = getLinkedProductId();
    if (!linkedProductId || linkedProductAutoOpenedId === linkedProductId) return;

    const product = (Array.isArray(products) ? products : [])
      .find((item) => Number(item.id) === linkedProductId);

    if (!product) return;

    linkedProductAutoOpenedId = linkedProductId;
    openModal(product, {
      preserveUrl: true,
      contextProducts: products
    });
  }

  function setModalStatus(message = '', tone = 'info') {
    const target = document.getElementById('modalCheckoutStatus');
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function showCartActionFeedback(message = '', tone = 'info') {
    const activeModal = document.getElementById('productModal');
    if (activeModal?.classList.contains('active')) {
      setModalStatus(message, tone);
      return;
    }

    const cartStatus = document.getElementById('cartStatus');
    if (cartStatus) {
      cartStatus.textContent = message;
      cartStatus.dataset.tone = tone;
      return;
    }

    let feedback = document.getElementById('catalogCartFeedback');
    if (!feedback) {
      feedback = document.createElement('p');
      feedback.id = 'catalogCartFeedback';
      feedback.className = 'catalog-cart-feedback';
      feedback.setAttribute('role', 'status');
      feedback.setAttribute('aria-live', 'polite');
      document.body.appendChild(feedback);
    }

    window.clearTimeout(cartActionFeedbackTimer);
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = !message;
    if (message) {
      cartActionFeedbackTimer = window.setTimeout(() => {
        feedback.textContent = '';
        feedback.hidden = true;
      }, 5200);
    }
  }

  async function copyProductLink(product) {
    const shareUrl = getProductShareUrl(product);

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard writing is not available in this browser.');
      }

      await navigator.clipboard.writeText(shareUrl);
      setModalStatus('Product link copied.', 'success');
    } catch {
      setModalStatus(`Copy this link: ${shareUrl}`, 'info');
    }
  }

  function toggleWishlist(productId) {
    const wishlist = DJ.getWishlist();
    const index = wishlist.indexOf(productId);
    const wasWishlisted = index > -1;

    if (wasWishlisted) wishlist.splice(index, 1);
    else wishlist.push(productId);

    DJ.setWishlist(wishlist);
    refreshWishlistButtons();
  }

  function setProductCardGalleryIndex(productCard, product, index) {
    if (!productCard || !product) return;

    const media = productCard.querySelector('[data-card-gallery]');
    const image = productCard.querySelector('[data-card-gallery-image]');
    if (!media || !image) return;

    const nextImage = getProductCardImageData(product, index);
    if (nextImage.count <= 1) return;

    media.dataset.cardGalleryIndex = String(nextImage.index);
    productCard.dataset.galleryIndex = String(nextImage.index);
    image.dataset.assetRetrySources = '';
    image.dataset.originalSrc = nextImage.source;
    delete image.dataset.imageFallbackApplied;
    image.setAttribute('src', nextImage.source);
    image.setAttribute('data-asset-candidates', nextImage.candidates.join('\n'));
    image.setAttribute('data-fallback-src', DJ.safeAssetUrl(nextImage.fallback));
    image.setAttribute('alt', nextImage.alt);
    image.setAttribute('title', nextImage.alt);

    const countLabel = media.querySelector('[data-card-gallery-count-label]');
    if (countLabel) {
      countLabel.textContent = `${nextImage.index + 1} / ${nextImage.count}`;
    }
  }

  function stepProductCardGallery(productCard, product, step) {
    const media = productCard?.querySelector('[data-card-gallery]');
    if (!media || !product) return;

    const currentIndex = Number(media.dataset.cardGalleryIndex || productCard.dataset.galleryIndex || 0);
    setProductCardGalleryIndex(productCard, product, currentIndex + step);
  }

  function refreshWishlistButtons(scope = document, wishlistIds = new Set(DJ.getWishlist().map(Number))) {
    scope.querySelectorAll('.product-card').forEach((card) => {
      const productId = Number(card.dataset.productId);
      const button = card.querySelector('.wishlist-button');
      if (!button) return;

      const isWishlisted = wishlistIds.has(productId);
      const productName = card.querySelector('h3, h4')?.textContent?.trim() || 'this item';
      const actionLabel = isWishlisted ? 'Remove from wishlist' : 'Add to wishlist';
      button.classList.toggle('filled', isWishlisted);
      button.textContent = isWishlisted ? '\u2665' : '\u2661';
      button.setAttribute('aria-label', `${actionLabel}: ${productName}`);
      button.setAttribute('title', `${actionLabel}: ${productName}`);
      button.setAttribute('aria-pressed', String(isWishlisted));
    });

    DJ.updateWishlistCount();
  }

  /**
   * Keep the open modal action in sync with the saved state so users do not see
   * stale "Save" / "Remove" copy after wishlist changes elsewhere.
   */
  function refreshModalWishlistButton(wishlistIds = new Set(DJ.getWishlist().map(Number))) {
    const modalWishlistButton = document.getElementById('modalWishlist');
    if (!modalWishlistButton) return;

    const productId = Number(modalWishlistButton.dataset.productId);
    if (!Number.isFinite(productId)) return;

    const isWishlisted = wishlistIds.has(productId);
    const modalTitle = document.getElementById('modalTitle')?.textContent?.trim() || 'this item';
    modalWishlistButton.textContent = isWishlisted ? 'Remove from Wishlist' : 'Save to Wishlist';
    modalWishlistButton.setAttribute('aria-label', `${isWishlisted ? 'Remove from wishlist' : 'Save to wishlist'}: ${modalTitle}`);
    modalWishlistButton.setAttribute('aria-pressed', String(isWishlisted));
  }

  function scheduleWishlistPageRefresh() {
    if (wishlistPageRefreshTimer) {
      window.clearTimeout(wishlistPageRefreshTimer);
    }

    wishlistPageRefreshTimer = window.setTimeout(async () => {
      wishlistPageRefreshTimer = 0;
      await renderWishlistPage();
    }, 0);
  }

  function bindWishlistStateSync() {
    if (document.body.dataset.wishlistStateSyncBound === 'true') return;
    document.body.dataset.wishlistStateSyncBound = 'true';

    window.addEventListener('dj:wishlistchange', (event) => {
      const normalizedIds = new Set(
        (Array.isArray(event.detail?.items) ? event.detail.items : DJ.getWishlist()).map(Number)
      );

      refreshWishlistButtons(document, normalizedIds);
      refreshModalWishlistButton(normalizedIds);

      if (document.body.dataset.page === 'wishlist') {
        scheduleWishlistPageRefresh();
      }
    });
  }

  function bindCartStateSync() {
    if (document.body.dataset.cartStateSyncBound === 'true') return;
    document.body.dataset.cartStateSyncBound = 'true';
    window.addEventListener('dj:cartchange', () => {
      if (document.body.dataset.page === 'cart') {
        renderCartPage().catch(console.error);
      }
    });
  }

  function createProductLookup(products = []) {
    return new Map(
      (Array.isArray(products) ? products : [])
        .map((product) => [Number(product.id), product])
        .filter(([productId]) => Number.isFinite(productId))
    );
  }

  /**
   * Keep direct-ID views aligned with the caller's requested order instead of the
   * underlying catalog order returned by a fallback source.
   */
  function sortProductsByIdOrder(products = [], orderedIds = []) {
    const productsById = createProductLookup(products);
    return orderedIds
      .map((productId) => productsById.get(Number(productId)))
      .filter(Boolean);
  }

  function attachGridHandlers(container, products, options = {}) {
    if (!container) return;
    const renderedProducts = normalizeModalContextProducts(products);
    const modalContextProducts = normalizeModalContextProducts(options.modalContextProducts);
    const productSequence = modalContextProducts.length ? modalContextProducts : renderedProducts;
    gridProductLookups.set(container, createProductLookup(renderedProducts));
    gridProductSequences.set(container, productSequence);

    container.onclick = (event) => {
      const loadMoreAction = event.target.closest('[data-load-more]');
      if (loadMoreAction) {
        options.onRequestMore?.(loadMoreAction.dataset.loadMore || 'next');
        return;
      }

      const emptyReset = event.target.closest('[data-empty-reset]');
      if (emptyReset) {
        options.onResetFilters?.();
        return;
      }

      const wishlistClear = event.target.closest('[data-wishlist-clear]');
      if (wishlistClear) {
        if (window.confirm('Clear all saved items from your wishlist?')) {
          DJ.setWishlist([]);
        }
        return;
      }

      const wishlistAddCart = event.target.closest('[data-wishlist-add-cart]');
      if (wishlistAddCart) {
        renderedProducts.filter(isDirectCheckoutCandidate).forEach((product) => addToCart(product));
        window.location.href = 'cart.html';
        return;
      }

      if (event.target.closest('[data-wishlist-inquiry]')) {
        DJ.trackEvent?.('bundle_open', { kind: 'wishlist' });
        return;
      }

      const productCard = event.target.closest('.product-card');
      if (!productCard) return;

      if (productCard.dataset.gallerySwipeHandled === 'true') {
        event.preventDefault();
        delete productCard.dataset.gallerySwipeHandled;
        return;
      }

      const productId = Number(productCard.dataset.productId);
      const product = gridProductLookups.get(container)?.get(productId);
      if (!product) return;
      const contextProducts = gridProductSequences.get(container) || productSequence;

      const galleryStep = event.target.closest('[data-card-gallery-step]');
      if (galleryStep) {
        event.preventDefault();
        stepProductCardGallery(productCard, product, Number(galleryStep.dataset.cardGalleryStep || 0));
        return;
      }

      if (event.target.closest('.wishlist-button')) {
        event.preventDefault();
        toggleWishlist(productId);
        return;
      }

      if (event.target.closest('[data-product-offer]')) {
        return;
      }

      if (event.target.closest('[data-product-buy]')) {
        event.preventDefault();
        buyNow(product);
        return;
      }

      if (event.target.closest('[data-product-cart]')) {
        event.preventDefault();
        addToCart(product);
        return;
      }

      if (event.target.closest('[data-product-details]')) {
        event.preventDefault();
        openModal(product, { contextProducts });
        return;
      }

      openModal(product, { contextProducts });
    };

    if (container.dataset.cardKeyboardBound !== 'true') {
      container.dataset.cardKeyboardBound = 'true';
      container.addEventListener('keydown', (event) => {
        const productCard = event.target.closest('.product-card');
        if (!productCard) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (event.target.closest('button, a, input, select, textarea')) return;

        const productId = Number(productCard.dataset.productId);
        const product = gridProductLookups.get(container)?.get(productId);
        if (!product) return;

        event.preventDefault();
        openModal(product, { contextProducts: gridProductSequences.get(container) || productSequence });
      });
    }

    if (container.dataset.cardGallerySwipeBound === 'true') return;
    container.dataset.cardGallerySwipeBound = 'true';
    let cardGallerySwipe = null;

    container.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      if (event.target.closest('button, a, input, select, textarea')) return;

      const media = event.target.closest('[data-card-gallery="true"]');
      const productCard = media?.closest('.product-card');
      if (!media || !productCard) return;

      cardGallerySwipe = {
        card: productCard,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY
      };
    }, { passive: true });

    container.addEventListener('pointerup', (event) => {
      if (!cardGallerySwipe || cardGallerySwipe.pointerId !== event.pointerId) return;

      const swipe = cardGallerySwipe;
      cardGallerySwipe = null;
      const deltaX = event.clientX - swipe.x;
      const deltaY = event.clientY - swipe.y;
      if (Math.abs(deltaX) < 42 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return;

      const productId = Number(swipe.card.dataset.productId);
      const product = gridProductLookups.get(container)?.get(productId);
      if (!product) return;

      swipe.card.dataset.gallerySwipeHandled = 'true';
      window.setTimeout(() => {
        delete swipe.card.dataset.gallerySwipeHandled;
      }, 450);
      stepProductCardGallery(swipe.card, product, deltaX < 0 ? 1 : -1);
    }, { passive: true });

    container.addEventListener('pointercancel', () => {
      cardGallerySwipe = null;
    }, { passive: true });
  }

  function filterLabel(label, value) {
    return `${label}: ${value}`;
  }

  // ---------------------------------------------------------------------------
  // Results summary and active-filter UI
  // ---------------------------------------------------------------------------

  function renderActiveFilters(filters = {}, config = {}) {
    const activeFilters = [];
    const teamLabel = getTeamFacetLabel(config);
    const conditions = Array.isArray(filters.conditions) ? filters.conditions : [];
    const attributes = Array.isArray(filters.attributes) ? filters.attributes : [];
    const teams = Array.isArray(filters.teams) ? filters.teams : [];
    const addFilter = (key, label, value, tone = 'default') => {
      activeFilters.push({ key, label, value, tone });
    };

    if (filters.filterText) addFilter('filterText', 'Search', `"${filters.filterText}"`, 'search');
    conditions.forEach((value) => addFilter(`condition::${encodeURIComponent(value)}`, 'Condition', value, 'facet'));
    attributes.forEach((value) => addFilter(`attribute::${encodeURIComponent(value)}`, 'Attribute', value, 'facet'));
    teams.forEach((value) => addFilter(`team::${encodeURIComponent(value)}`, teamLabel, value, 'facet'));
    if (filters.yearMin != null) addFilter('yearMin', 'Year from', filters.yearMin, 'range');
    if (filters.yearMax != null) addFilter('yearMax', 'Year to', filters.yearMax, 'range');
    if (filters.priceMin != null) addFilter('priceMin', 'Min price', DJ.currency(filters.priceMin), 'range');
    if (filters.priceMax != null) addFilter('priceMax', 'Max price', DJ.currency(filters.priceMax), 'range');
    if (filters.sort && filters.sort !== DEFAULT_CATALOG_SORT) {
      addFilter('sort', 'Sort', getSortLabel(filters.sort), 'sort');
    }

    return activeFilters;
  }

  function updateFilterPanelStatus(filters, count, config = {}, activeFilters = renderActiveFilters(filters, config)) {
    const filterPanel = document.querySelector('.filter-panel--drawer');
    if (!filterPanel) return;

    const countNode = filterPanel.querySelector('.filter-panel-status__count');
    const activeNode = filterPanel.querySelector('.filter-panel-status__active');
    const contextNode = filterPanel.querySelector('.filter-panel-status-copy');
    const resetButton = filterPanel.querySelector('[data-filter-panel-reset]');
    const resultCount = Number.isFinite(Number(count)) ? Number(count) : 0;
    const activeCount = activeFilters.length;

    if (countNode) {
      countNode.textContent = resultCount + ' item' + (resultCount === 1 ? '' : 's') + ' available';
    }
    if (activeNode) {
      activeNode.textContent = activeCount ? activeCount + ' active' : 'All items';
    }
    if (contextNode) {
      contextNode.textContent = activeCount
        ? 'Refine the collection or reset your current selection.'
        : 'Choose the details that matter to your collection.';
    }
    if (resetButton) {
      resetButton.hidden = activeCount === 0;
    }
  }

  function updateResultsMeta(filters, count, config = {}, renderState = {}) {
    const resultsSummary = document.getElementById('resultsSummary');
    const activeFiltersWrap = document.getElementById('activeFilters');
    const resultsLive = document.getElementById('resultsLive');
    const activeFilters = renderActiveFilters(filters, config);
    updateFilterPanelStatus(filters, count, config, activeFilters);
    if (!resultsSummary && !activeFiltersWrap && !resultsLive) return;

    const totalCount = Number.isFinite(Number(renderState.totalCount)) ? Number(renderState.totalCount) : count;
    const pageStart = Number(renderState.pageStart);
    const pageEnd = Number(renderState.pageEnd);
    const pageRangeText = Number.isFinite(pageStart) && Number.isFinite(pageEnd) && count > 0
      ? `${pageStart}-${pageEnd} of ${count} item${count === 1 ? '' : 's'} shown`
      : `${count} item${count === 1 ? '' : 's'} shown`;
    const summaryText = totalCount > count
      ? `${pageRangeText}. ${count} of ${totalCount} item${totalCount === 1 ? '' : 's'} match filters`
      : pageRangeText;
    const longSummary = activeFilters.length
      ? `${summaryText}. ${activeFilters.length} filter${activeFilters.length === 1 ? '' : 's'} active.`
      : `${summaryText}. Showing all available items.`;

    if (resultsSummary && resultsSummary.textContent !== longSummary) {
      resultsSummary.textContent = longSummary;
    }
    const conciseAnnouncement = activeFilters.length
      ? `${count} matching item${count === 1 ? '' : 's'} available. ${activeFilters.length} filter${activeFilters.length === 1 ? '' : 's'} active.`
      : `${count} item${count === 1 ? '' : 's'} available.`;
    if (resultsLive && resultsLive.textContent !== conciseAnnouncement) {
      resultsLive.textContent = conciseAnnouncement;
    }

    if (activeFiltersWrap) {
      const clearAllMarkup = activeFilters.length
        ? `
          <button type="button" class="filter-chip filter-chip--removable filter-chip--clear-all" data-clear-filter="all" aria-label="Clear all filters">
            <span>Clear all</span>
            <span class="filter-chip-x" aria-hidden="true">&times;</span>
          </button>
        `
        : '';
      const nextMarkup = `${activeFilters.map((item) => `
        <button type="button" class="filter-chip filter-chip--removable" data-clear-filter="${DJ.escapeHtml(item.key)}" aria-label="Clear ${DJ.escapeHtml(item.label)} filter">
          <span>${DJ.escapeHtml(filterLabel(item.label, item.value))}</span>
          <span class="filter-chip-x" aria-hidden="true">&times;</span>
        </button>
      `).join('')}${clearAllMarkup}`;
      if (activeFiltersWrap.innerHTML !== nextMarkup) {
        activeFiltersWrap.innerHTML = nextMarkup;
      }
    }

    if (typeof updateMobileFilterState === 'function') {
      updateMobileFilterState(filters, count, config);
    }
  }

  function getCurrentFilters() {
    const numericFieldValue = (id) => {
      const raw = String(document.getElementById(id)?.value || '').trim();
      if (!raw) return null;
      const numericValue = Number(raw);
      return Number.isFinite(numericValue) ? numericValue : null;
    };

    const normalizeRangePair = (minValue, maxValue) => (
      minValue != null && maxValue != null && minValue > maxValue
        ? [maxValue, minValue]
        : [minValue, maxValue]
    );

    let yearMin = numericFieldValue('yearMin');
    let yearMax = numericFieldValue('yearMax');
    let priceMin = numericFieldValue('priceMin');
    let priceMax = numericFieldValue('priceMax');

    [yearMin, yearMax] = normalizeRangePair(yearMin, yearMax);
    [priceMin, priceMax] = normalizeRangePair(priceMin, priceMax);

    return {
      filterText: String(document.getElementById('searchInput')?.value || '').trim(),
      conditions: getCheckedFacetValues('condition'),
      attributes: getCheckedFacetValues('attribute'),
      teams: getCheckedFacetValues('team'),
      yearMin,
      yearMax,
      priceMin,
      priceMax,
      sort: document.getElementById('sortSelect')?.value || document.getElementById('toolbarSortSelect')?.value || DEFAULT_CATALOG_SORT,
      page: sanitizeCatalogPage(currentCatalogPage),
      perPage: sanitizeItemsPerPage(currentCatalogItemsPerPage)
    };
  }

  function syncFiltersToUrl(filters) {
    const url = new URL(window.location.href);
    ['search', 'condition', 'attribute', 'team', 'yearMin', 'yearMax', 'priceMin', 'priceMax', 'sort', 'page', 'perPage'].forEach((key) => {
      url.searchParams.delete(key);
    });

    if (filters.filterText) url.searchParams.set('search', filters.filterText);
    filters.conditions.forEach((value) => url.searchParams.append('condition', value));
    filters.attributes.forEach((value) => url.searchParams.append('attribute', value));
    filters.teams.forEach((value) => url.searchParams.append('team', value));
    if (filters.yearMin != null) url.searchParams.set('yearMin', String(filters.yearMin));
    if (filters.yearMax != null) url.searchParams.set('yearMax', String(filters.yearMax));
    if (filters.priceMin != null) url.searchParams.set('priceMin', String(filters.priceMin));
    if (filters.priceMax != null) url.searchParams.set('priceMax', String(filters.priceMax));
    if (filters.sort && filters.sort !== DEFAULT_CATALOG_SORT) url.searchParams.set('sort', filters.sort);
    if (filters.page && filters.page > 1) url.searchParams.set('page', String(filters.page));
    if (filters.perPage && filters.perPage !== DEFAULT_CATALOG_ITEMS_PER_PAGE) url.searchParams.set('perPage', String(filters.perPage));

    const nextSearch = url.searchParams.toString();
    const currentSearch = window.location.search.replace(/^\?/, '');
    if (nextSearch !== currentSearch) {
      const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }
  }

  function applyFilterStateToControls(filters = {}) {
    const valueMap = {
      searchInput: filters.filterText || '',
      yearMin: filters.yearMin || '',
      yearMax: filters.yearMax || '',
      priceMin: filters.priceMin || '',
      priceMax: filters.priceMax || '',
      sortSelect: filters.sort || DEFAULT_CATALOG_SORT,
      toolbarSortSelect: filters.sort || DEFAULT_CATALOG_SORT
    };

    Object.entries(valueMap).forEach(([id, value]) => {
      const field = document.getElementById(id);
      if (field) field.value = value;
    });

    [
      ['condition', new Set(filters.conditions || [])],
      ['attribute', new Set(filters.attributes || [])],
      ['team', new Set(filters.teams || [])]
    ].forEach(([name, selectedValues]) => {
      document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
        input.checked = selectedValues.has(input.value);
      });
    });
  }

  function applyUrlFilters() {
    const params = new URLSearchParams(window.location.search);
    const initial = {
      filterText: params.get('search') || '',
      conditions: parseMultiValueParams(params, 'condition'),
      attributes: parseMultiValueParams(params, 'attribute'),
      teams: parseMultiValueParams(params, 'team'),
      yearMin: params.get('yearMin'),
      yearMax: params.get('yearMax'),
      priceMin: params.get('priceMin'),
      priceMax: params.get('priceMax'),
      sort: params.get('sort') || DEFAULT_CATALOG_SORT
    };

    currentCatalogPage = sanitizeCatalogPage(params.get('page'));
    currentCatalogItemsPerPage = sanitizeItemsPerPage(params.get('perPage'));

    if (!Object.hasOwn(CATALOG_SORT_LABELS, initial.sort)) {
      initial.sort = DEFAULT_CATALOG_SORT;
    }

    applyFilterStateToControls(initial);

    return initial;
  }

  function removeCategoryField() {
    const categorySelect = document.getElementById('categoryFilter');
    if (!categorySelect) return;

    const fieldGroup = categorySelect.closest('.field-group');
    fieldGroup?.remove();
  }

  // ---------------------------------------------------------------------------
  // Facet/filter construction
  // ---------------------------------------------------------------------------

  function mountFacetFilters(products, config, initialFilters) {
    const allowedProducts = Array.isArray(products) ? products : [];
    const facetSummary = buildFacetSummary(allowedProducts);

    const conditionSelect = document.getElementById('conditionFilter');
    const conditionGroup = conditionSelect?.closest('.field-group');

    removeCategoryField();

    if (conditionGroup) {
      conditionGroup.classList.add('field-group--facet');
      conditionGroup.innerHTML = buildFacetMarkup({
        name: 'condition',
        label: 'Condition',
        options: toCountedFacetOptions(['Graded', 'Ungraded'], facetSummary.conditionCounts, initialFilters.conditions),
        selectedValues: initialFilters.conditions,
        collapsedCount: 5
      });
    }

    let attributeGroup = document.getElementById('attributeFacetGroup');
    if (!attributeGroup && conditionGroup) {
      attributeGroup = document.createElement('div');
      attributeGroup.id = 'attributeFacetGroup';
      attributeGroup.className = 'field-group field-group--facet';
      conditionGroup.insertAdjacentElement('afterend', attributeGroup);
    }

    if (attributeGroup) {
      attributeGroup.innerHTML = buildFacetMarkup({
        name: 'attribute',
        label: 'Attributes',
        options: toCountedFacetOptions(facetSummary.availableAttributes, facetSummary.attributeCounts, initialFilters.attributes),
        selectedValues: initialFilters.attributes,
        emptyText: 'No enhanced attributes are available for this page yet.',
        collapsedCount: 5
      });
    }

    let teamGroup = document.getElementById('teamFacetGroup');
    if (!teamGroup && (attributeGroup || conditionGroup)) {
      teamGroup = document.createElement('div');
      teamGroup.id = 'teamFacetGroup';
      teamGroup.className = 'field-group field-group--facet';
      (attributeGroup || conditionGroup).insertAdjacentElement('afterend', teamGroup);
    }

    if (teamGroup) {
      const teamOptions = toCountedFacetOptions(
        facetSummary.teamValues,
        facetSummary.teamCounts,
        initialFilters.teams
      );
      teamGroup.innerHTML = buildFacetMarkup({
        name: 'team',
        label: getTeamFacetLabel(config),
        options: teamOptions,
        selectedValues: initialFilters.teams,
        emptyText: 'No team or publisher filters available for this page yet.',
        collapsedCount: 5
      });
    }
  }

  function enhanceFilterCopy(config) {
    const filterPanelHeader = document.querySelector('.filter-panel-header');
    const filterPanelTitle = filterPanelHeader?.querySelector('h2');
    const filterPanelDescription = filterPanelHeader?.querySelector('p');
    const searchInput = document.getElementById('searchInput');
    const filterHelp = document.getElementById('filterHelp');
    const searchLabel = document.querySelector('label[for="searchInput"]');
    const clearButton = document.getElementById('clearFilters');
    const sortSelect = document.getElementById('sortSelect');
    const filterContextByPage = {
      shop: 'Browse inventory',
      'sports-hub': 'Sports card inventory',
      comics: 'Comic inventory',
      collectibles: 'Collectibles inventory',
      'baseball-cards': 'Baseball inventory',
      'basketball-cards': 'Basketball inventory',
      'football-cards': 'Football inventory'
    };

    if (filterPanelTitle) filterPanelTitle.textContent = 'Filters';
    filterPanelDescription?.remove();
    if (filterPanelHeader) {
      let eyebrow = filterPanelHeader.querySelector('.filter-panel-eyebrow');
      if (!eyebrow) {
        eyebrow = document.createElement('span');
        eyebrow.className = 'filter-panel-eyebrow';
        filterPanelHeader.prepend(eyebrow);
      }
      eyebrow.textContent = filterContextByPage[document.body.dataset.page || ''] || 'Browse inventory';

      if (!filterPanelHeader.querySelector('.filter-panel-status')) {
        filterPanelHeader.insertAdjacentHTML('beforeend',
          '<div class="filter-panel-status">'
          + '<span class="filter-panel-status__summary">'
          + '<strong class="filter-panel-status__count">Loading inventory</strong>'
          + '<span class="filter-panel-status__active">All items</span>'
          + '</span>'
          + '<button type="button" class="filter-panel-status__reset" data-filter-panel-reset hidden>Reset</button>'
          + '</div>'
          + '<p class="filter-panel-status-copy">Choose the details that matter to your collection.</p>'
        );
      }

      const panelResetButton = filterPanelHeader.querySelector('[data-filter-panel-reset]');
      if (panelResetButton && panelResetButton.dataset.bound !== 'true') {
        panelResetButton.dataset.bound = 'true';
        panelResetButton.addEventListener('click', () => clearButton?.click());
      }
    }
    removeCategoryField();
    if (searchLabel && config.searchLabel) searchLabel.textContent = config.searchLabel;
    if (searchInput && config.searchPlaceholder) searchInput.placeholder = config.searchPlaceholder;
    if (filterHelp && config.helperText) filterHelp.textContent = config.helperText;
    if (clearButton) clearButton.textContent = 'Reset all filters';
    if (sortSelect) {
      sortSelect.closest('.field-group')?.classList.add('field-group--sort-source');
      Array.from(sortSelect.options).forEach((option) => {
        option.textContent = getSortLabel(option.value);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Progressive enhancements for the filter UI
  // ---------------------------------------------------------------------------

  function decorateSearchField() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;

    let shell = searchInput.parentElement;
    if (!shell.classList.contains('search-shell')) {
      shell = document.createElement('div');
      shell.className = 'search-shell';
      searchInput.parentNode.insertBefore(shell, searchInput);
      shell.appendChild(searchInput);
    }

    let clearButton = shell.querySelector('.search-clear');
    if (!clearButton) {
      clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'search-clear';
      clearButton.setAttribute('aria-label', 'Clear search');
      clearButton.textContent = '\u00D7';
      clearButton.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.focus();
      });
      shell.appendChild(clearButton);
    }

    let shortcut = shell.querySelector('.search-shortcut');
    if (!shortcut) {
      shortcut = document.createElement('span');
      shortcut.className = 'search-shortcut';
      shortcut.setAttribute('aria-hidden', 'true');
      shortcut.textContent = '/';
      shell.appendChild(shortcut);
    }

    const syncState = () => {
      shell.classList.toggle('has-value', Boolean(searchInput.value.trim()));
    };

    syncState();
    searchInput.addEventListener('input', syncState);
    searchInput.closest('.field-group')?.querySelector('.search-suggestions')?.remove();
  }

  function addToolbarActions() {
    const resultsToolbar = document.getElementById('resultsToolbar');
    if (!resultsToolbar) return;
    const page = document.body.dataset.page || '';

    if (!resultsToolbar.querySelector('.toolbar-sort')) {
      const sortControl = document.createElement('div');
      sortControl.className = 'toolbar-sort';
      sortControl.innerHTML = `
        <label for="toolbarSortSelect">Sort by</label>
        <select id="toolbarSortSelect" aria-label="Sort catalog results">
          ${Object.entries(CATALOG_SORT_LABELS).map(([value, label]) => `<option value="${DJ.escapeHtml(value)}">${DJ.escapeHtml(label)}</option>`).join('')}
        </select>
      `;

      const toolbarSelect = sortControl.querySelector('#toolbarSortSelect');
      const primarySort = document.getElementById('sortSelect');
      if (toolbarSelect && primarySort) {
        toolbarSelect.value = primarySort.value || DEFAULT_CATALOG_SORT;
        toolbarSelect.addEventListener('change', () => {
          primarySort.value = toolbarSelect.value;
          // Dispatch through the original select so the existing filter binding
          // handles rendering, URL sync, active chips, and count updates.
          primarySort.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }

      resultsToolbar.insertBefore(sortControl, resultsToolbar.firstElementChild);
    }

    if (!resultsToolbar.querySelector('.toolbar-search')) {
      const searchInput = document.getElementById('searchInput');
      const searchFieldGroup = searchInput?.closest('.field-group');
      const sortControl = resultsToolbar.querySelector('.toolbar-sort');
      if (searchFieldGroup) {
        const toolbarSearch = document.createElement('div');
        toolbarSearch.className = 'toolbar-search';
        toolbarSearch.setAttribute('role', 'search');

        const searchLabel = searchFieldGroup.querySelector('label[for="searchInput"]');
        const filterHelp = searchFieldGroup.querySelector('#filterHelp');
        searchFieldGroup.classList.add('field-group--toolbar-search');
        if (searchLabel) {
          searchLabel.classList.remove('sr-only');
          searchLabel.classList.add('toolbar-search-label');
          searchLabel.textContent = searchLabel.textContent.trim() || 'Search listings';
        }
        if (searchInput) {
          searchInput.type = 'search';
          searchInput.autocomplete = 'off';
          searchInput.inputMode = 'search';
          searchInput.setAttribute('enterkeyhint', 'search');
          searchInput.setAttribute('aria-label', searchLabel?.textContent?.trim() || 'Search listings');
        }
        filterHelp?.classList.add('sr-only');

        toolbarSearch.appendChild(searchFieldGroup);
        resultsToolbar.insertBefore(toolbarSearch, sortControl ? sortControl.nextSibling : resultsToolbar.firstElementChild);
      }
    }

    if (resultsToolbar.querySelector('.toolbar-actions')) return;

    const wrap = document.createElement('div');
    wrap.className = 'toolbar-actions';

    const contactLink = document.createElement('a');
    contactLink.className = 'mini-link-button mini-link-button--primary';
    contactLink.href = 'contact.html';
    contactLink.textContent = page === 'comics'
      ? 'Ask about a comic'
      : page === 'collectibles'
        ? 'Ask about an item'
        : 'Ask about a card';

    const wishlistLink = document.createElement('a');
    wishlistLink.className = 'mini-link-button mini-link-button--accent';
    wishlistLink.href = 'wishlist.html';
    wishlistLink.textContent = 'Open wishlist';

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'mini-link-button';
    resetButton.textContent = 'Reset filters';
    resetButton.addEventListener('click', () => document.getElementById('clearFilters')?.click());

    wrap.appendChild(contactLink);
    wrap.appendChild(wishlistLink);
    wrap.appendChild(resetButton);
    resultsToolbar.appendChild(wrap);
  }

  function ensureCatalogPaginationControls() {
    const resultsToolbar = document.getElementById('resultsToolbar');
    const productContainer = document.getElementById('productContainer');

    if (resultsToolbar && !document.getElementById('catalogPaginationTop')) {
      const topPagination = document.createElement('div');
      topPagination.id = 'catalogPaginationTop';
      topPagination.className = 'catalog-pagination catalog-pagination--top';
      const toolbarActions = resultsToolbar.querySelector('.toolbar-actions');
      resultsToolbar.insertBefore(topPagination, toolbarActions || null);
    }

    if (productContainer && !document.getElementById('catalogPaginationBottom')) {
      const bottomPagination = document.createElement('div');
      bottomPagination.id = 'catalogPaginationBottom';
      bottomPagination.className = 'catalog-pagination catalog-pagination--bottom';
      productContainer.insertAdjacentElement('afterend', bottomPagination);
    }

    const bottomPagination = document.getElementById('catalogPaginationBottom');
    const supportCallout = document.getElementById('catalogSupportCallout');
    if (productContainer && bottomPagination && supportCallout && supportCallout.previousElementSibling !== bottomPagination) {
      productContainer.insertAdjacentElement('afterend', bottomPagination);
    }
  }

  function renderPaginationButton(pageNumber, state) {
    const isActive = pageNumber === state.page;
    const label = isActive ? `Page ${pageNumber}, current page` : `Go to page ${pageNumber}`;
    return `
      <button
        type="button"
        class="catalog-pagination__page${isActive ? ' is-active' : ''}"
        data-pagination-page="${pageNumber}"
        aria-label="${DJ.escapeHtml(label)}"
        title="${DJ.escapeHtml(label)}"
        ${isActive ? 'aria-current="page"' : ''}
      >${pageNumber}</button>
    `;
  }

  function renderPaginationItem(pageItem, state) {
    return typeof pageItem === 'number'
      ? renderPaginationButton(pageItem, state)
      : '<span class="catalog-pagination__ellipsis" aria-hidden="true">&hellip;</span>';
  }

  function renderPaginationMarkup(state, placement = 'top') {
    const pageNumbers = getVisiblePageNumbers(state.page, state.totalPages);
    const rangeText = state.totalCount
      ? `${state.startIndex + 1}-${state.endIndex} of ${state.totalCount}`
      : '0 items';

    return `
      <nav class="catalog-pagination__inner" aria-label="${placement === 'top' ? 'Top' : 'Bottom'} catalog pagination">
        <span class="catalog-pagination__range">${DJ.escapeHtml(rangeText)}</span>
        <button
          type="button"
          class="catalog-pagination__arrow"
          data-pagination-action="prev"
          aria-label="Previous page"
          title="Previous page"
          ${state.page <= 1 ? 'disabled' : ''}
        >&lsaquo;</button>
        <div class="catalog-pagination__pages" aria-label="Pages" role="group">
          ${pageNumbers.map((pageItem) => renderPaginationItem(pageItem, state)).join('')}
        </div>
        <button
          type="button"
          class="catalog-pagination__arrow"
          data-pagination-action="next"
          aria-label="Next page"
          title="Next page"
          ${state.page >= state.totalPages ? 'disabled' : ''}
        >&rsaquo;</button>
        <label class="catalog-pagination__per-page">
          <span>Items Per Page</span>
          <select data-items-per-page aria-label="Items per page">
            ${CATALOG_ITEMS_PER_PAGE_OPTIONS.map((option) => `
              <option value="${option}"${option === state.perPage ? ' selected' : ''}>${option}</option>
            `).join('')}
          </select>
        </label>
      </nav>
    `;
  }

  function updateCatalogPaginationControls(state) {
    ensureCatalogPaginationControls();
    // Single-page result sets already have a summary line, so hiding the page
    // controls keeps smaller categories from carrying unnecessary chrome.
    const shouldShowPagination = Boolean(state.totalCount) && state.totalPages > 1;

    document.querySelectorAll('.catalog-pagination').forEach((pagination) => {
      const placement = pagination.id === 'catalogPaginationBottom' ? 'bottom' : 'top';
      const renderSignature = shouldShowPagination
        ? [placement, state.page, state.totalPages, state.totalCount, state.startIndex, state.endIndex, state.perPage].join('|')
        : 'hidden';
      pagination.hidden = !shouldShowPagination;
      if (pagination.dataset.paginationSignature === renderSignature) {
        return;
      }

      pagination.innerHTML = shouldShowPagination ? renderPaginationMarkup(state, placement) : '';
      pagination.dataset.paginationSignature = renderSignature;
    });
  }

  function scrollCatalogToResults() {
    const target = document.getElementById('resultsToolbar') || document.getElementById('productContainer');
    if (!target) return;

    const headerOffset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 96;
    const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - headerOffset - 16);
    const behavior = DJ.getScrollBehavior();
    window.scrollTo({ top, behavior });
  }

  function bindCatalogPagination(config = {}) {
    if (document.body.dataset.catalogPaginationBound === 'true') return;
    document.body.dataset.catalogPaginationBound = 'true';

    document.body.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-pagination-page], [data-pagination-action]');
      if (!button || button.disabled) return;

      if (button.dataset.paginationPage) {
        currentCatalogPage = sanitizeCatalogPage(button.dataset.paginationPage);
      } else if (button.dataset.paginationAction === 'prev') {
        currentCatalogPage = Math.max(1, currentCatalogPage - 1);
      } else if (button.dataset.paginationAction === 'next') {
        currentCatalogPage += 1;
      }

      await renderCatalogPage(config);
      scrollCatalogToResults();
    });

    document.body.addEventListener('change', async (event) => {
      const select = event.target.closest('[data-items-per-page]');
      if (!select) return;

      currentCatalogItemsPerPage = sanitizeItemsPerPage(select.value);
      currentCatalogPage = 1;
      await renderCatalogPage(config);
      scrollCatalogToResults();
    });
  }

  /**
   * The catalog HTML starts as simple, static markup for resilience. This helper
   * upgrades that markup into the interactive desktop drawer/results shell.
   */
  function ensureCatalogBrowseLayout() {
    const filterPanel = document.querySelector('.filter-panel');
    const resultsToolbar = document.getElementById('resultsToolbar');
    const productContainer = document.getElementById('productContainer');
    const container = filterPanel?.parentElement;

    if (!filterPanel || !resultsToolbar || !productContainer || !container) return null;

    container.classList.add('catalog-browse-layout');
    filterPanel.id = filterPanel.id || 'catalogFiltersPanel';
    filterPanel.classList.add('filter-panel--drawer');

    let dismissButton = filterPanel.querySelector('.filter-panel-dismiss');
    if (!dismissButton) {
      dismissButton = document.createElement('button');
      dismissButton.type = 'button';
      dismissButton.className = 'filter-panel-dismiss';
      dismissButton.setAttribute('aria-label', 'Close filters');
      dismissButton.innerHTML = '&times;';
      filterPanel.prepend(dismissButton);
    }

    let browseShell = container.querySelector('.catalog-browse-shell');
    if (!browseShell) {
      browseShell = document.createElement('div');
      browseShell.className = 'catalog-browse-shell';
      container.insertBefore(browseShell, filterPanel);
    }

    if (filterPanel.parentElement !== browseShell) {
      browseShell.insertBefore(filterPanel, browseShell.firstChild);
    }

    let resultsColumn = browseShell.querySelector('.catalog-results-column');
    if (!resultsColumn) {
      resultsColumn = document.createElement('div');
      resultsColumn.className = 'catalog-results-column';
      browseShell.appendChild(resultsColumn);
    }

    if (resultsToolbar.parentElement !== resultsColumn) {
      resultsColumn.appendChild(resultsToolbar);
    }

    if (productContainer.parentElement !== resultsColumn) {
      resultsColumn.appendChild(productContainer);
    }

    const supportCallout = document.getElementById('catalogSupportCallout');
    if (supportCallout && supportCallout.parentElement !== resultsColumn) {
      resultsColumn.appendChild(supportCallout);
    } else if (supportCallout && supportCallout.previousElementSibling !== productContainer) {
      resultsColumn.appendChild(supportCallout);
    }

    return { container, browseShell, resultsColumn, dismissButton };
  }

  function readStoredSidebarVisibility() {
    try {
      return localStorage.getItem(FILTER_SIDEBAR_VISIBILITY_KEY);
    } catch {
      return null;
    }
  }

  function writeStoredSidebarVisibility(isVisible) {
    try {
      localStorage.setItem(FILTER_SIDEBAR_VISIBILITY_KEY, isVisible ? 'visible' : 'hidden');
    } catch {
      // Ignore storage failures; the toggle should still work for the current session.
    }
  }

  /**
   * Drives the desktop filter drawer with one side-arrow control. The same state
   * class is shared by the hero and product grid so both resize together.
   */
  function setupFilterSidebarToggle() {
    const browseShell = document.querySelector('.catalog-browse-shell');
    const filterPanel = document.querySelector('.filter-panel');
    const dismissButton = filterPanel?.querySelector('.filter-panel-dismiss');
    if (!browseShell || !filterPanel || filterPanel.dataset.sidebarToggleBound === 'true') return;

    filterPanel.dataset.sidebarToggleBound = 'true';
    document.body.classList.add('catalog-sidebar-ready');

    // Product pages should always start with the rail open on load so the user
    // immediately sees the available filters, even if they collapsed it earlier.
    let sidebarVisible = SIDEBAR_DEFAULT_OPEN_PAGES.has(document.body.dataset.page || '')
      ? true
      : readStoredSidebarVisibility() !== 'hidden';
    let dockToggle = document.getElementById('catalogSidebarDockToggle');
    if (!dockToggle) {
      dockToggle = document.createElement('button');
      dockToggle.type = 'button';
      dockToggle.id = 'catalogSidebarDockToggle';
      document.body.appendChild(dockToggle);
    }

    dockToggle.className = 'catalog-sidebar-dock-toggle';
    dockToggle.setAttribute('aria-controls', filterPanel.id);
    if (!dockToggle.querySelector('.catalog-sidebar-dock-toggle__chevron')) {
      dockToggle.innerHTML = `
        <span class="sr-only">Toggle filters</span>
        <span class="catalog-sidebar-dock-toggle__chevron" aria-hidden="true"></span>
      `;
    }

    const handleToggleRequest = () => {
      if (window.innerWidth <= DESKTOP_FILTER_BREAKPOINT) {
        document.querySelector('.mobile-filter-trigger')?.click();
        return;
      }

      sidebarVisible = !sidebarVisible;
      syncState({ persist: true });
    };

    const syncState = ({ persist = false } = {}) => {
      const isDesktop = window.innerWidth > DESKTOP_FILTER_BREAKPOINT;
      const collapseSidebar = isDesktop && !sidebarVisible;

      // Body-level state lets CSS resize content that lives outside the product
      // grid, especially the product-page hero above the filter/results shell.
      browseShell.classList.toggle('filters-collapsed', collapseSidebar);
      document.body.classList.toggle('filters-sidebar-open', isDesktop && !collapseSidebar);
      document.body.classList.toggle('filters-sidebar-collapsed', isDesktop && collapseSidebar);
      if (isDesktop) {
        filterPanel.setAttribute('aria-hidden', String(collapseSidebar));
        if ('inert' in filterPanel) {
          filterPanel.inert = collapseSidebar;
        }
        setFilterPanelDescendantsFocusable(filterPanel, !collapseSidebar);
      }

      if (dockToggle) {
        dockToggle.hidden = !isDesktop;
        dockToggle.setAttribute('aria-expanded', String(!collapseSidebar));
        dockToggle.setAttribute('aria-label', collapseSidebar ? 'Open filters' : 'Close filters');
        dockToggle.title = collapseSidebar ? 'Open filters' : 'Close filters';
      }

      if (persist && isDesktop) {
        writeStoredSidebarVisibility(!collapseSidebar);
      }
    };

    if (dockToggle.dataset.toggleBound !== 'true') {
      dockToggle.dataset.toggleBound = 'true';
      dockToggle.addEventListener('click', handleToggleRequest);
    }

    if (dismissButton && dismissButton.dataset.bound !== 'true') {
      dismissButton.dataset.bound = 'true';
      dismissButton.addEventListener('click', () => {
        if (window.innerWidth <= DESKTOP_FILTER_BREAKPOINT) {
          document.body.classList.remove('filters-open');
          return;
        }

        sidebarVisible = false;
        syncState({ persist: true });
        dockToggle.focus();
      });
    }

    DJ.addSharedResizeListener(() => {
      syncState();
    }, { runImmediately: false });

    syncState();
  }

  function insertCatalogSupportCallout() {
    const productContainer = document.getElementById('productContainer');
    if (!productContainer || document.getElementById('catalogSupportCallout')) return;

    const page = document.body.dataset.page || '';
    const supportCopyByPage = {
      comics: {
        title: 'Need help finding a key issue or favorite run?',
        copy: 'Reach out if you are looking for a specific book, publisher, issue range, or collector-friendly bundle.',
        primaryLabel: 'Contact DJ about comics'
      },
      collectibles: {
        title: 'Looking for a specific collectible or memorabilia piece?',
        copy: 'Ask about availability, similar items, bundle options, or selling and trade conversations.',
        primaryLabel: 'Contact DJ about collectibles'
      }
    };

    const supportCopy = supportCopyByPage[page] || {
      title: 'Need help tracking down a player, team, or graded card?',
      copy: 'Use the contact page to ask about availability, similar inventory, bundles, want lists, or trade opportunities.',
      primaryLabel: 'Contact DJ about cards'
    };

    const callout = document.createElement('aside');
    callout.id = 'catalogSupportCallout';
    callout.className = 'catalog-support-callout panel';
    callout.innerHTML = `
      <div class="catalog-support-copy">
        <span class="catalog-support-kicker">Collector help</span>
        <h3>${DJ.escapeHtml(supportCopy.title)}</h3>
        <p>${DJ.escapeHtml(supportCopy.copy)}</p>
      </div>
      <div class="catalog-support-actions">
        <a class="button" href="contact.html">${DJ.escapeHtml(supportCopy.primaryLabel)}</a>
        <a class="button-secondary" href="wishlist.html">Review saved items</a>
      </div>
    `;

    productContainer.insertAdjacentElement('afterend', callout);
  }

  function setupSearchShortcuts() {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput || document.body.dataset.searchShortcutBound === 'true') return;

    document.body.dataset.searchShortcutBound = 'true';
    document.addEventListener('keydown', (event) => {
      const activeElement = document.activeElement;
      const isTypingInField = activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName);
      const commandShortcut = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey);
      const slashShortcut = event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey;

      if ((!commandShortcut && !slashShortcut) || isTypingInField) return;

      event.preventDefault();
      searchInput.focus();
      if (typeof searchInput.select === 'function') searchInput.select();
    });
  }

  function searchSuggestionScore(product, normalizedQuery, queryTokens) {
    const searchable = product?._searchNormalized || '';
    if (!searchable || !normalizedQuery) return 0;
    if (searchable.startsWith(normalizedQuery)) return 120;
    if (searchable.includes(normalizedQuery)) return 100;
    if (queryTokens.length && queryTokens.every((token) => searchable.includes(token))) return 80;

    // A small, token-level edit-distance fallback catches common one-character
    // mistakes without building a heavy fuzzy-search index for every page load.
    if (queryTokens.length !== 1 || normalizedQuery.length < 4 || normalizedQuery.length > 24) return 0;
    const candidates = product._searchDiscoveryTokens || (product._searchDiscoveryTokens = tokenizeSearchString([
      product.name, product.team, product.playerAthlete, product.league, product.sport
    ].join(' ')));
    const query = queryTokens[0];
    return candidates.some((candidate) => {
      if (Math.abs(candidate.length - query.length) > 1) return false;
      let differences = 0;
      let queryIndex = 0;
      let candidateIndex = 0;
      while (queryIndex < query.length && candidateIndex < candidate.length) {
        if (query[queryIndex] === candidate[candidateIndex]) {
          queryIndex += 1;
          candidateIndex += 1;
          continue;
        }
        differences += 1;
        if (differences > 1) return false;
        if (query.length > candidate.length) queryIndex += 1;
        else if (candidate.length > query.length) candidateIndex += 1;
        else {
          queryIndex += 1;
          candidateIndex += 1;
        }
      }
      return differences + (query.length - queryIndex) + (candidate.length - candidateIndex) <= 1;
    }) ? 30 : 0;
  }

  function compareSearchSuggestionEntries(left, right) {
    return right.score - left.score || TEXT_COLLATOR.compare(left.product.name, right.product.name);
  }

  function getRankedSearchSuggestions(products = [], query = '', limit = 6) {
    const normalized = normalizeSearchString(query);
    const maxResults = Math.max(0, Number(limit) || 0);
    if (!normalized || !maxResults) return [];

    const tokens = tokenizeSearchString(query);
    const ranked = [];
    for (const product of (Array.isArray(products) ? products : [])) {
      const score = searchSuggestionScore(product, normalized, tokens);
      if (!score) continue;

      const entry = { product, score };
      const lastEntry = ranked[ranked.length - 1];
      if (ranked.length >= maxResults && compareSearchSuggestionEntries(entry, lastEntry) >= 0) continue;

      const insertionIndex = ranked.findIndex((current) => compareSearchSuggestionEntries(entry, current) < 0);
      if (insertionIndex === -1) ranked.push(entry);
      else ranked.splice(insertionIndex, 0, entry);
      if (ranked.length > maxResults) ranked.pop();
    }

    return ranked;
  }

  function setupSearchDiscovery(products = []) {
    const searchInput = document.getElementById('searchInput');
    const searchShell = searchInput?.closest('.search-shell');
    if (!searchInput || !searchShell || searchInput.dataset.searchDiscoveryBound === 'true') return;
    searchInput.dataset.searchDiscoveryBound = 'true';

    const recentKey = 'djRecentCatalogSearchesV1';
    const list = document.createElement('div');
    list.className = 'search-discovery';
    list.id = 'catalogSearchDiscovery';
    list.hidden = true;
    list.setAttribute('role', 'listbox');
    searchInput.setAttribute('aria-controls', list.id);
    searchInput.setAttribute('aria-autocomplete', 'list');
    searchShell.appendChild(list);
    let activeIndex = -1;
    let dismissTimer = 0;

    const readRecent = () => {
      try {
        const saved = JSON.parse(localStorage.getItem(recentKey) || '[]');
        return Array.isArray(saved) ? saved.filter((value) => typeof value === 'string').slice(0, 5) : [];
      } catch {
        return [];
      }
    };
    const saveRecent = (value) => {
      const query = String(value || '').trim().slice(0, 80);
      if (query.length < 2) return;
      try {
        const next = [query, ...readRecent().filter((saved) => saved.toLowerCase() !== query.toLowerCase())].slice(0, 5);
        localStorage.setItem(recentKey, JSON.stringify(next));
      } catch {
        // Browsing still works when private storage is unavailable.
      }
    };
    const quickSearches = (() => {
      const page = document.body.dataset.page || '';
      if (page.includes('comic')) return ['First appearance', 'Variant cover', 'CGC'];
      if (page.includes('collectible')) return ['Autograph', 'Vintage', 'Signed'];
      return ['Rookie', 'Autograph', 'Graded'];
    })();
    const suggestions = (query) => getRankedSearchSuggestions(products, query);
    const selectQuery = (query) => {
      searchInput.value = query;
      saveRecent(query);
      list.hidden = true;
      activeIndex = -1;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      DJ.trackEvent?.('catalog_search', { queryLength: query.length });
    };
    const render = () => {
      const query = searchInput.value.trim();
      const matches = suggestions(query);
      const recentSearches = query ? [] : readRecent();
      const secondary = query
        ? []
        : [...recentSearches, ...quickSearches.filter((item) => !recentSearches.includes(item))].slice(0, 6);
      if (!matches.length && !secondary.length) {
        list.hidden = true;
        return;
      }

      const title = query ? 'Suggested listings' : 'Recent and quick searches';
      const entries = matches.length
        ? matches.map(({ product }) => ({
          query: product.name,
          label: product.name,
          meta: [product.team, product.year, DJ.displayPrice(product)].filter(Boolean).join(' · ')
        }))
        : secondary.map((item) => ({ query: item, label: item, meta: 'Search catalog' }));
      list.innerHTML = `
        <p class="search-discovery__title">${DJ.escapeHtml(title)}</p>
        ${entries.map((entry, index) => `<button type="button" class="search-discovery__item" role="option" aria-selected="false" data-search-query="${DJ.escapeHtml(entry.query)}" data-search-index="${index}"><span>${DJ.escapeHtml(entry.label)}</span><small>${DJ.escapeHtml(entry.meta)}</small></button>`).join('')}
      `;
      activeIndex = -1;
      list.hidden = false;
    };
    const setActive = (index) => {
      const buttons = [...list.querySelectorAll('[data-search-index]')];
      if (!buttons.length) return;
      activeIndex = (index + buttons.length) % buttons.length;
      buttons.forEach((button, buttonIndex) => button.setAttribute('aria-selected', String(buttonIndex === activeIndex)));
    };

    searchInput.addEventListener('focus', render);
    searchInput.addEventListener('input', render);
    searchInput.addEventListener('keydown', (event) => {
      if (list.hidden) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive(activeIndex + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive(activeIndex - 1);
      } else if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        const active = list.querySelector(`[data-search-index="${activeIndex}"]`);
        if (active) selectQuery(active.dataset.searchQuery || '');
      } else if (event.key === 'Escape') {
        list.hidden = true;
      }
    });
    searchInput.addEventListener('change', () => saveRecent(searchInput.value));
    searchInput.addEventListener('blur', () => {
      window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(() => { list.hidden = true; }, 140);
    });
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-search-query]');
      if (button) selectQuery(button.dataset.searchQuery || '');
    });
  }

  function debounce(callback, delay = 90) {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => callback(), delay);
  }

  /**
   * Cache filtered/sorted result sets by filter signature so pagination and
   * per-page changes can reuse the expensive work from the previous render.
   */
  function getCatalogProductsCacheSignature(products = []) {
    const list = Array.isArray(products) ? products : [];
    if (!list.length) return '0';
    if (catalogProductsSignatureCache.has(list)) {
      return catalogProductsSignatureCache.get(list);
    }

    // A compact source signature keeps filter-cache entries from leaking across
    // static JSON, Supabase, and browser-override catalog snapshots without
    // serializing thousands of full product records on every keystroke.
    let idChecksum = 0;
    let contentChecksum = 2166136261;
    list.forEach((product, index) => {
      const id = Number(product?.id) || 0;
      idChecksum = (idChecksum + ((id * (index + 1)) % 1000000007)) % 1000000007;
      const contentToken = [
        product?.updated_at,
        product?.name,
        product?.category,
        product?.team,
        product?.condition,
        product?.price_label || product?.display_price || product?.price
      ].map((value) => String(value || '')).join('|');
      for (let charIndex = 0; charIndex < contentToken.length; charIndex += 1) {
        contentChecksum ^= contentToken.charCodeAt(charIndex);
        contentChecksum = Math.imul(contentChecksum, 16777619) >>> 0;
      }
    });

    const firstId = Number(list[0]?.id) || 0;
    const lastId = Number(list[list.length - 1]?.id) || 0;
    const signature = `${list.length}:${firstId}:${lastId}:${idChecksum}:${contentChecksum}`;
    catalogProductsSignatureCache.set(list, signature);
    return signature;
  }

  function buildCatalogResultsCacheKey(filters = {}, config = {}, products = []) {
    return JSON.stringify({
      page: document.body.dataset.page || '',
      productSource: getCatalogProductsCacheSignature(products),
      allowedCategories: Array.isArray(config.allowedCategories) ? [...config.allowedCategories].sort() : null,
      filterText: normalizeSearchString(filters.filterText || ''),
      conditions: [...(filters.conditions || [])].sort(),
      attributes: [...(filters.attributes || [])].sort(),
      teams: [...(filters.teams || [])].sort(),
      yearMin: filters.yearMin ?? null,
      yearMax: filters.yearMax ?? null,
      priceMin: filters.priceMin ?? null,
      priceMax: filters.priceMax ?? null,
      sort: filters.sort || DEFAULT_CATALOG_SORT
    });
  }

  function getCatalogSortComparator(sort = DEFAULT_CATALOG_SORT) {
    switch (sort) {
      case 'priceAsc':
        return (left, right) => (left._price ?? Number.POSITIVE_INFINITY) - (right._price ?? Number.POSITIVE_INFINITY);
      case 'priceDesc':
        return (left, right) => (right._price ?? Number.NEGATIVE_INFINITY) - (left._price ?? Number.NEGATIVE_INFINITY);
      case 'yearAsc':
        return (left, right) => (left.year ?? Number.POSITIVE_INFINITY) - (right.year ?? Number.POSITIVE_INFINITY);
      case 'yearDesc':
        return (left, right) => (right.year ?? Number.NEGATIVE_INFINITY) - (left.year ?? Number.NEGATIVE_INFINITY);
      case 'nameDesc':
        return (left, right) => TEXT_COLLATOR.compare(right.name, left.name);
      default:
        return (left, right) => TEXT_COLLATOR.compare(left.name, right.name);
    }
  }

  function getFilteredCatalogProducts(products = [], filters = {}, config = {}) {
    const cacheKey = buildCatalogResultsCacheKey(filters, config, products);
    if (filteredCatalogResultsCache.has(cacheKey)) {
      return filteredCatalogResultsCache.get(cacheKey);
    }

    const searchQuery = createSearchQueryState(filters.filterText);
    const selectedConditions = new Set((filters.conditions || []).map((value) => value.toLowerCase()));
    const selectedAttributes = Array.isArray(filters.attributes) ? filters.attributes : [];
    const selectedTeams = new Set(filters.teams || []);
    const filteredProducts = [];

    for (const product of Array.isArray(products) ? products : []) {
      const matchesSearch = !searchQuery || matchesSearchQuery(product, searchQuery);
      if (!matchesSearch) continue;

      if (selectedConditions.size && !selectedConditions.has(product._conditionLower)) continue;
      if (selectedAttributes.length && !selectedAttributes.every((attribute) => product.attributes.includes(attribute))) continue;
      if (selectedTeams.size && !selectedTeams.has(product._teamFacet)) continue;
      if (filters.yearMin != null && (product.year == null || product.year < filters.yearMin)) continue;
      if (filters.yearMax != null && (product.year == null || product.year > filters.yearMax)) continue;
      if (filters.priceMin != null && (product._price == null || product._price < filters.priceMin)) continue;
      if (filters.priceMax != null && (product._price == null || product._price > filters.priceMax)) continue;

      filteredProducts.push(product);
    }

    filteredProducts.sort(getCatalogSortComparator(filters.sort));
    if (filteredCatalogResultsCache.size >= FILTERED_RESULTS_CACHE_LIMIT) {
      const oldestKey = filteredCatalogResultsCache.keys().next().value;
      if (oldestKey) {
        filteredCatalogResultsCache.delete(oldestKey);
      }
    }
    filteredCatalogResultsCache.set(cacheKey, filteredProducts);
    return filteredProducts;
  }

  /**
   * Render a category page once, then keep filtering in-memory. Callers can pass
   * the already-loaded product list during boot so the first render avoids a
   * duplicate cached source lookup.
   */
  async function renderCatalogPage(config = {}, cachedAllowedProducts = null) {
    const productContainer = document.getElementById('productContainer');
    if (!productContainer) return;

    const renderRequestId = ++catalogRenderRequestId;
    const allowedProducts = Array.isArray(cachedAllowedProducts)
      ? cachedAllowedProducts
      : (await getCatalogPageProducts(config)).allowedProducts;
    if (renderRequestId !== catalogRenderRequestId) return;

    const filters = getCurrentFilters();
    syncToolbarSortControl(filters.sort);
    const filteredProducts = getFilteredCatalogProducts(allowedProducts, filters, config);

    const resultsCount = document.getElementById('resultsCount');
    if (resultsCount) resultsCount.textContent = `${filteredProducts.length} item${filteredProducts.length === 1 ? '' : 's'} found`;

    const paginationState = getPaginationState(filteredProducts.length);
    filters.page = paginationState.page;
    filters.perPage = paginationState.perPage;
    const visibleProducts = filteredProducts.slice(paginationState.startIndex, paginationState.endIndex);

    updateResultsMeta(filters, filteredProducts.length, config, {
      totalCount: allowedProducts.length,
      pageStart: paginationState.totalCount ? paginationState.startIndex + 1 : 0,
      pageEnd: paginationState.endIndex
    });
    updateCatalogPaginationControls(paginationState);
    syncFiltersToUrl(filters);
    maybeOpenLinkedProduct(filteredProducts);

    if (!filteredProducts.length) {
      const emptyTitle = FILTER_EMPTY_TITLE;
      const emptyCopy = FILTER_EMPTY_COPY;
      clearProductGridLoadingState(productContainer);
      productContainer.dataset.productRenderSignature = 'empty';
      productContainer.innerHTML = `
        <div class="empty-state empty-state--catalog">
          <span class="empty-state-kicker">No matches</span>
          <h3>${DJ.escapeHtml(emptyTitle)}</h3>
          <p>${DJ.escapeHtml(emptyCopy)}</p>
          <div class="empty-state-actions">
            <button type="button" class="button" data-empty-reset>Clear filters</button>
            <a class="button-secondary" href="contact.html">Ask DJ to help find it</a>
          </div>
        </div>
      `;
      attachGridHandlers(productContainer, [], {
        onResetFilters: () => resetCatalogFilters(config)
      });
      DJ.applyLazyLoading(productContainer);
      DJ.updateWishlistCount();
      return;
    }

    const wishlistIds = new Set(DJ.getWishlist().map(Number));
    const renderSignature = getProductGridRenderSignature(visibleProducts, wishlistIds);
    const priorityCardCount = getPriorityProductCardCount();
    clearProductGridLoadingState(productContainer);
    if (productContainer.dataset.productRenderSignature !== renderSignature) {
      productContainer.innerHTML = visibleProducts
        .map((product, index) => renderProductCard(product, wishlistIds, {
          imagePriority: index < priorityCardCount ? 'high' : 'low'
        }))
        .join('');
      productContainer.dataset.productRenderSignature = renderSignature;
      DJ.applyLazyLoading(productContainer);
    }
    attachGridHandlers(productContainer, visibleProducts, {
      modalContextProducts: filteredProducts
    });
    DJ.updateWishlistCount();
  }

  function clearSpecificFilter(filterKey, config) {
    if (filterKey.startsWith('condition::')) {
      const value = decodeURIComponent(filterKey.split('::')[1] || '');
      const input = document.querySelector(`input[name="condition"][value="${cssEscapeValue(value)}"]`);
      if (input) input.checked = false;
    } else if (filterKey.startsWith('attribute::')) {
      const value = decodeURIComponent(filterKey.split('::')[1] || '');
      const input = document.querySelector(`input[name="attribute"][value="${cssEscapeValue(value)}"]`);
      if (input) input.checked = false;
    } else if (filterKey.startsWith('team::')) {
      const value = decodeURIComponent(filterKey.split('::')[1] || '');
      const input = document.querySelector(`input[name="team"][value="${cssEscapeValue(value)}"]`);
      if (input) input.checked = false;
    } else {
      const inputMap = {
        filterText: 'searchInput',
        yearMin: 'yearMin',
        yearMax: 'yearMax',
        priceMin: 'priceMin',
        priceMax: 'priceMax',
        sort: 'sortSelect'
      };

      const fieldId = inputMap[filterKey];
      if (!fieldId) return;
      const field = document.getElementById(fieldId);
      if (!field) return;

      if (filterKey === 'sort') field.value = DEFAULT_CATALOG_SORT;
      else field.value = '';

      if (filterKey === 'filterText') field.focus();
    }

    currentCatalogPage = 1;
    renderCatalogPage(config);
  }

  function resetCatalogFilters(config = {}, options = {}) {
    ['searchInput', 'yearMin', 'yearMax', 'priceMin', 'priceMax'].forEach((id) => {
      const field = document.getElementById(id);
      if (field) field.value = '';
    });

    document.querySelectorAll('input[name="condition"], input[name="attribute"], input[name="team"]').forEach((input) => {
      input.checked = false;
    });

    const primarySort = document.getElementById('sortSelect');
    const toolbarSort = document.getElementById('toolbarSortSelect');
    if (primarySort) primarySort.value = DEFAULT_CATALOG_SORT;
    if (toolbarSort) toolbarSort.value = DEFAULT_CATALOG_SORT;

    document.querySelectorAll('.facet-group.is-expanded').forEach((group) => group.classList.remove('is-expanded'));
    document.querySelectorAll('.facet-toggle').forEach((toggle) => {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Show more';
    });

    currentCatalogPage = 1;
    renderCatalogPage(config);

    if (options.focusSearch !== false) {
      document.getElementById('searchInput')?.focus();
    }
  }

  function bindActiveFilterActions(config) {
    const activeFiltersWrap = document.getElementById('activeFilters');
    if (!activeFiltersWrap || activeFiltersWrap.dataset.bound === 'true') return;

    activeFiltersWrap.dataset.bound = 'true';
    activeFiltersWrap.addEventListener('click', (event) => {
      const button = event.target.closest('[data-clear-filter]');
      if (!button) return;
      if (button.dataset.clearFilter === 'all') {
        resetCatalogFilters(config, { focusSearch: false });
        return;
      }
      clearSpecificFilter(button.dataset.clearFilter, config);
    });
  }

  function canRenderCatalogBootstrap(initialFilters = {}) {
    const hasActiveFilters = Boolean(
      String(initialFilters.filterText || '').trim()
      || (Array.isArray(initialFilters.conditions) && initialFilters.conditions.length)
      || (Array.isArray(initialFilters.attributes) && initialFilters.attributes.length)
      || (Array.isArray(initialFilters.teams) && initialFilters.teams.length)
      || initialFilters.yearMin
      || initialFilters.yearMax
      || initialFilters.priceMin
      || initialFilters.priceMax
      || (initialFilters.sort && initialFilters.sort !== DEFAULT_CATALOG_SORT)
    );

    return !hasActiveFilters
      && !getLinkedProductId()
      && currentCatalogPage === 1
      && sanitizeItemsPerPage(currentCatalogItemsPerPage) <= 48
      && Boolean(BOOTSTRAP_SOURCE_BY_SOURCE[getProductSource()]);
  }

  async function renderCatalogBootstrap(config = {}, initialFilters = {}) {
    if (!canRenderCatalogBootstrap(initialFilters)) {
      return false;
    }

    const productContainer = document.getElementById('productContainer');
    if (!productContainer) return false;

    const source = getProductSource();
    let payload;
    try {
      payload = await fetchCatalogBootstrap(source);
    } catch (error) {
      console.warn(`Could not load bootstrap catalog for ${source}; using full catalog load.`, error);
      return false;
    }

    const allowedProducts = normalizeProducts(filterStorefrontProducts(payload.products))
      .filter((product) => (
        !config.allowedCategories
        || !config.allowedCategories.length
        || config.allowedCategories.includes(product.category)
      ));
    if (!allowedProducts.length) return false;

    const totalCount = Math.max(allowedProducts.length, Number(payload.total) || allowedProducts.length);
    const perPage = sanitizeItemsPerPage(currentCatalogItemsPerPage);
    const visibleProducts = allowedProducts.slice(0, perPage);
    const wishlistIds = new Set(DJ.getWishlist().map(Number));
    const priorityCardCount = getPriorityProductCardCount();

    clearProductGridLoadingState(productContainer);
    productContainer.dataset.productRenderSignature = `bootstrap:${source}:${perPage}:${visibleProducts.map((product) => product.id).join(',')}`;
    productContainer.innerHTML = visibleProducts
      .map((product, index) => renderProductCard(product, wishlistIds, {
        imagePriority: index < priorityCardCount ? 'high' : 'low'
      }))
      .join('');
    attachGridHandlers(productContainer, visibleProducts, {
      modalContextProducts: visibleProducts
    });
    DJ.applyLazyLoading(productContainer);
    DJ.updateWishlistCount();

    const resultsCount = document.getElementById('resultsCount');
    if (resultsCount) {
      resultsCount.textContent = `${totalCount} item${totalCount === 1 ? '' : 's'} found`;
    }

    const filters = getCurrentFilters();
    updateResultsMeta(filters, totalCount, config, {
      totalCount,
      pageStart: 1,
      pageEnd: visibleProducts.length
    });
    updateCatalogPaginationControls({
      page: 1,
      perPage,
      totalPages: Math.max(1, Math.ceil(totalCount / perPage)),
      totalCount,
      startIndex: 0,
      endIndex: visibleProducts.length
    });

    const resultsLive = document.getElementById('resultsLive');
    if (resultsLive) {
      resultsLive.textContent = `Showing the first ${visibleProducts.length} items while full filters finish loading.`;
    }

    return true;
  }

  function setupScrollableMobileRails() {
    ['.catalog-switcher', '.breadcrumb-list'].forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (!node) return;
        node.setAttribute('tabindex', '0');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Responsive/mobile UX helpers
  // ---------------------------------------------------------------------------

  function setupMobileFilterDrawer(config) {
    const filterPanel = document.querySelector('.filter-panel');
    if (!filterPanel || filterPanel.dataset.mobileDrawerBound === 'true') return;

    const MOBILE_BREAKPOINT = DESKTOP_FILTER_BREAKPOINT;
    const mobileDrawerQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`)
      : null;
    const isMobileDrawerViewport = () => window.innerWidth <= MOBILE_BREAKPOINT;
    let drawerFocusTimer = 0;

    filterPanel.dataset.mobileDrawerBound = 'true';
    filterPanel.id = filterPanel.id || 'catalogFiltersPanel';

    const panelFooter = document.createElement('div');
    panelFooter.className = 'mobile-filter-actions';
    panelFooter.innerHTML = `
      <button type="button" class="button-secondary mobile-filter-reset">Reset all</button>
      <button type="button" class="button mobile-filter-done">Show results</button>
    `;

    filterPanel.append(panelFooter);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'mobile-filter-trigger';
    trigger.setAttribute('aria-controls', filterPanel.id);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.innerHTML = `
      <span class="mobile-filter-trigger__copy">
        <span class="mobile-filter-trigger__title">Filters</span>
        <span class="mobile-filter-trigger__meta">All items</span>
      </span>
      <span class="mobile-filter-trigger__icon" aria-hidden="true"><span></span><span></span><span></span></span>
    `;

    filterPanel.parentNode.insertBefore(trigger, filterPanel);

    const overlay = document.createElement('button');
    overlay.type = 'button';
    overlay.className = 'mobile-filter-overlay';
    overlay.setAttribute('aria-label', 'Close filters');
    filterPanel.insertAdjacentElement('afterend', overlay);

    const resetButton = panelFooter.querySelector('.mobile-filter-reset');
    const doneButton = panelFooter.querySelector('.mobile-filter-done');
    const closeButton = filterPanel.querySelector('.filter-panel-dismiss');
    const titleNode = trigger.querySelector('.mobile-filter-trigger__title');
    const metaNode = trigger.querySelector('.mobile-filter-trigger__meta');
    const panelTitle = filterPanel.querySelector('.filter-panel-header h2');
    if (panelTitle) {
      panelTitle.id = panelTitle.id || `${filterPanel.id}Title`;
    }
    overlay.tabIndex = -1;
    overlay.setAttribute('aria-hidden', 'true');

    const syncTrigger = (filters = getCurrentFilters(), count = null, activeConfig = config) => {
      const activeCount = renderActiveFilters(filters, activeConfig).length;
      if (titleNode) titleNode.textContent = activeCount ? `Filters (${activeCount})` : 'Filters';
      if (metaNode) {
        if (count == null) {
          metaNode.textContent = activeCount ? `${activeCount} active` : 'All items';
        } else {
          metaNode.textContent = activeCount ? `${count} shown | ${activeCount} active` : `${count} shown`;
        }
      }
      if (doneButton) {
        const resultCount = Number(count);
        doneButton.textContent = Number.isFinite(resultCount)
          ? `Show ${resultCount} result${resultCount === 1 ? '' : 's'}`
          : 'Show results';
      }
    };

    updateMobileFilterState = syncTrigger;

    const syncDrawerAccessibility = () => {
      const isMobileViewport = isMobileDrawerViewport();
      const isDrawerOpen = document.body.classList.contains('filters-open');

      trigger.hidden = !isMobileViewport;
      overlay.hidden = !isMobileViewport || !isDrawerOpen;

      if (!isMobileViewport) {
        setFilterDrawerBackgroundInert(filterPanel, overlay, false);
        const isDesktopSidebarCollapsed = document.body.classList.contains('filters-sidebar-collapsed');
        filterPanel.hidden = false;
        filterPanel.removeAttribute('role');
        filterPanel.removeAttribute('aria-modal');
        filterPanel.removeAttribute('aria-labelledby');
        trigger.setAttribute('aria-expanded', 'false');
        filterPanel.setAttribute('aria-hidden', String(isDesktopSidebarCollapsed));
        if ('inert' in filterPanel) {
          filterPanel.inert = isDesktopSidebarCollapsed;
        }
        setFilterPanelDescendantsFocusable(filterPanel, !isDesktopSidebarCollapsed);
        document.body.classList.remove('filters-open');
        return;
      }

      filterPanel.hidden = !isDrawerOpen;
      filterPanel.setAttribute('aria-hidden', String(!isDrawerOpen));
      filterPanel.setAttribute('role', 'dialog');
      filterPanel.setAttribute('aria-modal', 'true');
      if (panelTitle?.id) filterPanel.setAttribute('aria-labelledby', panelTitle.id);
      if ('inert' in filterPanel) {
        filterPanel.inert = !isDrawerOpen;
      }
      setFilterPanelDescendantsFocusable(filterPanel, isDrawerOpen);
      trigger.setAttribute('aria-expanded', String(isDrawerOpen));
      setFilterDrawerBackgroundInert(filterPanel, overlay, isDrawerOpen);
    };

    const closeDrawer = ({ restoreFocus = true } = {}) => {
      window.clearTimeout(drawerFocusTimer);
      document.body.classList.remove('filters-open');
      syncDrawerAccessibility();
      if (restoreFocus && !trigger.hidden) trigger.focus();
    };

    const openDrawer = () => {
      if (!isMobileDrawerViewport()) return;
      window.clearTimeout(drawerFocusTimer);
      DJ.setLastFocusedElement(trigger);
      document.body.classList.add('filters-open');
      syncDrawerAccessibility();
      drawerFocusTimer = window.setTimeout(() => {
        const focusTarget = closeButton || getVisibleFocusableElements(filterPanel)[0];
        focusTarget?.focus();
      }, 60);
    };

    trigger.addEventListener('click', () => {
      if (document.body.classList.contains('filters-open')) closeDrawer();
      else openDrawer();
    });

    [overlay, closeButton, doneButton].forEach((node) => {
      node?.addEventListener('click', () => closeDrawer());
    });

    resetButton?.addEventListener('click', () => {
      document.getElementById('clearFilters')?.click();
      syncTrigger();
    });

    const handleViewportChange = () => {
      if (!isMobileDrawerViewport() && document.body.classList.contains('filters-open')) {
        closeDrawer({ restoreFocus: false });
        return;
      }

      syncDrawerAccessibility();
    };

    // Keep a resize fallback even when MediaQueryList events are available;
    // mobile webviews and device rotation can otherwise leave dialog semantics
    // attached after the viewport has crossed back into the desktop sidebar.
    DJ.bindMediaQueryChange(mobileDrawerQuery, handleViewportChange);
    DJ.addSharedResizeListener(handleViewportChange, { runImmediately: false });

    document.addEventListener('keydown', (event) => {
      if (!isMobileDrawerViewport() || !document.body.classList.contains('filters-open')) return;

      if (event.key === 'Escape') {
        closeDrawer();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusableElements = getVisibleFocusableElements(filterPanel);
      if (!focusableElements.length) return;
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

    window.addEventListener('pageshow', () => {
      if (document.body.classList.contains('filters-open')) {
        closeDrawer({ restoreFocus: false });
        return;
      }

      syncDrawerAccessibility();
    });

    filterPanel.addEventListener('input', (event) => {
      if (event.target.matches('#searchInput, #yearMin, #yearMax, #priceMin, #priceMax')) syncTrigger();
    });

    filterPanel.addEventListener('change', (event) => {
      if (event.target.matches('input[type="checkbox"], select')) syncTrigger();
    });

    const searchInput = document.getElementById('searchInput');
    if (searchInput && searchInput.dataset.mobileDrawerSyncBound !== 'true') {
      searchInput.dataset.mobileDrawerSyncBound = 'true';
      searchInput.addEventListener('change', syncTrigger);
    }

    syncTrigger();
    syncDrawerAccessibility();
  }

  // ---------------------------------------------------------------------------
  // Page entry points
  // ---------------------------------------------------------------------------

  async function setupCatalogPage() {
    const page = document.body.dataset.page || 'shop';
    const config = PAGE_CONFIG[page] || PAGE_CONFIG.shop;
    const productContainer = document.getElementById('productContainer');
    if (!productContainer) return;

    renderProductGridLoadingState(productContainer, {
      count: Math.min(8, getRenderBatchSize(page))
    });
    setCatalogLoadingState(CATALOG_LOADING_MESSAGE);

    const initialFilters = applyUrlFilters();

    // Build the visual shell before the network request completes so the page
    // never flashes the old top-stacked filter layout during slow backend loads.
    enhanceFilterCopy(config);
    ensureCatalogBrowseLayout();
    document.querySelector('.page-hero-card')?.classList.add('catalog-hero-card--streamlined');
    decorateSearchField();
    addToolbarActions();
    ensureCatalogPaginationControls();
    setupFilterSidebarToggle();
    insertCatalogSupportCallout();
    bindCatalogPagination(config);
    setupSearchShortcuts();
    setupMobileFilterDrawer(config);
    setupScrollableMobileRails();

    let fullCatalogPromise = null;
    const hydrateFullCatalog = () => {
      if (fullCatalogPromise) return fullCatalogPromise;

      fullCatalogPromise = (async () => {
        const { allowedProducts } = await getCatalogPageProducts(config);

        mountFacetFilters(allowedProducts, config, initialFilters);
        setupSearchDiscovery(allowedProducts);
        bindActiveFilterActions(config);

        const rerender = () => {
          currentCatalogPage = 1;
          return renderCatalogPage(config);
        };
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.dataset.catalogRenderBound !== 'true') {
          searchInput.dataset.catalogRenderBound = 'true';
          searchInput.addEventListener('input', () => debounce(rerender));
          searchInput.addEventListener('change', rerender);
        }
        const filterPanel = document.querySelector('.filter-panel');

        if (filterPanel && filterPanel.dataset.catalogBindings !== 'true') {
          filterPanel.dataset.catalogBindings = 'true';

          filterPanel.addEventListener('input', (event) => {
            if (event.target.matches('#searchInput, #yearMin, #yearMax, #priceMin, #priceMax')) {
              debounce(rerender);
            }
          });

          filterPanel.addEventListener('change', (event) => {
            if (event.target.matches('input[type="checkbox"], select')) {
              rerender();
            }
          });

          filterPanel.addEventListener('click', (event) => {
            const toggle = event.target.closest('.facet-toggle');
            if (!toggle) return;
            const facetGroup = toggle.closest('.facet-group');
            if (!facetGroup) return;
            const expanded = facetGroup.classList.toggle('is-expanded');
            toggle.setAttribute('aria-expanded', String(expanded));
            toggle.textContent = expanded ? 'Show less' : 'Show more';
          });
        }

        const clearButton = document.getElementById('clearFilters');
        if (clearButton && clearButton.dataset.bound !== 'true') {
          clearButton.dataset.bound = 'true';
          clearButton.addEventListener('click', () => resetCatalogFilters(config));
        }

        if (document.body.dataset.catalogPopstateBound !== 'true') {
          document.body.dataset.catalogPopstateBound = 'true';
          window.addEventListener('popstate', () => {
            applyUrlFilters();
            // Reload through the current catalog cache so browser history cannot
            // resurrect the product snapshot captured before an in-page mutation.
            renderCatalogPage(config);
          });
        }

        await renderCatalogPage(config, allowedProducts);
      })().catch((error) => {
        fullCatalogPromise = null;
        throw error;
      });

      return fullCatalogPromise;
    };

    const bootstrapRendered = await renderCatalogBootstrap(config, initialFilters);
    if (bootstrapRendered) {
      let fullCatalogRequested = false;
      const requestFullCatalog = () => {
        if (fullCatalogRequested) return;
        fullCatalogRequested = true;

        hydrateFullCatalog().catch((error) => {
          fullCatalogRequested = false;
          console.error('Failed to hydrate full catalog filters.', error);
        });
      };
      const filterPanel = document.querySelector('.filter-panel');
      ['focusin', 'input', 'change', 'pointerdown'].forEach((eventName) => {
        filterPanel?.addEventListener(eventName, requestFullCatalog, { once: true, passive: eventName === 'pointerdown' });
      });
      window.setTimeout(() => {
        if (document.visibilityState === 'hidden') return;
        if (DJ.scheduleIdle) {
          DJ.scheduleIdle(requestFullCatalog, 3000);
          return;
        }
        requestFullCatalog();
      }, CATALOG_BACKGROUND_HYDRATION_DELAY);
      return;
    }

    await hydrateFullCatalog();
  }

  function renderWishlistEmptyState() {
    return `
      <div class="empty-state wishlist-empty-state">
        <span class="empty-state-kicker">Nothing saved yet</span>
        <h2>No saved items yet</h2>
        <p>${DJ.escapeHtml(WISHLIST_EMPTY_COPY)}</p>
        <div class="empty-state-actions">
          <a class="button" href="sports-cards.html">Browse Sports Cards</a>
          <a class="button-secondary" href="comics.html">Browse Comics</a>
          <a class="button-secondary" href="collectibles.html">Browse Collectibles</a>
        </div>
      </div>
    `;
  }

  function buildCollectorInquiryUrl(kind = 'bundle', products = []) {
    const savedProducts = normalizeModalContextProducts(products);
    const params = new URLSearchParams();
    params.set('kind', ['contact', 'sell', 'trade', 'want_list', 'offer', 'bundle'].includes(kind) ? kind : 'bundle');
    const ids = savedProducts.map((product) => Number(product.id)).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 20);
    if (ids.length) params.set('productIds', ids.join(','));
    return `sell-trade-want-list.html?${params.toString()}`;
  }

  function renderSavedCatalogUnavailableState(title, message, retryPath) {
    return `
      <div class="empty-state">
        <span class="empty-state-kicker">Temporarily unavailable</span>
        <h2>${DJ.escapeHtml(title)}</h2>
        <p>${DJ.escapeHtml(message)}</p>
        <div class="empty-state-actions">
          <a class="button" href="${DJ.escapeHtml(retryPath)}">Try Again</a>
          <a class="button-secondary" href="shop.html">Continue Browsing</a>
        </div>
      </div>
    `;
  }

  function renderWishlistActionsPanel(products = []) {
    const savedProducts = normalizeModalContextProducts(products);
    if (!savedProducts.length) return '';

    const previewProducts = savedProducts.slice(0, 3);
    const moreCount = Math.max(0, savedProducts.length - previewProducts.length);
    const countLabel = `${savedProducts.length} saved item${savedProducts.length === 1 ? '' : 's'}`;

    return `
      <aside class="wishlist-actions-panel panel" aria-label="Wishlist actions">
        <div class="wishlist-actions-copy">
          <span class="wishlist-actions-kicker">Saved list ready</span>
          <h2>${DJ.escapeHtml(countLabel)} in your wishlist</h2>
          <p>Turn saved items into a focused bundle or offer request, keep browsing, or clear the list when you are done comparing.</p>
          <ul class="wishlist-actions-list" aria-label="Saved item preview">
            ${previewProducts.map((product) => `
              <li><span>${DJ.escapeHtml(product.name)}</span><strong>${DJ.escapeHtml(DJ.displayPrice(product))}</strong></li>
            `).join('')}
            ${moreCount ? `<li><span>Additional saved items</span><strong>+${moreCount}</strong></li>` : ''}
          </ul>
        </div>
        <div class="wishlist-actions-buttons">
          <button type="button" class="button" data-wishlist-add-cart>Add Available Items to Cart</button>
          <a class="button" href="${DJ.escapeHtml(buildCollectorInquiryUrl('bundle', savedProducts))}" data-wishlist-inquiry>Build a Bundle</a>
          <a class="button-secondary" href="sports-cards.html">Browse More</a>
          <button type="button" class="button-secondary wishlist-clear-button" data-wishlist-clear>Clear Wishlist</button>
        </div>
      </aside>
    `;
  }

  async function renderWishlistPage() {
    const wishlistContainer = document.getElementById('wishlistContainer');
    if (!wishlistContainer) return;
    const renderRequestId = ++wishlistRenderRequestId;
    const wishlistPageCount = document.getElementById('wishlistPageCount');
    if (wishlistPageCount) {
      wishlistPageCount.textContent = 'Loading saved items...';
    }
    const storedWishlist = DJ.getWishlist().map(Number);

    if (!storedWishlist.length) {
      if (wishlistPageCount) {
        wishlistPageCount.textContent = 'No saved items yet';
      }
      wishlistContainer.innerHTML = renderWishlistEmptyState();
      DJ.updateWishlistCount();
      DJ.applyLazyLoading(wishlistContainer);
      return;
    }

    if (wishlistPageCount) {
      wishlistPageCount.textContent = `Loading ${storedWishlist.length} saved item${storedWishlist.length === 1 ? '' : 's'}...`;
    }
    renderProductGridLoadingState(wishlistContainer, {
      count: Math.min(6, Math.max(2, storedWishlist.length))
    });

    // Use the same resilient source selection as every catalog page. This keeps
    // local/custom listings available, honors static-first mode, and preserves
    // the remote timeout plus static fallback instead of leaving the wishlist
    // blocked on a direct backend request.
    const allProducts = await loadProducts({ source: DEFAULT_PRODUCT_SOURCE });
    if (renderRequestId !== wishlistRenderRequestId) return;
    if (!hasUsableCatalogSnapshot(allProducts)) {
      if (wishlistPageCount) {
        wishlistPageCount.textContent = `${storedWishlist.length} saved item${storedWishlist.length === 1 ? '' : 's'} still stored`;
      }
      clearProductGridLoadingState(wishlistContainer);
      wishlistContainer.innerHTML = renderSavedCatalogUnavailableState(
        'Saved items could not load',
        'Your wishlist is still saved. Refresh when the catalog connection is available again.',
        'wishlist.html'
      );
      return;
    }
    const wishlistIdSet = new Set(storedWishlist);
    let wishlistProducts = allProducts.filter((product) => wishlistIdSet.has(Number(product.id)));

    wishlistProducts = sortProductsByIdOrder(wishlistProducts, storedWishlist);

    const availableIds = new Set(wishlistProducts.map((product) => Number(product.id)).filter(Number.isFinite));
    const reconciledWishlist = storedWishlist.filter((productId) => availableIds.has(productId));

    // Prune stale wishlist ids when products were deleted, hidden, or removed from
    // the current catalog so the saved count matches what the user can actually view.
    if (reconciledWishlist.length !== storedWishlist.length) {
      DJ.setWishlist(reconciledWishlist);
    }

    const wishlistIds = new Set(reconciledWishlist);
    wishlistProducts = sortProductsByIdOrder(
      wishlistProducts.filter((product) => wishlistIds.has(Number(product.id))),
      reconciledWishlist
    );

    if (wishlistPageCount) {
      wishlistPageCount.textContent = `${wishlistProducts.length} saved item${wishlistProducts.length === 1 ? '' : 's'}`;
    }

    if (!wishlistProducts.length) {
      clearProductGridLoadingState(wishlistContainer);
      wishlistContainer.innerHTML = renderWishlistEmptyState();
      DJ.applyLazyLoading(wishlistContainer);
      return;
    }

    clearProductGridLoadingState(wishlistContainer);
    const priorityCardCount = getPriorityProductCardCount();
    wishlistContainer.innerHTML = `${renderWishlistActionsPanel(wishlistProducts)}${wishlistProducts
      .map((product, index) => renderProductCard(product, wishlistIds, {
        imagePriority: index < Math.min(4, priorityCardCount) ? 'high' : 'low'
      }))
      .join('')}`;
    attachGridHandlers(wishlistContainer, wishlistProducts);
    DJ.updateWishlistCount();
    DJ.applyLazyLoading(wishlistContainer);
  }

  function renderCartEmptyState() {
    return `
      <div class="empty-state cart-empty-state">
        <span class="empty-state-kicker">Your cart is ready when you are</span>
        <h2>Your shopping cart is empty</h2>
        <p>Add checkout-ready listings from any catalog page. Wishlist items stay saved separately until you decide to move them here.</p>
        <div class="empty-state-actions">
          <a class="button" href="sports-cards.html">Browse Sports Cards</a>
          <a class="button-secondary" href="comics.html">Browse Comics</a>
          <a class="button-secondary" href="wishlist.html">Open Wishlist</a>
        </div>
      </div>
    `;
  }

  async function renderCartPage() {
    const container = document.getElementById('cartContainer');
    if (!container) return;
    const renderRequestId = ++cartRenderRequestId;
    const storedCart = DJ.getCart();
    if (!storedCart.length) {
      container.innerHTML = renderCartEmptyState();
      DJ.updateCartCount();
      return;
    }

    renderProductGridLoadingState(container, { count: Math.min(4, storedCart.length) });
    const allProducts = await loadProducts({ source: DEFAULT_PRODUCT_SOURCE });
    if (renderRequestId !== cartRenderRequestId) return;
    if (!hasUsableCatalogSnapshot(allProducts)) {
      clearProductGridLoadingState(container);
      container.innerHTML = renderSavedCatalogUnavailableState(
        'Cart details could not load',
        'Your cart is still saved. Refresh when the catalog connection is available again.',
        'cart.html'
      );
      return;
    }
    const productsById = createProductLookup(allProducts);
    const cartItems = storedCart
      .map((item) => ({ ...item, product: productsById.get(Number(item.productId)) }))
      .filter((item) => item.product);
    const reconciled = cartItems.map((item) => ({
      productId: item.productId,
      quantity: Math.min(item.quantity, DJ.availableQuantity(item.product))
    })).filter((item) => item.quantity > 0);

    if (JSON.stringify(reconciled) !== JSON.stringify(storedCart)) {
      DJ.setCart(reconciled);
      if (renderRequestId !== cartRenderRequestId) return;
    }
    if (!cartItems.length || !reconciled.length) {
      clearProductGridLoadingState(container);
      container.innerHTML = renderCartEmptyState();
      return;
    }

    const activeItems = cartItems
      .map((item) => ({
        ...item,
        quantity: reconciled.find((entry) => entry.productId === item.productId)?.quantity || 0
      }))
      .filter((item) => item.quantity > 0);
    const itemCount = activeItems.reduce((total, item) => total + item.quantity, 0);
    const subtotal = activeItems.reduce((total, item) => (
      total + ((DJ.payablePrice(item.product) || 0) * item.quantity)
    ), 0);

    clearProductGridLoadingState(container);
    container.innerHTML = `
      <div class="cart-layout">
        <div class="cart-items" aria-label="Shopping cart items">
          ${activeItems.map(({ product, quantity }) => {
            const available = DJ.availableQuantity(product);
            const image = DJ.getThumbnailAssetCandidates(product.image)[0] || DJ.safeAssetUrl(product.image);
            return `
              <article class="cart-item" data-cart-product-id="${Number(product.id)}">
                <a class="cart-item__image" href="${DJ.escapeHtml(DJ.productPageUrl(product))}">
                  <img src="${DJ.escapeHtml(image)}" alt="${DJ.escapeHtml(product.name)}" width="120" height="120" loading="lazy" decoding="async">
                </a>
                <div class="cart-item__copy">
                  <span class="product-badge">${DJ.escapeHtml(badgeLabel(product.category))}</span>
                  <h2><a href="${DJ.escapeHtml(DJ.productPageUrl(product))}">${DJ.escapeHtml(product.name)}</a></h2>
                  <p>${DJ.escapeHtml(DJ.displayPrice(product))} each &middot; ${available} available</p>
                  <div class="cart-item__actions">
                    <label>Quantity
                      <input data-cart-quantity type="number" min="1" max="${available}" value="${quantity}" inputmode="numeric">
                    </label>
                    <button type="button" class="button-secondary" data-cart-move-wishlist>Move to Wishlist</button>
                    <button type="button" class="button-secondary" data-cart-remove>Remove</button>
                  </div>
                </div>
                <strong class="cart-item__subtotal">${DJ.escapeHtml(DJ.currency((DJ.payablePrice(product) || 0) * quantity))}</strong>
              </article>
            `;
          }).join('')}
        </div>
        <aside class="cart-summary panel">
          <span class="kicker">Cart Summary</span>
          <h2>${itemCount} item${itemCount === 1 ? '' : 's'}</h2>
          <div class="cart-summary__row"><span>Merchandise subtotal</span><strong>${DJ.escapeHtml(DJ.currency(subtotal))}</strong></div>
          <p>Shipping and any applicable taxes are calculated securely in Stripe Checkout.</p>
          <button type="button" class="button" data-cart-checkout data-checkout-button>Checkout Cart</button>
          <a class="button-secondary" href="${DJ.escapeHtml(buildCollectorInquiryUrl('bundle', activeItems.map(({ product }) => product)))}" data-cart-bundle>Build a Bundle</a>
          <a class="button-secondary" href="wishlist.html">Open Wishlist</a>
          <button type="button" class="button-secondary" data-cart-clear>Clear Cart</button>
          <p class="cart-status" id="cartStatus" aria-live="polite"></p>
        </aside>
      </div>
    `;

    // The cart rerenders whenever quantities change, so keep one delegated
    // handler pair on the container instead of rebinding every rendered control.
    const getCartProductId = (target) => Number(target.closest('[data-cart-product-id]')?.dataset.cartProductId);
    container.onchange = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.matches('[data-cart-quantity]')) return;
      DJ.updateCartQuantity(getCartProductId(target), target.value);
    };
    container.onclick = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const removeButton = target.closest('[data-cart-remove]');
      if (removeButton) {
        DJ.removeFromCart(getCartProductId(removeButton));
        return;
      }

      const wishlistButton = target.closest('[data-cart-move-wishlist]');
      if (wishlistButton) {
        const productId = getCartProductId(wishlistButton);
        const wishlist = DJ.getWishlist();
        if (!wishlist.includes(productId)) DJ.setWishlist([...wishlist, productId]);
        DJ.removeFromCart(productId);
        return;
      }

      if (target.closest('[data-cart-clear]')) {
        if (window.confirm('Clear all items from your shopping cart?')) DJ.clearCart();
        return;
      }

      if (target.closest('[data-cart-bundle]')) {
        DJ.trackEvent?.('bundle_open', { kind: 'cart' });
        return;
      }

      if (target.closest('[data-cart-checkout]')) checkoutCart(allProducts);
    };
    DJ.applyLazyLoading(container);
  }

  // ---------------------------------------------------------------------------
  // Product details modal
  // ---------------------------------------------------------------------------

  function normalizeModalContextProducts(products = []) {
    return (Array.isArray(products) ? products : [])
      .filter((product) => product && Number.isFinite(Number(product.id)));
  }

  function getModalNavigationState(product = {}, contextProducts = activeModalContextProducts) {
    const productId = Number(product?.id ?? activeModalProductId);
    const sequence = normalizeModalContextProducts(contextProducts);
    const currentIndex = sequence.findIndex((item) => Number(item.id) === productId);

    if (!sequence.length || currentIndex < 0) {
      return {
        currentIndex: -1,
        total: sequence.length,
        previousProduct: null,
        nextProduct: null
      };
    }

    return {
      currentIndex,
      total: sequence.length,
      previousProduct: currentIndex > 0 ? sequence[currentIndex - 1] : null,
      nextProduct: currentIndex < sequence.length - 1 ? sequence[currentIndex + 1] : null
    };
  }

  function renderModalListingNav(product = {}) {
    const state = getModalNavigationState(product);
    if (state.total < 2 || state.currentIndex < 0) return '';

    const previousLabel = state.previousProduct
      ? `Previous listing: ${state.previousProduct.name}`
      : 'This is the first visible listing';
    const nextLabel = state.nextProduct
      ? `Next listing: ${state.nextProduct.name}`
      : 'This is the last visible listing';

    return `
      <nav class="modal-listing-nav" aria-label="Browse visible listings">
        <button type="button" class="modal-listing-nav__button" data-modal-nav="prev" aria-label="${DJ.escapeHtml(previousLabel)}" title="${DJ.escapeHtml(previousLabel)}"${state.previousProduct ? '' : ' disabled'}>
          <span aria-hidden="true">&lsaquo;</span>
        </button>
        <span class="modal-listing-nav__status">${state.currentIndex + 1} of ${state.total} matching listings</span>
        <button type="button" class="modal-listing-nav__button" data-modal-nav="next" aria-label="${DJ.escapeHtml(nextLabel)}" title="${DJ.escapeHtml(nextLabel)}"${state.nextProduct ? '' : ' disabled'}>
          <span aria-hidden="true">&rsaquo;</span>
        </button>
      </nav>
    `;
  }

  function navigateModalListing(direction = 1) {
    const state = getModalNavigationState({ id: activeModalProductId });
    const target = direction < 0 ? state.previousProduct : state.nextProduct;
    if (!target) return false;

    openModal(target, {
      contextProducts: activeModalContextProducts,
      focusSelector: `[data-modal-nav="${direction < 0 ? 'prev' : 'next'}"]`,
      preserveFocusOrigin: true
    });
    return true;
  }

  function openModal(product, options = {}) {
    const modal = document.getElementById('productModal');
    const modalInner = document.getElementById('modalInner');
    if (!modal || !modalInner) return;
    const slabStatsRequestId = ++modalSlabStatsRequestId;
    DJ.trackEvent?.('product_open', { productId: Number(product.id), category: product.category });
    if (!options.preserveUrl) {
      replaceProductUrl(product);
    }

    const wasModalActive = modal.classList.contains('active');
    if (!wasModalActive && !options.preserveFocusOrigin) {
      DJ.setLastFocusedElement(document.activeElement);
    }
    const contextProducts = normalizeModalContextProducts(options.contextProducts);
    if (contextProducts.length) {
      activeModalContextProducts = contextProducts;
    } else if (!activeModalContextProducts.some((item) => Number(item.id) === Number(product.id))) {
      activeModalContextProducts = normalizeModalContextProducts([product]);
    }
    activeModalProductId = Number(product.id);
    DJ.seo?.upsertProductStructuredData?.(product);

    const gallery = Array.isArray(product.imageGallery) && product.imageGallery.length
      ? product.imageGallery
      : [product.image];
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const galleryCount = gallery.filter(Boolean).length || 1;
    const wishlistIds = new Set(DJ.getWishlist().map(Number));
    const modalMainImageCandidates = DJ.getAssetUrlCandidates(gallery[0]);
    const modalMainPreviewCandidates = DJ.getThumbnailAssetCandidates(gallery[0]);
    const modalMainImageSource = modalMainPreviewCandidates[0]
      || modalMainImageCandidates[0]
      || DJ.safeAssetUrl(gallery[0]);
    const displayPrice = DJ.displayPrice(product);
    const modalActionLabel = getProductActionLabel(product, 'modal');
    const isDirectCheckout = isDirectCheckoutCandidate(product);
    const availableQuantity = DJ.availableQuantity(product);
    const modalThumbs = gallery.map((image, index) => ({
      image,
      index,
      thumbnailCandidates: DJ.getThumbnailAssetCandidates(image),
      fullSizeCandidates: DJ.getAssetUrlCandidates(image)
    }));

    modalInner.innerHTML = `
      <div class="modal-layout">
        <div class="modal-media">
          <button type="button" class="modal-image-stage modal-image-zoom" id="modalImageStage" aria-label="${DJ.escapeHtml(`Open full size image${galleryCount > 1 ? ` 1 of ${galleryCount}` : ''} for ${product.name}`)}">
            <img id="modalMainImage" src="${DJ.escapeHtml(modalMainImageSource)}" data-asset-candidates="${DJ.escapeHtml(modalMainPreviewCandidates.join('\n'))}" data-full-size-src="${DJ.escapeHtml(modalMainImageCandidates[0] || DJ.safeAssetUrl(gallery[0]))}" data-full-size-candidates="${DJ.escapeHtml(modalMainImageCandidates.join('\n'))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(buildProductImageAlt(product, { context: 'modal', photoIndex: 1, photoCount: galleryCount }))}" decoding="async" fetchpriority="high">
            <span class="modal-image-zoom__hint" aria-hidden="true">View full size</span>
          </button>
          ${gallery.length > 1 ? `
            <div class="modal-thumbs" aria-label="Additional item photos">
              ${modalThumbs.map(({ image, index, thumbnailCandidates, fullSizeCandidates }) => `
                <button type="button" class="modal-thumb${index === 0 ? ' active' : ''}" data-gallery-index="${index}" data-gallery-preview-src="${DJ.escapeHtml(thumbnailCandidates[0] || fullSizeCandidates[0] || DJ.safeAssetUrl(image))}" data-gallery-preview-candidates="${DJ.escapeHtml(thumbnailCandidates.join('\n'))}" data-gallery-src="${DJ.escapeHtml(fullSizeCandidates[0] || DJ.safeAssetUrl(image))}" data-gallery-candidates="${DJ.escapeHtml(fullSizeCandidates.join('\n'))}" aria-label="View photo ${index + 1}" aria-current="${index === 0 ? 'true' : 'false'}">
                  <img src="${DJ.escapeHtml((thumbnailCandidates[0] || DJ.safeAssetUrl(image)))}" data-asset-candidates="${DJ.escapeHtml(thumbnailCandidates.join('\n'))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(buildProductImageAlt(product, { context: 'thumb', photoIndex: index + 1, photoCount: galleryCount }))}" loading="lazy" decoding="async" fetchpriority="low">
                </button>
              `).join('')}
            </div>
          ` : ''}
          ${isNbaSlabStatsCandidate(product) ? `
            <section class="nba-slab-stats" id="nbaSlabStatsPanel" aria-label="NBA player statistics for this product" aria-busy="true">
              <p class="slab-stats-loading" role="status">Matching this card to verified NBA statistics&hellip;</p>
            </section>
          ` : ''}
        </div>
        <div class="modal-copy">
          <span class="product-badge">${DJ.escapeHtml(badgeLabel(product.category))}</span>
          <h3 id="modalTitle">${DJ.escapeHtml(product.name)}</h3>
          ${renderModalListingNav(product)}
          ${renderModalFactStrip(product, galleryCount, displayPrice)}
          ${renderModalMetaGrid(product)}
          ${renderAttributeTags(product.attributes, { className: 'modal-attribute-list' })}
          ${product.description ? `<div class="modal-description"><strong>Description</strong><p>${DJ.escapeHtml(product.description)}</p></div>` : ''}
          ${product.photoHostPageUrl ? `<p><strong>Hosted photos:</strong> <a class="product-host-link" href="${DJ.escapeHtml(product.photoHostPageUrl)}" target="_blank" rel="noopener noreferrer">Open photo host page</a></p>` : ''}
          ${isDirectCheckout ? `
            <div class="modal-quantity-row">
              <label for="modalQuantity">Quantity</label>
              <input id="modalQuantity" type="number" min="1" max="${availableQuantity}" value="1" inputmode="numeric">
              <span>${DJ.escapeHtml(`${availableQuantity} available`)}</span>
            </div>
          ` : ''}
          <div class="inline-actions">
            <button type="button" class="modal-cta${isDirectCheckout ? '' : ' modal-cta--inquiry'}" id="modalBuy" data-checkout-button>${DJ.escapeHtml(modalActionLabel)}</button>
            ${isDirectCheckout ? '<button type="button" class="button-secondary" id="modalAddCart">Add to Cart</button>' : ''}
            <button type="button" class="button-secondary" id="modalWishlist" data-product-id="${Number(product.id)}" aria-pressed="${wishlistIds.has(Number(product.id)) ? 'true' : 'false'}" aria-label="${wishlistIds.has(Number(product.id)) ? 'Remove from wishlist' : 'Save to wishlist'}">${wishlistIds.has(Number(product.id)) ? 'Remove from Wishlist' : 'Save to Wishlist'}</button>
            <button type="button" class="button-secondary" id="modalOffer">Make an Offer</button>
            <button type="button" class="button-secondary modal-link-button" id="modalCopyLink">Copy Link</button>
          </div>
          <p class="modal-checkout-status" id="modalCheckoutStatus" aria-live="polite"></p>
          <p class="modal-trust-links">
            <a href="policies.html">Condition &amp; authenticity notes</a>
            <span aria-hidden="true">|</span>
            <a href="sell-trade-want-list.html">Sell, trade, or send a want list</a>
          </p>
        </div>
      </div>
    `;
    modal.removeAttribute('aria-label');
    modal.setAttribute('aria-labelledby', 'modalTitle');

    const modalImageStage = modalInner.querySelector('#modalImageStage');
    const modalMainImage = modalInner.querySelector('#modalMainImage');
    let activeGalleryIndex = 0;

    const getModalImagePreviewLabel = () => (
      `Open full size image${galleryCount > 1 ? ` ${activeGalleryIndex + 1} of ${galleryCount}` : ''} for ${product.name}`
    );
    const openModalImagePreview = () => {
      if (!modalMainImage) return;
      const src = modalMainImage.dataset.fullSizeSrc
        || modalMainImage.currentSrc
        || modalMainImage.getAttribute('src')
        || modalMainImage.dataset.originalSrc
        || '';
      if (!src) return;
      const caption = `${product.name}${galleryCount > 1 ? ` - photo ${activeGalleryIndex + 1} of ${galleryCount}` : ''}`;
      DJ.openImageLightbox({
        src,
        alt: modalMainImage.alt || caption,
        caption,
        trigger: modalImageStage || modalMainImage,
        candidates: modalMainImage.dataset.fullSizeCandidates || src,
        fallbackSrc: fallback
      });
    };

    modalImageStage?.addEventListener('click', openModalImagePreview);
    modalInner.querySelectorAll('.modal-thumb').forEach((button) => {
      button.addEventListener('click', () => {
        activeGalleryIndex = Number(button.dataset.galleryIndex || 0);
        const nextImage = button.dataset.galleryPreviewSrc || button.dataset.gallerySrc;
        if (modalMainImage && nextImage) {
          const nextCandidates = button.dataset.galleryPreviewCandidates
            || button.dataset.galleryCandidates
            || nextImage;
          modalMainImage.dataset.originalSrc = nextImage;
          modalMainImage.dataset.assetRetrySources = '';
          modalMainImage.dataset.assetCandidates = nextCandidates;
          modalMainImage.dataset.fullSizeSrc = button.dataset.gallerySrc || nextImage;
          modalMainImage.dataset.fullSizeCandidates = button.dataset.galleryCandidates || modalMainImage.dataset.fullSizeSrc;
          modalMainImage.src = nextImage;
          const thumbImage = button.querySelector('img');
          if (thumbImage?.alt) {
            modalMainImage.alt = thumbImage.alt.replace(/,\s*photo\s+\d+(?:\s+of\s+\d+)?$/i, ', full-size product photo');
          }
        }
        modalImageStage?.setAttribute('aria-label', getModalImagePreviewLabel());
        modalInner.querySelectorAll('.modal-thumb').forEach((thumb) => thumb.classList.remove('active'));
        modalInner.querySelectorAll('.modal-thumb').forEach((thumb) => thumb.setAttribute('aria-current', 'false'));
        button.classList.add('active');
        button.setAttribute('aria-current', 'true');
      });
    });

    modalInner.querySelector('#modalBuy')?.addEventListener('click', () => {
      const quantity = Math.max(1, Number(modalInner.querySelector('#modalQuantity')?.value) || 1);
      buyNow(product, { quantity });
    });
    modalInner.querySelector('#modalAddCart')?.addEventListener('click', () => {
      const quantity = Math.max(1, Number(modalInner.querySelector('#modalQuantity')?.value) || 1);
      addToCart(product, quantity);
    });
    modalInner.querySelector('#modalCopyLink')?.addEventListener('click', () => copyProductLink(product));
    modalInner.querySelector('#modalOffer')?.addEventListener('click', () => {
      DJ.trackEvent?.('offer_open', { productId: Number(product.id), category: product.category });
      window.location.assign(`offer.html?item=${encodeURIComponent(String(product.id))}`);
    });
    modalInner.querySelectorAll('[data-modal-nav]').forEach((button) => {
      button.addEventListener('click', () => {
        navigateModalListing(button.dataset.modalNav === 'prev' ? -1 : 1);
      });
    });
    modalInner.querySelector('#modalWishlist')?.addEventListener('click', () => {
      toggleWishlist(product.id);
      closeModal();
    });

    DJ.applyLazyLoading(modalInner);
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    modal.removeAttribute('inert');
    document.body.style.overflow = 'hidden';
    if (isNbaSlabStatsCandidate(product)) {
      hydrateNbaSlabStatsPanel(product, slabStatsRequestId);
    }
    requestAnimationFrame(() => {
      const preferredFocus = options.focusSelector ? modal.querySelector(options.focusSelector) : null;
      const fallbackFocus = modal.querySelector('.modal-listing-nav__button:not([disabled])')
        || modal.querySelector('.modal-close');
      const focusTarget = preferredFocus instanceof HTMLElement && !preferredFocus.disabled
        ? preferredFocus
        : fallbackFocus;
      focusTarget?.focus();
    });
  }

  function closeModal() {
    const modal = document.getElementById('productModal');
    if (!modal) return;

    modalSlabStatsRequestId += 1;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('inert', '');
    modal.removeAttribute('aria-labelledby');
    modal.setAttribute('aria-label', 'Product details');
    document.body.style.overflow = '';
    activeModalProductId = null;
    DJ.seo?.removeProductStructuredData?.();
    replaceProductUrl(null);
    DJ.restoreFocus();
  }

  function trapProductModalFocus(event) {
    const modal = document.getElementById('productModal');
    if (!modal || !modal.classList.contains('active')) {
      return false;
    }

    if (event.key === 'Escape' && !document.body.classList.contains('image-lightbox-open')) {
      closeModal();
      return true;
    }

    if (event.key !== 'Tab') {
      const isArrowNavigation = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
      const activeElement = document.activeElement;
      const isTypingField = activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName);

      if (isArrowNavigation && !isTypingField && !document.body.classList.contains('image-lightbox-open')) {
        const didNavigate = navigateModalListing(event.key === 'ArrowLeft' ? -1 : 1);
        if (didNavigate) {
          event.preventDefault();
          return true;
        }
      }

      return false;
    }

    const focusableElements = [...modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)].filter((element) => (
      element instanceof HTMLElement
      && !element.hasAttribute('hidden')
      && !element.closest('[hidden]')
      && element.getClientRects().length > 0
    ));

    if (!focusableElements.length) {
      event.preventDefault();
      modal.querySelector('.modal-close')?.focus();
      return true;
    }

    // Product detail sheets are modal dialogs, so keyboard focus should loop
    // inside the sheet until the shopper closes it.
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstFocusable) {
      event.preventDefault();
      lastFocusable.focus();
      return true;
    }

    if (!event.shiftKey && document.activeElement === lastFocusable) {
      event.preventDefault();
      firstFocusable.focus();
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Cross-page navigation helpers inserted into catalog heroes
  // ---------------------------------------------------------------------------

  function insertDepartmentSwitcher() {
    const page = document.body.dataset.page;
    const heroCard = document.querySelector('.page-hero-card');
    if (!heroCard || heroCard.querySelector('.catalog-switcher')) return;

    const shopLinks = [
      ['sports-cards.html', 'Sports Cards'],
      ['comics.html', 'Comics'],
      ['collectibles.html', 'Collectibles']
    ];
    const sportsLinks = [
      ['sports-cards.html', 'All Sports'],
      ['baseball-cards.html', 'Baseball'],
      ['basketball-cards.html', 'Basketball'],
      ['football-cards.html', 'Football']
    ];
    const switchers = {
      'shop-hub': shopLinks,
      'sports-hub': sportsLinks,
      'baseball-cards': sportsLinks,
      'basketball-cards': sportsLinks,
      'football-cards': sportsLinks,
      comics: shopLinks,
      collectibles: shopLinks,
      wishlist: [
        ...shopLinks,
        ['wishlist.html', 'Wishlist']
      ]
    };

    const links = switchers[page];
    if (!links || !links.length) return;

    const currentHref = {
      'shop-hub': 'shop.html',
      'sports-hub': 'sports-cards.html',
      wishlist: 'wishlist.html'
    }[page] || `${page}.html`;
    const nav = document.createElement('nav');
    nav.className = 'catalog-switcher';
    nav.setAttribute('aria-label', 'Browse departments');
    nav.innerHTML = links.map(([href, label]) => `
      <a href="${href}"${href === currentHref ? ' class="active" aria-current="page"' : ''}>${label}</a>
    `).join('');

    const utilityRow = heroCard.querySelector('.utility-row');
    if (utilityRow) utilityRow.insertAdjacentElement('afterend', nav);
    else heroCard.appendChild(nav);
  }

  async function renderFeaturedProducts() {
    const featuredProductsWrap = document.getElementById('featuredProducts');
    if (!featuredProductsWrap) return;

    renderProductGridLoadingState(featuredProductsWrap, { count: 6 });

    const sourceProducts = (Array.isArray(window.DJ_HOME_FEATURED_PRODUCTS)
      ? normalizeProducts(window.DJ_HOME_FEATURED_PRODUCTS)
      : null) || await loadProducts({ source: 'products-featured.json' });
    let featuredProducts = selectBalancedFeaturedProducts(sourceProducts);
    const featuredCategories = new Set(featuredProducts.map((product) => product.category));
    if (featuredProducts.length < 6 || featuredCategories.size < 5) {
      const fullCatalogProducts = await loadProducts({ source: DEFAULT_PRODUCT_SOURCE });
      featuredProducts = selectBalancedFeaturedProducts(sourceProducts, fullCatalogProducts);
    }
    const wishlistIds = new Set(DJ.getWishlist().map(Number));

    clearProductGridLoadingState(featuredProductsWrap);
    const priorityCardCount = getPriorityProductCardCount();
    featuredProductsWrap.innerHTML = featuredProducts
      .map((product, index) => renderProductCard(product, wishlistIds, {
        imagePriority: index < Math.min(4, priorityCardCount) ? 'high' : 'low'
      }))
      .join('');
    attachGridHandlers(featuredProductsWrap, featuredProducts);
    DJ.updateWishlistCount();
    DJ.applyLazyLoading(featuredProductsWrap);
  }

  function selectBalancedFeaturedProducts(primaryProducts = [], fallbackProducts = []) {
    const pools = [primaryProducts, fallbackProducts]
      .filter(Array.isArray)
      .map((products) => products.filter(Boolean));
    const usedIds = new Set();
    const takeFromCategory = (category, count) => {
      const picked = [];
      pools.forEach((products) => {
        products.forEach((product) => {
          if (picked.length >= count) return;
          if (usedIds.has(Number(product.id)) || product.category !== category) return;
          usedIds.add(Number(product.id));
          picked.push(product);
        });
      });
      return picked;
    };

    const balanced = [
      ...takeFromCategory('Baseball', 2),
      ...takeFromCategory('Basketball', 1),
      ...takeFromCategory('Football', 1),
      ...takeFromCategory('Comics', 1),
      ...takeFromCategory('Collectibles', 1)
    ];
    const djPick = pools.flat().find((product) => !usedIds.has(Number(product.id)));
    if (djPick) balanced.push(djPick);
    return balanced.slice(0, 7);
  }

  // Kick off only the features that are relevant to the current page template.
  async function bootCatalog() {
    if (document.body.dataset.catalogBooted === 'true') return;
    document.body.dataset.catalogBooted = 'true';
    const page = document.body.dataset.page;
    bindWishlistStateSync();
    bindCartStateSync();
    hydrateCustomerAccountAfterPaint();

    if (['home', 'shop-hub', 'sports-hub', 'baseball-cards', 'basketball-cards', 'football-cards', 'comics', 'collectibles', 'wishlist', 'cart'].includes(page)) {
      DJ.scheduleIdle(() => insertDepartmentSwitcher());
    }

    if (page === 'home') {
      await renderFeaturedProducts();
    }

    await setupCatalogPage();

    if (page === 'wishlist') {
      await renderWishlistPage();
    }

    if (page === 'cart') {
      await renderCartPage();
    }

    const modal = document.getElementById('productModal');
    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.classList.contains('modal-close')) closeModal();
      });
    }

    document.addEventListener('keydown', (event) => {
      trapProductModalFocus(event);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootCatalog, { once: true });
  } else {
    bootCatalog();
  }

  window.closeModal = closeModal;
  DJ.ensureCustomerAccountBridge = ensureCustomerAccountBridge;
})();


