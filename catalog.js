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

  // Per-page configuration keeps page-specific copy, locked categories, and
  // filter labeling in one place instead of scattering those differences across
  // the rendering logic below.
  const PAGE_CONFIG = {
    shop: {
      allowedCategories: null,
      emptyTitle: 'No items matched your filters',
      emptyCopy: 'Try widening the year or price range, or clear a few filters and search again.',
      searchLabel: 'Search inventory',
      searchPlaceholder: 'Player, title, team, publisher, or keyword',
      helperText: 'Examples: Jordan rookie, All-Star, PSA, Marvel, Giants.'
    },
    'sports-cards': {
      allowedCategories: ['Baseball', 'Basketball', 'Football'],
      emptyTitle: 'No sports cards matched your filters',
      emptyCopy: 'Try a broader search, widen the year or price range, or reset a filter.',
      searchLabel: 'Search sports cards',
      searchPlaceholder: 'Player, set, team, slab, parallel, or keyword',
      helperText: 'Examples: Jordan rookie, Brady auto, Topps Chrome, PSA 9, All-Star.'
    },
    'sports-hub': {
      allowedCategories: ['Baseball', 'Basketball', 'Football'],
      emptyTitle: 'No sports cards matched your filters',
      emptyCopy: 'Try a broader player search, widen the year or price range, or reset a filter.',
      searchLabel: 'Search all sports cards',
      searchPlaceholder: 'Player, set, team, slab, parallel, or keyword',
      helperText: 'Examples: Jordan rookie, Brady auto, Topps Chrome, PSA 9, All-Star.'
    },
    comics: {
      allowedCategories: ['Comics'],
      emptyTitle: 'No comics matched your filters',
      emptyCopy: 'Try a broader title search, widen the year range, or clear a filter to see more comics.',
      searchLabel: 'Search comics',
      searchPlaceholder: 'Title, character, issue number, publisher, or keyword',
      helperText: 'Examples: Spider-Man, Batman, #1, Venom, newsstand, key issue.'
    },
    collectibles: {
      allowedCategories: ['Collectibles', 'Other'],
      emptyTitle: 'No collectibles are listed yet',
      emptyCopy: 'Try a broader keyword search, or check back as more memorabilia is added.',
      searchLabel: 'Search collectibles',
      searchPlaceholder: 'Autograph, jersey, display, signed, memorabilia, or keyword',
      helperText: 'Examples: signed ball, jersey, autograph, display piece, photo.'
    },
    'baseball-cards': {
      allowedCategories: ['Baseball'],
      emptyTitle: 'No baseball cards matched your filters',
      emptyCopy: 'Try a broader player search, widen the year range, or clear a filter to see more baseball inventory.',
      searchLabel: 'Search baseball cards',
      searchPlaceholder: 'Player, set, team, slab, parallel, or keyword',
      helperText: 'Examples: Mays, Mantle, rookie, Topps, PSA 5, autograph.'
    },
    'basketball-cards': {
      allowedCategories: ['Basketball'],
      emptyTitle: 'No basketball cards matched your filters',
      emptyCopy: 'Try a broader player search, widen the year range, or clear a filter to see more basketball inventory.',
      searchLabel: 'Search basketball cards',
      searchPlaceholder: 'Player, set, team, slab, refractor, or keyword',
      helperText: 'Examples: Jordan, Kobe, rookie, auto, refractor, PSA 10.'
    },
    'football-cards': {
      allowedCategories: ['Football'],
      emptyTitle: 'No football cards matched your filters',
      emptyCopy: 'Try a broader player search, widen the year range, or clear a filter to see more football inventory.',
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
    'sports-cards': 'products-sports.json',
    'baseball-cards': 'products-baseball.json',
    'basketball-cards': 'products-basketball.json',
    'football-cards': 'products-football.json',
    comics: 'products-comics.json',
    collectibles: 'products-collectibles.json',
    wishlist: 'products.json'
  };

  const DEFAULT_PRODUCT_SOURCE = 'products.json';
  const staticProductCache = new Map();
  const normalizedSourceCache = new Map();
  const catalogPageCache = new Map();
  const filteredCatalogResultsCache = new Map();
  const FILTERED_RESULTS_CACHE_LIMIT = 18;
  const gridProductLookups = new WeakMap();
  const DEFAULT_RENDER_BATCH_SIZE = 24;
  const DESKTOP_FILTER_BREAKPOINT = 900;
  const FILTER_SIDEBAR_VISIBILITY_KEY = 'catalogSidebarVisible';
  const SIDEBAR_DEFAULT_OPEN_PAGES = new Set([
    'sports-cards',
    'baseball-cards',
    'basketball-cards',
    'football-cards',
    'comics',
    'collectibles',
    'wishlist'
  ]);
  const PAGE_RENDER_BATCH_SIZES = {
    wishlist: 18,
    collectibles: 20,
    comics: 24,
    'sports-hub': 24,
    'sports-cards': 24,
    'baseball-cards': 24,
    'basketball-cards': 24,
    'football-cards': 24
  };
  const DEFAULT_CATALOG_ITEMS_PER_PAGE = 72;
  const CATALOG_ITEMS_PER_PAGE_OPTIONS = [24, 48, 72];

  let debounceTimer = 0;
  let updateMobileFilterState = null;
  let currentCatalogPage = 1;
  let currentCatalogItemsPerPage = DEFAULT_CATALOG_ITEMS_PER_PAGE;
  let wishlistPageRefreshTimer = 0;

  const FILTER_ATTRIBUTE_OPTIONS = ['Autograph', 'Serial Numbered', 'Memorabilia', 'Rookie'];
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
    const ungradedCondition = raw.toLowerCase() === 'near mint or better'
      ? defaultUngradedCondition
      : (raw || defaultUngradedCondition);
    const companyMatch = raw.match(/\b(PSA\/DNA|PSA|BGS|BVG|BCCG|SGC|CGC|CSG|HGA|GMA|ISA|BECKETT)\b/i);

    if (companyMatch) {
      const company = companyMatch[1].toUpperCase() === 'BECKETT' ? 'Beckett' : companyMatch[1].toUpperCase();
      let grade = raw.slice((companyMatch.index || 0) + companyMatch[0].length).trim();
      grade = grade.replace(/^[\s:\u2013\u2014-]+/, '').trim();
      if (!grade) grade = 'Authenticated';

      // Authenticated-only cards are certified, but not numerically graded.
      // Keep their exact condition visible while leaving them in the Ungraded facet.
      const hasNumericGrade = /(?:^|\s)(?:10|9\.5|9|8\.5|8|7\.5|7|6\.5|6|5\.5|5|4\.5|4|3\.5|3|2\.5|2|1\.5|1)(?:\s|$)/i.test(grade);
      const authenticatedOnly = /authentic|authenticated|certified/i.test(raw) && !hasNumericGrade;
      if (authenticatedOnly) {
        return { raw, status: 'Ungraded', company, grade, summary: `Ungraded | ${raw}`, compact: raw };
      }

      return { raw, status: 'Graded', company, grade, summary: `Graded | ${company} ${grade}`.trim(), compact: `${company} ${grade}`.trim() };
    }

    return { raw, status: 'Ungraded', company: '', grade: '', summary: `Ungraded | ${ungradedCondition}`, compact: ungradedCondition };
  }

  function hasSerialNumberedSignal(item = {}, excelFields = {}, includesFeature = () => false) {
    // Serial-number checks intentionally avoid generated description text.
    // Descriptions can inherit old workbook mistakes, while the title carries
    // the reliable numbering context buyers actually see.
    const titleText = [
      item.name || '',
      excelFields['Title'] || '',
      item.condition || '',
      item.legacyImageLabel || ''
    ].join(' ').toLowerCase();
    const explicitSerialText = /\bserial[- ](?:ly[- ])?numbered\b|\bnumbered\s+(?:to|\/)\s*\d+\b|\blimited\s+to\s+\d+\b|\bone\s+of\s+one\b|\b1\s*of\s*1\b|\b1\/1\b/.test(titleText);
    if (explicitSerialText) return true;

    const hasYearSerialContext = (value = '') => /\b(?:gold|silver|bronze|blue|red|green|purple|orange|pink|black|aqua|yellow|fuchsia|lime|cyan|white|tie-dye|rainbow|platinum|foil|border|parallel|refractor|prizm|holo|shimmer|wave|lava|pulsar|speckle|mojo|ice|glitter|chrome|optic|choice|cosmic|sapphire|x-?fractor|the finals|playoff ticket|premium stock|masterpieces|limited|numbered|serial|short print|sp)\b/.test(value);
    const hasSlashSerial = titleText.split(/\s+\+\s+/).some((segment) => {
      const matches = segment.matchAll(/\/\s*(\d{1,4})\b/g);
      for (const match of matches) {
        const denominator = Number(match[1]);
        const after = segment.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 30);
        if (/^\s*(?:cards?|pcs?|boxes?|packs?)\b/.test(after)) continue;
        const before = segment.slice(Math.max(0, (match.index || 0) - 90), match.index || 0);
        if (denominator >= 1900 && denominator <= 2035 && !hasYearSerialContext(before)) continue;
        return true;
      }
      return false;
    });
    if (hasSlashSerial) return true;

    // Preserve curated Serial Numbered tags unless the title has the known
    // false-positive pattern: a second card/set introduced as a year.
    return includesFeature('serial numbered') && !/\+\s*\/\s*(?:19|20)\d{2}\b/.test(titleText);
  }

  function deriveProductAttributes(item = {}) {
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
    const excelFields = metadata.excelFields && typeof metadata.excelFields === 'object' ? metadata.excelFields : {};
    const autographedValue = String(excelFields['C:Autographed'] || '').trim().toLowerCase();
    const featuresText = String(excelFields['C:Features'] || '').toLowerCase();
    const featureSet = new Set(featuresText.split('|').map((value) => value.trim()).filter(Boolean));
    const text = [
      item.name || '',
      item.description || '',
      item.condition || '',
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
    const includesFeature = (feature) => featureSet.has(String(feature || '').trim());
    const hasAutographLanguage = (
      /\bauto(?:s|graph(?:ed|s)?|graphed|s)?\b|\bau\b|\bsigned\b|\bsignatures\b|\bpsa\/dna certified authentic\b|\b(?:sticker|on-card|hard-signed)\s+auto\b/.test(text)
      || /\bsignature\s+(?:series|shots|marks|materials|patch|jersey|memorabilia|autographs?)\b/.test(text)
    );
    const hasMemorabiliaLanguage = (
      /\bmemorabilia\b|\brelics?\b|\bjerseys?\b|\bjsy\b|\bpatch(?:es)?\b|\bswatches?\b|\bfabric\b|\bmaterials?\b|\bgame[- ](?:used|worn)\b|\bplayer[- ]worn\b|\bclubhouse collection\b/.test(text)
      || /\b(?:black gold|throwback|rookie team|team)\s+threads\b|\bhot numbers game used\b|\bauthentic fabric\b|\bfabric of the future\b/.test(text)
    );

    if (/\brookies?\b|\brc\b|\brookie related\b|\brated rookie\b|\bpre[- ]rookie\b/.test(text)) attributes.push('Rookie');
    if (hasAutographLanguage || autographedValue === 'yes') attributes.push('Autograph');
    if (hasSerialNumberedSignal(item, excelFields, includesFeature)) attributes.push('Serial Numbered');
    if (hasMemorabiliaLanguage) attributes.push('Memorabilia');
    return attributes;
  }

  function renderAttributeTags(attributes = [], options = {}) {
    if (!Array.isArray(attributes) || !attributes.length) return '';
    const className = options.className || 'product-attribute-list';
    return `<div class="${DJ.escapeHtml(className)}">${attributes.map((attribute) => `<span class="product-attribute-pill">${DJ.escapeHtml(attribute)}</span>`).join('')}</div>`;
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

      return raw.split(/([-'\/])/).map((segment) => {
        if (!segment || /^[-'\/]$/.test(segment)) return segment;
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

  function getProductCardContextValue(product = {}) {
    const normalizedCategory = String(product.category || '').trim().toLowerCase();
    const normalizedTeam = normalizeTeamFacetValue(product.team, product);
    if (normalizedTeam) {
      return normalizedTeam;
    }

    const sourceValue = String(product.sourcePage || '').trim();
    const normalizedSource = sourceValue.toLowerCase();
    if (sourceValue && normalizedSource !== normalizedCategory && normalizedSource !== 'current catalog' && normalizedSource !== 'other') {
      return sourceValue;
    }

    return '';
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

  function renderProductCardSummary(product, summaryId, metaLine = '') {
    const pills = [];
    const yearLabel = product.yearLabel && product.yearLabel !== 'Year not listed' ? product.yearLabel : '';
    const contextValue = getProductCardContextValue(product);

    if (yearLabel) {
      pills.push(`<span class="product-meta-pill product-meta-pill--year">${DJ.escapeHtml(yearLabel)}</span>`);
    }

    if (contextValue) {
      pills.push(`<span class="product-meta-pill product-meta-pill--context" title="${DJ.escapeHtml(contextValue)}">${DJ.escapeHtml(contextValue)}</span>`);
    }

    if (!pills.length) {
      return `
        <div class="product-card-summary" id="${summaryId}">
          <span class="sr-only">${DJ.escapeHtml(metaLine || product.category || 'Catalog listing')}</span>
        </div>
      `;
    }

    return `
      <div class="product-card-summary" id="${summaryId}">
        <div class="product-meta-pills">
          ${pills.join('')}
        </div>
      </div>
    `;
  }

  function renderProductCardFlags(product) {
    const flags = [];
    const galleryCount = Array.isArray(product.imageGallery)
      ? product.imageGallery.filter(Boolean).length
      : (product.image ? 1 : 0);
    const copyCount = Number(product.copyCount);

    if (galleryCount > 1) {
      flags.push(`<span class="product-media-flag">${galleryCount} photos</span>`);
    }

    if (Number.isFinite(copyCount) && copyCount > 1) {
      flags.push(`<span class="product-media-flag">${copyCount} copies</span>`);
    }

    return flags.length
      ? `<div class="product-media-flags" aria-hidden="true">${flags.join('')}</div>`
      : '';
  }

  function renderProductCardMetaExtras(product = {}) {
    const details = [];
    const athlete = String(product.playerAthlete || '').trim();

    if (athlete && !String(product.name || '').toLowerCase().includes(athlete.toLowerCase())) {
      details.push(`<span class="product-meta-inline product-meta-inline--athlete">${DJ.escapeHtml(formatDisplayName(athlete))}</span>`);
    }

    return `
      ${details.length ? `<div class="product-meta-inline-list">${details.join('')}</div>` : ''}
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
    return Array.from(document.querySelectorAll(`input[name=\"${name}\"]:checked`)).map((input) => input.value);
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

    const halfWindow = Math.floor(maxVisible / 2);
    const start = Math.max(1, Math.min(page - halfWindow, totalPages - maxVisible + 1));
    return Array.from({ length: maxVisible }, (_, index) => start + index);
  }

  function createFacetCountMap(products, resolver) {
    const countMap = new Map();

    (Array.isArray(products) ? products : []).forEach((product) => {
      const rawValues = typeof resolver === 'function' ? resolver(product) : product?.[resolver];
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];

      values
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .forEach((value) => {
          countMap.set(value, (countMap.get(value) || 0) + 1);
        });
    });

    return countMap;
  }

  /**
   * Build the catalog facet counts in a single pass so large category pages do
   * not repeatedly traverse the same product list just to populate filters.
   */
  function buildFacetSummary(products = []) {
    const conditionCounts = new Map();
    const attributeCounts = new Map();
    const teamCounts = new Map();

    (Array.isArray(products) ? products : []).forEach((product) => {
      const condition = String(product?.conditionFacet || '').trim();
      if (condition) {
        conditionCounts.set(condition, (conditionCounts.get(condition) || 0) + 1);
      }

      const team = String(product?._teamFacet || '').trim();
      if (team) {
        teamCounts.set(team, (teamCounts.get(team) || 0) + 1);
      }

      const attributes = Array.isArray(product?.attributes) ? product.attributes : [];
      attributes
        .map((attribute) => String(attribute || '').trim())
        .filter(Boolean)
        .forEach((attribute) => {
          attributeCounts.set(attribute, (attributeCounts.get(attribute) || 0) + 1);
        });
    });

    return {
      conditionCounts,
      attributeCounts,
      teamCounts,
      availableAttributes: FILTER_ATTRIBUTE_OPTIONS.filter((attribute) => attributeCounts.has(attribute)),
      teamValues: [...teamCounts.keys()].sort((left, right) => TEXT_COLLATOR.compare(left, right))
    };
  }

  function toCountedFacetOptions(values = [], countMap = new Map(), selectedValues = []) {
    const selected = new Set(selectedValues);

    return (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .map((value) => ({ value, count: countMap.get(value) || 0, selected: selected.has(value) }))
      .sort((left, right) => {
        if (left.selected !== right.selected) return left.selected ? -1 : 1;
        if (left.count !== right.count) return right.count - left.count;
        return TEXT_COLLATOR.compare(left.value, right.value);
      });
  }

  function getSortLabel(value = 'nameAsc') {
    const labels = {
      nameAsc: 'Name A to Z',
      nameDesc: 'Name Z to A',
      priceAsc: 'Price low to high',
      priceDesc: 'Price high to low',
      yearAsc: 'Oldest first',
      yearDesc: 'Newest first'
    };

    return labels[value] || value;
  }

  function getSortOptionValues() {
    return ['nameAsc', 'nameDesc', 'priceAsc', 'priceDesc', 'yearAsc', 'yearDesc'];
  }

  function syncToolbarSortControl(value = 'nameAsc') {
    const toolbarSort = document.getElementById('toolbarSortSelect');
    if (toolbarSort && toolbarSort.value !== value) {
      toolbarSort.value = value;
    }
  }

  function normalizeSearchString(value = '') {
    let normalized = String(value || '')
      .toLowerCase()
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

  function getFacetOptions(products, key, options = {}) {
    const values = products
      .map((product) => product[key])
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    const unique = [...new Set(values)];
    return options.sort === false ? unique : unique.sort((left, right) => TEXT_COLLATOR.compare(left, right));
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
      const team = normalizeTeamFacetValue(item.team, { ...item, category });
      const rawCondition = item.condition || '';
      const conditionInfo = parseConditionDetails(rawCondition);
      const description = item.description || '';
      const searchableDescription = description.replace(/\s+/g, ' ').trim().slice(0, 280);
      const sport = item.sport || (category === 'Collectibles' ? 'Other' : category);
      const league = item.league || '';
      const playerAthlete = item.playerAthlete || '';
      const photoHostPageUrl = typeof DJ.safeExternalUrl === 'function'
        ? DJ.safeExternalUrl(item.photoHostPageUrl)
        : '';
      const image = item.image || DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other;
      const attributes = deriveProductAttributes(item);

      return {
        ...item,
        category,
        price,
        year,
        yearLabel,
        team,
        rawCondition,
        condition: conditionInfo.summary,
        conditionFacet: conditionInfo.status,
        conditionCompany: conditionInfo.company,
        conditionGrade: conditionInfo.grade,
        conditionCompact: conditionInfo.compact,
        description,
        sport,
        league,
        playerAthlete,
        photoHostPageUrl,
        image,
        attributes,
        _price: DJ.numericPrice({ price }),
        _conditionLower: conditionInfo.status.toLowerCase(),
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
          conditionInfo.summary,
          attributes.join(' ')
        ].join(' ').toLowerCase()
      };
    });
  }

  function getProductSource(page = document.body.dataset.page || '') {
    return PRODUCT_SOURCE_BY_PAGE[page] || DEFAULT_PRODUCT_SOURCE;
  }

  async function getCatalogPageProducts(config = {}) {
    const source = getProductSource();
    const allowedKey = Array.isArray(config.allowedCategories) && config.allowedCategories.length
      ? config.allowedCategories.join('|')
      : 'all';
    const cacheKey = `${source}::${allowedKey}`;

    if (catalogPageCache.has(cacheKey)) {
      return catalogPageCache.get(cacheKey);
    }

    const allProducts = await loadProducts({ source });
    const allowedProducts = config.allowedCategories && config.allowedCategories.length
      ? allProducts.filter((product) => config.allowedCategories.includes(product.category))
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
      const productAssetUrl = typeof DJ.versionedProductAsset === 'function'
        ? DJ.versionedProductAsset(source)
        : source;
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

  function getPreloadedProductsForSource(source) {
    return typeof DJ.getPreloadedProductsForSource === 'function'
      ? DJ.getPreloadedProductsForSource(source)
      : null;
  }

  async function loadPreloadedProductsForSource(source) {
    return typeof DJ.loadPreloadedProductsForSource === 'function'
      ? DJ.loadPreloadedProductsForSource(source)
      : null;
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

  async function getBestAvailableSourceResult(source) {
    const preloaded = getPreloadedProductsForSource(source);
    if (preloaded) {
      return { products: preloaded, origin: 'preloaded' };
    }

    if (window.location.protocol === 'file:') {
      const localBundleProducts = await loadPreloadedProductsForSource(source).catch(() => null);
      if (localBundleProducts) {
        return { products: localBundleProducts, origin: 'preloaded-bundle' };
      }
    }

    if (DJ.remoteCatalog?.isConfigured()) {
      const remote = await withTimeout(
        DJ.remoteCatalog.listProducts({
          source,
          featuredOnly: source === 'products-featured.json'
        }),
        5500,
        'Remote catalog'
      );

      if (Array.isArray(remote)) {
        return { products: remote, origin: 'remote' };
      }
    }

    return {
      products: await fetchStaticProducts(source),
      origin: 'static'
    };
  }

  function shouldApplyBrowserCatalogMutations(origin) {
    return origin !== 'remote';
  }

  /**
   * Keep the stored wishlist aligned with the currently available catalog.
   * This prevents deleted or backend-removed listings from inflating badge counts
   * on pages outside the dedicated wishlist view.
   */
  function reconcileWishlistIds(products, options = {}) {
    const shouldPersist = options.persist !== false;
    const validIds = new Set((Array.isArray(products) ? products : []).map((product) => Number(product.id)).filter(Number.isFinite));
    const currentWishlist = DJ.getWishlist();
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
        const mergedProducts = shouldApplyBrowserCatalogMutations(origin)
          ? DJ.applyStoredCatalogMutations(sourceProducts, { includeCustomProducts: true })
          : sourceProducts;
        const normalizedProducts = normalizeProducts(mergedProducts);
        catalogPageCache.clear();
        filteredCatalogResultsCache.clear();

        if (source === DEFAULT_PRODUCT_SOURCE) {
          reconcileWishlistIds(normalizedProducts, { persist: true });
        }

        return normalizedProducts;
      } catch (error) {
        const preloadedFallback = getPreloadedProductsForSource(source)
          || await loadPreloadedProductsForSource(source).catch(() => null);
        const fallbackProducts = preloadedFallback || await fetchStaticProducts(source).catch(() => []);

        if (fallbackProducts.length) {
          console.warn(`Using static fallback products for ${source} after the preferred catalog source failed.`, error);
        } else {
          console.error(`Failed to load products from ${source}:`, error);
        }

        const mergedFallback = DJ.applyStoredCatalogMutations(fallbackProducts, { includeCustomProducts: true });
        const normalizedFallback = normalizeProducts(mergedFallback);
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

  function renderProductCard(product, wishlistIds) {
    const isWishlisted = wishlistIds.has(Number(product.id));
    const heart = isWishlisted ? '\u2665' : '\u2661';
    const metaLine = [product.yearLabel || product.year || '', product.team || '']
      .filter(Boolean)
      .map((part) => DJ.escapeHtml(part))
      .join(' | ');
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const summaryId = `product-card-summary-${product.id}`;
    const displayPrice = DJ.displayPrice(product);
    const priceLabel = /contact/i.test(displayPrice) ? 'Availability' : 'Price';
    const pricingClass = /contact/i.test(displayPrice) ? 'product-pricing product-pricing--inquiry' : 'product-pricing';
    const cardImageAlt = buildProductImageAlt(product, { context: 'card' });
    const cardImageCandidates = DJ.getThumbnailAssetCandidates(product.image);
    const cardImageSource = cardImageCandidates[0] || DJ.safeAssetUrl(product.image);

    return `
      <article class="product-card" data-product-id="${product.id}" data-product-category="${DJ.escapeHtml(product.category)}" role="button" tabindex="0" aria-label="View details for ${DJ.escapeHtml(product.name)}" aria-describedby="${summaryId}" aria-haspopup="dialog">
        <button type="button" class="wishlist-button product-card-wishlist${isWishlisted ? ' filled' : ''}" aria-label="${isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}" title="${isWishlisted ? 'Remove from wishlist' : 'Add to wishlist'}">${heart}</button>
        <div class="product-media">
          ${renderProductCardFlags(product)}
          <img src="${DJ.escapeHtml(cardImageSource)}" data-asset-candidates="${DJ.escapeHtml(cardImageCandidates.join('\n'))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(cardImageAlt)}" title="${DJ.escapeHtml(cardImageAlt)}" loading="lazy" decoding="async" fetchpriority="low">
        </div>
        <div class="product-content">
          <h4>${DJ.escapeHtml(product.name)}</h4>
          <div class="product-card-chip-rail">
            <div class="product-topline">
              <span class="product-meta product-grade-meta">${DJ.escapeHtml(product.conditionCompact)}</span>
            </div>
            ${renderProductCardSummary(product, summaryId, metaLine)}
            ${renderProductCardMetaExtras(product)}
            ${renderAttributeTags(product.attributes)}
          </div>
          <div class="product-card-footer">
            <div class="${pricingClass}">
              <span class="product-price-label">${DJ.escapeHtml(priceLabel)}</span>
              <div class="product-price">${DJ.escapeHtml(displayPrice)}</div>
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

  function setCatalogLoadingState(message = 'Loading inventory...') {
    const resultsCount = document.getElementById('resultsCount');
    const resultsSummary = document.getElementById('resultsSummary');
    const resultsLive = document.getElementById('resultsLive');
    const activeFiltersWrap = document.getElementById('activeFilters');

    if (resultsCount) resultsCount.textContent = 'Loading...';
    if (resultsSummary) resultsSummary.textContent = message;
    if (resultsLive) resultsLive.textContent = message;
    if (activeFiltersWrap) activeFiltersWrap.innerHTML = '';
  }

  function buyNow(product) {
    const currentPageUrl = window.location.href.split('#')[0];
    const subject = encodeURIComponent(`Purchase Inquiry: ${product.name}`);
    const body = encodeURIComponent(
      `Hello DJ,

I'm interested in "${product.name}" (${product.yearLabel || product.year || 'Year not listed'}, ${product.condition || 'Condition not listed'}) listed for ${DJ.displayPrice(product)}.

Listing ID: ${product.id || 'Not listed'}
Page: ${document.title}
URL: ${currentPageUrl}

Please let me know if it is still available.

Thank you.`
    );
    window.location.href = `mailto:contact@djshouseofcards-comics.com?subject=${subject}&body=${body}`;
  }

  function toggleWishlist(productId) {
    const wishlist = DJ.getWishlist();
    const index = wishlist.indexOf(productId);

    if (index > -1) wishlist.splice(index, 1);
    else wishlist.push(productId);

    DJ.setWishlist(wishlist);
    refreshWishlistButtons();
  }

  function refreshWishlistButtons(scope = document, wishlistIds = new Set(DJ.getWishlist().map(Number))) {
    scope.querySelectorAll('.product-card').forEach((card) => {
      const productId = Number(card.dataset.productId);
      const button = card.querySelector('.wishlist-button');
      if (!button) return;

      const isWishlisted = wishlistIds.has(productId);
      button.classList.toggle('filled', isWishlisted);
      button.textContent = isWishlisted ? '\u2665' : '\u2661';
      button.setAttribute('aria-label', isWishlisted ? 'Remove from wishlist' : 'Add to wishlist');
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
    modalWishlistButton.textContent = isWishlisted ? 'Remove from Wishlist' : 'Save to Wishlist';
    modalWishlistButton.setAttribute('aria-label', isWishlisted ? 'Remove from wishlist' : 'Save to wishlist');
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

      if (document.body.dataset.page === 'wishlist' && event.detail?.source !== 'local') {
        scheduleWishlistPageRefresh();
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
    gridProductLookups.set(container, createProductLookup(products));

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

      const productCard = event.target.closest('.product-card');
      if (!productCard) return;

      const productId = Number(productCard.dataset.productId);
      const product = gridProductLookups.get(container)?.get(productId);
      if (!product) return;

      if (event.target.closest('.wishlist-button')) {
        toggleWishlist(productId);
        if (document.body.dataset.page === 'wishlist') renderWishlistPage();
        return;
      }

      openModal(product);
    };

    if (container.dataset.cardKeyboardBound === 'true') return;
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
      openModal(product);
    });
  }

  function filterLabel(label, value) {
    return `${label}: ${value}`;
  }

  // ---------------------------------------------------------------------------
  // Results summary and active-filter UI
  // ---------------------------------------------------------------------------

  function renderActiveFilters(filters, config = {}) {
    const activeFilters = [];
    const teamLabel = getTeamFacetLabel(config);
    const addFilter = (key, label, value, tone = 'default') => {
      activeFilters.push({ key, label, value, tone });
    };

    if (filters.filterText) addFilter('filterText', 'Search', `"${filters.filterText}"`, 'search');
    filters.conditions.forEach((value) => addFilter(`condition::${encodeURIComponent(value)}`, 'Condition', value, 'facet'));
    filters.attributes.forEach((value) => addFilter(`attribute::${encodeURIComponent(value)}`, 'Attribute', value, 'facet'));
    filters.teams.forEach((value) => addFilter(`team::${encodeURIComponent(value)}`, teamLabel, value, 'facet'));
    if (filters.yearMin != null) addFilter('yearMin', 'Year from', filters.yearMin, 'range');
    if (filters.yearMax != null) addFilter('yearMax', 'Year to', filters.yearMax, 'range');
    if (filters.priceMin != null) addFilter('priceMin', 'Min price', DJ.currency(filters.priceMin), 'range');
    if (filters.priceMax != null) addFilter('priceMax', 'Max price', DJ.currency(filters.priceMax), 'range');
    if (filters.sort && filters.sort !== 'nameAsc') {
      addFilter('sort', 'Sort', getSortLabel(filters.sort), 'sort');
    }

    return activeFilters;
  }

  function updateResultsMeta(filters, count, config = {}, renderState = {}) {
    const resultsSummary = document.getElementById('resultsSummary');
    const activeFiltersWrap = document.getElementById('activeFilters');
    const resultsLive = document.getElementById('resultsLive');
    if (!resultsSummary && !activeFiltersWrap && !resultsLive) return;

    const activeFilters = renderActiveFilters(filters, config);
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

    if (resultsSummary) resultsSummary.textContent = longSummary;
    if (resultsLive) resultsLive.textContent = longSummary;

    if (activeFiltersWrap) {
      activeFiltersWrap.innerHTML = activeFilters.map((item) => `
        <button type="button" class="filter-chip filter-chip--removable" data-clear-filter="${DJ.escapeHtml(item.key)}" aria-label="Clear ${DJ.escapeHtml(item.label)} filter">
          <span>${DJ.escapeHtml(filterLabel(item.label, item.value))}</span>
          <span class="filter-chip-x" aria-hidden="true">&times;</span>
        </button>
      `).join('');
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
      sort: document.getElementById('sortSelect')?.value || document.getElementById('toolbarSortSelect')?.value || 'nameAsc',
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
    if (filters.sort && filters.sort !== 'nameAsc') url.searchParams.set('sort', filters.sort);
    if (filters.page && filters.page > 1) url.searchParams.set('page', String(filters.page));
    if (filters.perPage && filters.perPage !== DEFAULT_CATALOG_ITEMS_PER_PAGE) url.searchParams.set('perPage', String(filters.perPage));

    const nextSearch = url.searchParams.toString();
    const currentSearch = window.location.search.replace(/^\?/, '');
    if (nextSearch !== currentSearch) {
      const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }
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
      sort: params.get('sort') || 'nameAsc'
    };

    currentCatalogPage = sanitizeCatalogPage(params.get('page'));
    currentCatalogItemsPerPage = sanitizeItemsPerPage(params.get('perPage'));

    const allowedSorts = new Set(['nameAsc', 'nameDesc', 'priceAsc', 'priceDesc', 'yearAsc', 'yearDesc']);
    if (!allowedSorts.has(initial.sort)) {
      initial.sort = 'nameAsc';
    }

    const valueMap = {
      searchInput: initial.filterText,
      yearMin: initial.yearMin,
      yearMax: initial.yearMax,
      priceMin: initial.priceMin,
      priceMax: initial.priceMax,
      sortSelect: initial.sort
    };

    Object.entries(valueMap).forEach(([id, value]) => {
      if (value == null || value === '') return;
      const field = document.getElementById(id);
      if (field) field.value = value;
    });

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

    if (filterPanelTitle) filterPanelTitle.textContent = 'Filters';
    filterPanelDescription?.remove();
    removeCategoryField();
    if (searchLabel && config.searchLabel) searchLabel.textContent = config.searchLabel;
    if (searchInput && config.searchPlaceholder) searchInput.placeholder = config.searchPlaceholder;
    if (filterHelp && config.helperText) filterHelp.textContent = config.helperText;
    if (clearButton) clearButton.textContent = 'Reset all filters';
    if (sortSelect) {
      Array.from(sortSelect.options).forEach((option) => {
        option.textContent = getSortLabel(option.value);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Progressive enhancements for the filter UI
  // ---------------------------------------------------------------------------

  function decorateSearchField(config = {}) {
    const searchInput = document.getElementById('searchInput');
    if (!searchInput) return;
    const fieldGroup = searchInput.closest('.field-group');
    const filterHelp = document.getElementById('filterHelp');

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

    if (!fieldGroup) return;

    let suggestions = fieldGroup.querySelector('.search-suggestions');
    suggestions?.remove();
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
          ${getSortOptionValues().map((value) => `<option value="${DJ.escapeHtml(value)}">${DJ.escapeHtml(getSortLabel(value))}</option>`).join('')}
        </select>
      `;

      const toolbarSelect = sortControl.querySelector('#toolbarSortSelect');
      const primarySort = document.getElementById('sortSelect');
      if (toolbarSelect && primarySort) {
        toolbarSelect.value = primarySort.value || 'nameAsc';
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
        searchLabel?.classList.add('sr-only');
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
    return `
      <button
        type="button"
        class="catalog-pagination__page${isActive ? ' is-active' : ''}"
        data-pagination-page="${pageNumber}"
        ${isActive ? 'aria-current="page"' : ''}
      >${pageNumber}</button>
    `;
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
          ${state.page <= 1 ? 'disabled' : ''}
        >&lsaquo;</button>
        <div class="catalog-pagination__pages" aria-label="Pages">
          ${pageNumbers.map((pageNumber) => renderPaginationButton(pageNumber, state)).join('')}
        </div>
        <button
          type="button"
          class="catalog-pagination__arrow"
          data-pagination-action="next"
          aria-label="Next page"
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
      pagination.hidden = !shouldShowPagination;
      pagination.innerHTML = shouldShowPagination ? renderPaginationMarkup(state, placement) : '';
    });
  }

  function scrollCatalogToResults() {
    const target = document.getElementById('resultsToolbar') || document.getElementById('productContainer');
    if (!target) return;

    const headerOffset = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 96;
    const top = Math.max(0, target.getBoundingClientRect().top + window.scrollY - headerOffset - 16);
    const behavior = window.DJ && typeof window.DJ.getScrollBehavior === 'function'
      ? window.DJ.getScrollBehavior()
      : 'smooth';
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
    } catch (error) {
      return null;
    }
  }

  function writeStoredSidebarVisibility(isVisible) {
    try {
      localStorage.setItem(FILTER_SIDEBAR_VISIBILITY_KEY, isVisible ? 'visible' : 'hidden');
    } catch (error) {
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
      filterPanel.setAttribute('aria-hidden', String(collapseSidebar));

      if ('inert' in filterPanel) {
        filterPanel.inert = collapseSidebar;
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

  function removeRetiredCatalogEnhancements() {
    const filterPanel = document.querySelector('.filter-panel');
    const heroCard = document.querySelector('.page-hero-card');

    filterPanel?.querySelector('.filter-panel-quick-picks')?.remove();
    filterPanel?.querySelector('.filter-panel-insights')?.remove();

    if (heroCard) {
      heroCard.classList.add('catalog-hero-card--streamlined');
      heroCard.querySelector('.catalog-hero-insight-grid')?.remove();
      heroCard.querySelector('.catalog-hero-support')?.remove();
      heroCard.querySelector('.catalog-hero-summary')?.remove();
      heroCard.querySelector('.catalog-hero-actions')?.remove();
    }
  }

  function insertCatalogSupportCallout(config = {}) {
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

  function debounce(callback, delay = 90) {
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => callback(), delay);
  }

  /**
   * Cache filtered/sorted result sets by filter signature so pagination and
   * per-page changes can reuse the expensive work from the previous render.
   */
  function buildCatalogResultsCacheKey(filters = {}, config = {}) {
    return JSON.stringify({
      page: document.body.dataset.page || '',
      allowedCategories: Array.isArray(config.allowedCategories) ? [...config.allowedCategories].sort() : null,
      filterText: normalizeSearchString(filters.filterText || ''),
      conditions: [...(filters.conditions || [])].sort(),
      attributes: [...(filters.attributes || [])].sort(),
      teams: [...(filters.teams || [])].sort(),
      yearMin: filters.yearMin ?? null,
      yearMax: filters.yearMax ?? null,
      priceMin: filters.priceMin ?? null,
      priceMax: filters.priceMax ?? null,
      sort: filters.sort || 'nameAsc'
    });
  }

  function getCatalogSortComparator(sort = 'nameAsc') {
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
    const cacheKey = buildCatalogResultsCacheKey(filters, config);
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
      if (filters.yearMin != null && product.year < filters.yearMin) continue;
      if (filters.yearMax != null && product.year > filters.yearMax) continue;
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
   * Render a category page once, then keep filtering in-memory. This keeps the UI
   * responsive because filter changes do not require additional network requests.
   */
  async function renderCatalogPage(config = {}) {
    const productContainer = document.getElementById('productContainer');
    if (!productContainer) return;

    const { allowedProducts } = await getCatalogPageProducts(config);

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

    if (!filteredProducts.length) {
      const emptyTitle = config.emptyTitle || document.body.dataset.emptyTitle || 'No items matched your filters';
      const emptyCopy = config.emptyCopy || document.body.dataset.emptyCopy || 'Try widening the year or price range, or clear a few filters and search again.';
      clearProductGridLoadingState(productContainer);
      productContainer.innerHTML = `
        <div class="empty-state">
          <h3>${DJ.escapeHtml(emptyTitle)}</h3>
          <p>${DJ.escapeHtml(emptyCopy)}</p>
        </div>
      `;
      DJ.applyLazyLoading(productContainer);
      return;
    }

    const wishlistIds = new Set(DJ.getWishlist().map(Number));
    clearProductGridLoadingState(productContainer);
    productContainer.innerHTML = visibleProducts.map((product) => renderProductCard(product, wishlistIds)).join('');
    attachGridHandlers(productContainer, visibleProducts);
    DJ.updateWishlistCount();
    DJ.applyLazyLoading(productContainer);
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

      if (filterKey === 'sort') field.value = 'nameAsc';
      else field.value = '';

      if (filterKey === 'filterText') field.focus();
    }

    currentCatalogPage = 1;
    renderCatalogPage(config);
  }

  function bindActiveFilterActions(config) {
    const activeFiltersWrap = document.getElementById('activeFilters');
    if (!activeFiltersWrap || activeFiltersWrap.dataset.bound === 'true') return;

    activeFiltersWrap.dataset.bound = 'true';
    activeFiltersWrap.addEventListener('click', (event) => {
      const button = event.target.closest('[data-clear-filter]');
      if (!button) return;
      clearSpecificFilter(button.dataset.clearFilter, config);
    });
  }

  function setupResponsiveMobileUX(config) {
    setupMobileFilterDrawer(config);
    setupScrollableMobileRails();
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
    const isMobileDrawerViewport = () => mobileDrawerQuery ? mobileDrawerQuery.matches : window.innerWidth <= MOBILE_BREAKPOINT;
    let drawerFocusTimer = 0;

    filterPanel.dataset.mobileDrawerBound = 'true';
    filterPanel.id = filterPanel.id || 'catalogFiltersPanel';

    const panelFooter = document.createElement('div');
    panelFooter.className = 'mobile-filter-actions';
    panelFooter.innerHTML = `
      <button type="button" class="button-secondary mobile-filter-reset">Reset all</button>
      <button type="button" class="button mobile-filter-done">Done</button>
    `;

    filterPanel.append(panelFooter);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'mobile-filter-trigger';
    trigger.setAttribute('aria-controls', filterPanel.id);
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
      <span class="mobile-filter-trigger__copy">
        <span class="mobile-filter-trigger__title">Filters</span>
        <span class="mobile-filter-trigger__meta">All items</span>
      </span>
      <span class="mobile-filter-trigger__icon" aria-hidden="true">&#9776;</span>
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
    };

    updateMobileFilterState = syncTrigger;

    const syncDrawerAccessibility = () => {
      const isMobileViewport = isMobileDrawerViewport();
      const isDrawerOpen = document.body.classList.contains('filters-open');

      trigger.hidden = !isMobileViewport;
      overlay.hidden = !isMobileViewport || !isDrawerOpen;

      if (!isMobileViewport) {
        trigger.setAttribute('aria-expanded', 'false');
        filterPanel.setAttribute('aria-hidden', 'false');
        if ('inert' in filterPanel) {
          filterPanel.inert = false;
        }
        document.body.classList.remove('filters-open');
        return;
      }

      filterPanel.setAttribute('aria-hidden', String(!isDrawerOpen));
      if ('inert' in filterPanel) {
        filterPanel.inert = !isDrawerOpen;
      }
      trigger.setAttribute('aria-expanded', String(isDrawerOpen));
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
        filterPanel.querySelector('input, select, textarea, button:not(.filter-panel-dismiss)')?.focus();
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

    if (!DJ.bindMediaQueryChange(mobileDrawerQuery, handleViewportChange)) {
      DJ.addSharedResizeListener(handleViewportChange, { runImmediately: false });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && document.body.classList.contains('filters-open')) {
        closeDrawer();
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
      if (event.target.matches('input[type=\"checkbox\"], select')) syncTrigger();
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
    setCatalogLoadingState('Loading live inventory...');

    const initialFilters = applyUrlFilters();

    // Build the visual shell before the network request completes so the page
    // never flashes the old top-stacked filter layout during slow backend loads.
    enhanceFilterCopy(config);
    ensureCatalogBrowseLayout();
    removeRetiredCatalogEnhancements();
    decorateSearchField(config);
    addToolbarActions();
    ensureCatalogPaginationControls();
    setupFilterSidebarToggle();
    insertCatalogSupportCallout(config);
    bindCatalogPagination(config);
    setupSearchShortcuts();
    setupResponsiveMobileUX(config);

    const { allowedProducts } = await getCatalogPageProducts(config);

    mountFacetFilters(allowedProducts, config, initialFilters);
    bindActiveFilterActions(config);

    const rerender = () => {
      currentCatalogPage = 1;
      return renderCatalogPage(config);
    };
    const filterPanel = document.querySelector('.filter-panel');

    if (filterPanel && filterPanel.dataset.catalogBindings !== 'true') {
      filterPanel.dataset.catalogBindings = 'true';

      filterPanel.addEventListener('input', (event) => {
        if (event.target.matches('#searchInput, #yearMin, #yearMax, #priceMin, #priceMax')) {
          debounce(rerender);
        }
      });

      filterPanel.addEventListener('change', (event) => {
        if (event.target.matches('input[type=\"checkbox\"], select')) {
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
      clearButton.addEventListener('click', async () => {
        ['searchInput', 'yearMin', 'yearMax', 'priceMin', 'priceMax'].forEach((id) => {
          const field = document.getElementById(id);
          if (field) field.value = '';
        });

        document.querySelectorAll('input[name=\"condition\"], input[name=\"attribute\"], input[name=\"team\"]').forEach((input) => {
          input.checked = false;
        });

        const sortField = document.getElementById('sortSelect');
        if (sortField) sortField.value = 'nameAsc';

        document.querySelectorAll('.facet-group.is-expanded').forEach((group) => group.classList.remove('is-expanded'));
        document.querySelectorAll('.facet-toggle').forEach((toggle) => {
          toggle.setAttribute('aria-expanded', 'false');
          toggle.textContent = 'Show more';
        });

        currentCatalogPage = 1;
        await renderCatalogPage(config);
        document.getElementById('searchInput')?.focus();
      });
    }

    await renderCatalogPage(config);
  }

  async function renderWishlistPage() {
    const wishlistContainer = document.getElementById('wishlistContainer');
    if (!wishlistContainer) return;
    const wishlistPageCount = document.getElementById('wishlistPageCount');
    const storedWishlist = DJ.getWishlist().map(Number);

    if (wishlistPageCount) {
      wishlistPageCount.textContent = `${storedWishlist.length} saved item${storedWishlist.length === 1 ? '' : 's'}`;
    }

    if (!storedWishlist.length) {
      wishlistContainer.innerHTML = `
        <div class="empty-state">
          <h3>Your wishlist is empty</h3>
          <p>Tap the heart icon on any listing to save it here for later.</p>
          <div class="inline-actions">
            <a class="button" href="sports-cards.html">Browse Sports Cards</a>
          </div>
        </div>
      `;
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

    let wishlistProducts = [];
    let loadedWishlistFromRemote = false;

    if (DJ.remoteCatalog?.isConfigured()) {
      try {
        const remoteWishlistProducts = await DJ.remoteCatalog.listProducts({
          source: DEFAULT_PRODUCT_SOURCE,
          ids: storedWishlist
        });
        wishlistProducts = normalizeProducts(remoteWishlistProducts);
        loadedWishlistFromRemote = true;
      } catch (error) {
        console.error('Failed to load wishlist products from Supabase:', error);
      }
    }

    if (!loadedWishlistFromRemote) {
      const allProducts = await loadProducts({ source: DEFAULT_PRODUCT_SOURCE });
      const wishlistIdSet = new Set(storedWishlist);
      wishlistProducts = allProducts.filter((product) => wishlistIdSet.has(Number(product.id)));
    }

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
      wishlistContainer.innerHTML = `
        <div class="empty-state">
          <h3>Your wishlist is empty</h3>
          <p>Tap the heart icon on any listing to save it here for later.</p>
          <div class="inline-actions">
            <a class="button" href="sports-cards.html">Browse Sports Cards</a>
          </div>
        </div>
      `;
      DJ.applyLazyLoading(wishlistContainer);
      return;
    }

    clearProductGridLoadingState(wishlistContainer);
    wishlistContainer.innerHTML = wishlistProducts.map((product) => renderProductCard(product, wishlistIds)).join('');
    attachGridHandlers(wishlistContainer, wishlistProducts);
    DJ.updateWishlistCount();
    DJ.applyLazyLoading(wishlistContainer);
  }

  // ---------------------------------------------------------------------------
  // Product details modal
  // ---------------------------------------------------------------------------

  function openModal(product) {
    const modal = document.getElementById('productModal');
    const modalInner = document.getElementById('modalInner');
    if (!modal || !modalInner) return;

    DJ.setLastFocusedElement(document.activeElement);

    const gallery = Array.isArray(product.imageGallery) && product.imageGallery.length
      ? product.imageGallery
      : [product.image];
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const galleryCount = gallery.filter(Boolean).length || 1;
    const wishlistIds = new Set(DJ.getWishlist().map(Number));
    const modalMainImageSource = DJ.safeAssetUrl(gallery[0]);
    const modalThumbs = gallery.map((image, index) => ({
      image,
      index,
      candidates: DJ.getThumbnailAssetCandidates(image)
    }));

    modalInner.innerHTML = `
      <div class="modal-layout">
        <div class="modal-media">
          <div class="modal-image-stage" id="modalImageStage">
            <img id="modalMainImage" src="${DJ.escapeHtml(modalMainImageSource)}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(buildProductImageAlt(product, { context: 'modal', photoIndex: 1, photoCount: galleryCount }))}">
          </div>
          ${gallery.length > 1 ? `
            <div class="modal-thumbs" aria-label="Additional item photos">
              ${modalThumbs.map(({ image, index, candidates }) => `
                <button type="button" class="modal-thumb${index === 0 ? ' active' : ''}" data-gallery-src="${DJ.escapeHtml(DJ.safeAssetUrl(image))}" aria-label="View photo ${index + 1}">
                  <img src="${DJ.escapeHtml((candidates[0] || DJ.safeAssetUrl(image)))}" data-asset-candidates="${DJ.escapeHtml(candidates.join('\n'))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(buildProductImageAlt(product, { context: 'thumb', photoIndex: index + 1, photoCount: galleryCount }))}" loading="lazy" decoding="async" fetchpriority="low">
                </button>
              `).join('')}
            </div>
          ` : ''}
        </div>
        <div class="modal-copy">
          <span class="product-badge">${DJ.escapeHtml(badgeLabel(product.category))}</span>
          <h3 id="modalTitle">${DJ.escapeHtml(product.name)}</h3>
          <div class="modal-meta-grid">
            <p><strong>Year:</strong> ${DJ.escapeHtml(product.yearLabel || 'Year not listed')}</p>
            <p><strong>Team / Publisher:</strong> ${DJ.escapeHtml(product.team || product.category)}</p>
            <p><strong>Sport:</strong> ${DJ.escapeHtml(product.sport || product.category)}</p>
            ${product.league ? `<p><strong>League:</strong> ${DJ.escapeHtml(product.league)}</p>` : ''}
            <p><strong>Condition:</strong> ${DJ.escapeHtml(product.condition)}</p>
            <p><strong>Price:</strong> ${DJ.escapeHtml(DJ.displayPrice(product))}</p>
          </div>
          ${renderAttributeTags(product.attributes, { className: 'modal-attribute-list' })}
          ${product.description ? `<div class="modal-description"><strong>Description</strong><p>${DJ.escapeHtml(product.description)}</p></div>` : ''}
          <div class="modal-enhanced-card">
            <strong>Enhanced item details</strong>
            <ul class="modal-enhanced-list">
              <li><span>Grade status</span><span>${DJ.escapeHtml(product.conditionFacet)}</span></li>
              <li><span>Grade detail</span><span>${DJ.escapeHtml(product.conditionCompact)}</span></li>
              <li><span>Attributes</span><span>${DJ.escapeHtml(product.attributes.length ? product.attributes.join(', ') : 'Standard listing')}</span></li>
              <li><span>Source page</span><span>${DJ.escapeHtml(product.sourcePage || 'Current catalog')}</span></li>
            </ul>
          </div>
          ${product.photoHostPageUrl ? `<p><strong>Hosted photos:</strong> <a class="product-host-link" href="${DJ.escapeHtml(product.photoHostPageUrl)}" target="_blank" rel="noopener noreferrer">Open photo host page</a></p>` : ''}
          <div class="inline-actions">
            <button type="button" class="modal-cta" id="modalBuy">Buy Now</button>
            <button type="button" class="button-secondary" id="modalWishlist" data-product-id="${Number(product.id)}" aria-label="${wishlistIds.has(Number(product.id)) ? 'Remove from wishlist' : 'Save to wishlist'}">${wishlistIds.has(Number(product.id)) ? 'Remove from Wishlist' : 'Save to Wishlist'}</button>
          </div>
        </div>
      </div>
    `;

    const modalMainImage = modalInner.querySelector('#modalMainImage');
    modalInner.querySelectorAll('.modal-thumb').forEach((button) => {
      button.addEventListener('click', () => {
        const nextImage = button.dataset.gallerySrc;
        if (modalMainImage && nextImage) {
          modalMainImage.src = nextImage;
          const thumbImage = button.querySelector('img');
          if (thumbImage?.alt) {
            modalMainImage.alt = thumbImage.alt.replace(/,\s*photo\s+\d+(?:\s+of\s+\d+)?$/i, ', full-size product photo');
          }
        }
        modalInner.querySelectorAll('.modal-thumb').forEach((thumb) => thumb.classList.remove('active'));
        button.classList.add('active');
      });
    });

    modalInner.querySelector('#modalBuy')?.addEventListener('click', () => buyNow(product));
    modalInner.querySelector('#modalWishlist')?.addEventListener('click', async () => {
      toggleWishlist(product.id);
      if (document.body.dataset.page === 'wishlist') {
        await renderWishlistPage();
      }
      closeModal();
    });

    DJ.applyLazyLoading(modalInner);
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => modal.querySelector('.modal-close')?.focus());
  }

  function closeModal() {
    const modal = document.getElementById('productModal');
    if (!modal) return;

    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    DJ.restoreFocus();
  }

  // ---------------------------------------------------------------------------
  // Cross-page navigation helpers inserted into catalog heroes
  // ---------------------------------------------------------------------------

  function insertDepartmentSwitcher() {
    const page = document.body.dataset.page;
    const heroCard = document.querySelector('.page-hero-card');
    if (!heroCard || heroCard.querySelector('.catalog-switcher')) return;

    const switchers = {
      'shop-hub': [
        ['sports-cards.html', 'Sports Cards'],
        ['comics.html', 'Comics'],
        ['collectibles.html', 'Collectibles']
      ],
      'sports-hub': [
        ['sports-cards.html', 'All Sports'],
        ['baseball-cards.html', 'Baseball'],
        ['basketball-cards.html', 'Basketball'],
        ['football-cards.html', 'Football']
      ],
      'sports-cards': [
        ['sports-cards.html', 'All Sports'],
        ['baseball-cards.html', 'Baseball'],
        ['basketball-cards.html', 'Basketball'],
        ['football-cards.html', 'Football']
      ],
      'baseball-cards': [
        ['sports-cards.html', 'All Sports'],
        ['baseball-cards.html', 'Baseball'],
        ['basketball-cards.html', 'Basketball'],
        ['football-cards.html', 'Football']
      ],
      'basketball-cards': [
        ['sports-cards.html', 'All Sports'],
        ['baseball-cards.html', 'Baseball'],
        ['basketball-cards.html', 'Basketball'],
        ['football-cards.html', 'Football']
      ],
      'football-cards': [
        ['sports-cards.html', 'All Sports'],
        ['baseball-cards.html', 'Baseball'],
        ['basketball-cards.html', 'Basketball'],
        ['football-cards.html', 'Football']
      ],
      comics: [
        ['sports-cards.html', 'Sports Cards'],
        ['comics.html', 'Comics'],
        ['collectibles.html', 'Collectibles']
      ],
      collectibles: [
        ['sports-cards.html', 'Sports Cards'],
        ['comics.html', 'Comics'],
        ['collectibles.html', 'Collectibles']
      ],
      wishlist: [
        ['sports-cards.html', 'Sports Cards'],
        ['comics.html', 'Comics'],
        ['collectibles.html', 'Collectibles'],
        ['wishlist.html', 'Wishlist']
      ]
    };

    const links = switchers[page];
    if (!links || !links.length) return;

    const currentHrefMap = {
      'shop-hub': 'shop.html',
      'sports-hub': 'sports-cards.html',
      'sports-cards': 'sports-cards.html',
      'baseball-cards': 'baseball-cards.html',
      'basketball-cards': 'basketball-cards.html',
      'football-cards': 'football-cards.html',
      comics: 'comics.html',
      collectibles: 'collectibles.html',
      wishlist: 'wishlist.html'
    };

    const currentHref = currentHrefMap[page];
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

    renderProductGridLoadingState(featuredProductsWrap, { count: 4 });

    const sourceProducts = (Array.isArray(window.DJ_HOME_FEATURED_PRODUCTS)
      ? normalizeProducts(window.DJ_HOME_FEATURED_PRODUCTS)
      : null) || await loadProducts({ source: 'products-featured.json' });
    const featuredProducts = sourceProducts.slice(0, 4);
    const wishlistIds = new Set(DJ.getWishlist().map(Number));

    clearProductGridLoadingState(featuredProductsWrap);
    featuredProductsWrap.innerHTML = featuredProducts.map((product) => renderProductCard(product, wishlistIds)).join('');
    attachGridHandlers(featuredProductsWrap, featuredProducts);
    DJ.updateWishlistCount();
    DJ.applyLazyLoading(featuredProductsWrap);
  }

  // Kick off only the features that are relevant to the current page template.
  document.addEventListener('DOMContentLoaded', async () => {
    const page = document.body.dataset.page;
    bindWishlistStateSync();

    if (['home', 'shop-hub', 'sports-hub', 'sports-cards', 'baseball-cards', 'basketball-cards', 'football-cards', 'comics', 'collectibles', 'wishlist'].includes(page)) {
      DJ.scheduleIdle?.(() => insertDepartmentSwitcher());
    }

    if (page === 'home') {
      await renderFeaturedProducts();
    }

    await setupCatalogPage();

    if (page === 'wishlist') {
      await renderWishlistPage();
    }

    const modal = document.getElementById('productModal');
    if (modal) {
      modal.addEventListener('click', (event) => {
        if (event.target === modal || event.target.classList.contains('modal-close')) closeModal();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !document.body.classList.contains('image-lightbox-open')) closeModal();
    });
  });

  window.closeModal = closeModal;
})();
