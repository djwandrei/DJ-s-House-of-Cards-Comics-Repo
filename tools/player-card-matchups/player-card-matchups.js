// Catalog text only selects a bounded, user-approved RPC batch. It never
// becomes a visible player/card relationship by itself.
const CANDIDATE_BATCH_SIZE = 24;
const RESULT_PAGE_SIZE = 12;
const RPC_CONCURRENCY = 4;
const VERIFIED_REVIEW_STATES = new Set(['auto_verified', 'human_verified']);

/** Normalize search text without turning a title similarity into a mapping. */
function normalizeSearchText(value = '') {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function searchTokens(value = '') {
  return normalizeSearchText(value).split(' ').filter(Boolean);
}

/** A partial surname is fine, but every entered token must be present. */
function matchesSearch(playerName = '', query = '') {
  const name = normalizeSearchText(playerName);
  const tokens = searchTokens(query);
  return Boolean(name && tokens.length && tokens.every((token) => name.includes(token)));
}

function isNbaCatalogProduct(product = {}) {
  const category = normalizeSearchText(product.category);
  const league = normalizeSearchText(product.league);
  const sport = normalizeSearchText(product.sport);
  if (category !== 'basketball') return false;
  if (league && league !== 'nba') return false;
  if (sport && sport !== 'basketball') return false;
  if (product.isDeleted === true) return false;
  return !['hidden', 'archived', 'sold'].includes(normalizeSearchText(product.saleStatus));
}

function getStaticCatalogFallbackUrl(DJ = globalThis.window?.DJ || {}) {
  if (typeof DJ.versionedProductAsset === 'function') {
    return DJ.versionedProductAsset('products-basketball.json');
  }
  return '../../products-basketball.json';
}

function positiveLimit(value, fallback = Infinity) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const normalized = Math.floor(numeric);
  return normalized > 0 ? normalized : fallback;
}

/**
 * Use buyer-safe catalog text only to choose a small RPC work set. The text is
 * never displayed as a verified player relationship.
 */
function buildCandidateProducts(products = [], query = '', limit = Infinity) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = searchTokens(query);
  const max = positiveLimit(limit);
  if (!normalizedQuery || tokens.length === 0) return [];

  return products
    .filter(isNbaCatalogProduct)
    .map((product) => {
      const playerText = normalizeSearchText(product.playerAthlete);
      const titleText = normalizeSearchText(product.name);
      const combinedText = `${playerText} ${titleText}`.trim();
      if (!tokens.every((token) => combinedText.includes(token))) return null;

      let score = 1;
      if (playerText === normalizedQuery) score += 100;
      else if (playerText.includes(normalizedQuery)) score += 75;
      if (titleText.includes(normalizedQuery)) score += 35;
      if (playerText) score += 10;
      return { product, score };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.score - left.score
      || Number(right.product.year || 0) - Number(left.product.year || 0)
      || Number(left.product.id || 0) - Number(right.product.id || 0)
    ))
    .slice(0, max)
    .map(({ product }) => product);
}

function getCandidateBatch(candidates = [], checkedCount = 0, batchSize = CANDIDATE_BATCH_SIZE) {
  const start = Math.max(0, Math.min(candidates.length, Math.floor(Number(checkedCount) || 0)));
  const size = positiveLimit(batchSize, CANDIDATE_BATCH_SIZE);
  return candidates.slice(start, start + size);
}

/** Extract only RPC-confirmed players from one product payload. */
function extractVerifiedMatches(payload, product = {}, query = '') {
  if (!payload || typeof payload !== 'object' || payload.provider !== 'NBA') return [];
  const payloadProductId = Number(payload.productId);
  const productId = Number(product.id);
  if (!Number.isSafeInteger(productId) || payloadProductId !== productId) return [];
  if (!Array.isArray(payload.players)) return [];

  return payload.players
    .filter((entry) => (
      entry && typeof entry === 'object'
      && VERIFIED_REVIEW_STATES.has(String(entry.mapping?.reviewState || '').trim())
      && matchesSearch(entry.player?.name, query)
      && String(entry.player?.athleteId || '').trim()
    ))
    .map((entry) => ({
      product,
      mapping: entry.mapping || {},
      player: entry.player || {},
      seasons: Array.isArray(entry.seasons) ? entry.seasons : [],
      payload
    }));
}

function uniqueVerifiedMatches(matches = []) {
  const byProduct = new Map();
  matches.forEach((match) => {
    const productId = Number(match.product?.id);
    if (!Number.isSafeInteger(productId)) return;
    const existing = byProduct.get(productId);
    const currentName = normalizeSearchText(match.player?.name);
    const existingName = normalizeSearchText(existing?.player?.name);
    if (!existing || currentName.localeCompare(existingName) < 0) byProduct.set(productId, match);
  });
  return [...byProduct.values()]
    .filter((match) => Number.isSafeInteger(Number(match.product?.id)))
    .sort((left, right) => (
      Number(left.product?.sortRank || 0) - Number(right.product?.sortRank || 0)
      || Number(right.product?.year || 0) - Number(left.product?.year || 0)
      || Number(left.product?.id || 0) - Number(right.product?.id || 0)
    ));
}

function getResultWindow(matches = [], visibleLimit = RESULT_PAGE_SIZE) {
  const all = uniqueVerifiedMatches(matches);
  const limit = Math.min(all.length, positiveLimit(visibleLimit, RESULT_PAGE_SIZE));
  return {
    all,
    visible: all.slice(0, limit),
    total: all.length,
    remaining: Math.max(0, all.length - limit)
  };
}

function escapeText(value = '') {
  return String(value ?? '').trim();
}

function relativeAssetUrl(rawValue, DJ = {}) {
  const raw = escapeText(rawValue).replace(/\\/g, '/');
  if (!raw) return '';
  if (/^(?:https?:|data:|blob:|\/)/i.test(raw)) return raw;
  const safe = typeof DJ.safeAssetUrl === 'function' ? DJ.safeAssetUrl(raw) : raw;
  return `../../${String(safe || raw).replace(/^\.?\//, '')}`;
}

function internalPageUrl(rawValue) {
  const raw = escapeText(rawValue);
  if (!raw) return '../../shop.html';
  if (/^(?:https?:|mailto:|tel:|\/)/i.test(raw)) return raw;
  return `../../${raw.replace(/^\.?\//, '')}`;
}

function playerInitials(name = '') {
  const words = escapeText(name).split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'NBA';
}

function safeExternalImageUrl(value = '') {
  try {
    const url = new URL(escapeText(value));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function appendText(parent, tagName, className, value) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = escapeText(value);
  parent.append(element);
  return element;
}

function appendFact(parent, label, value) {
  const item = document.createElement('span');
  const strong = document.createElement('strong');
  strong.textContent = `${label}:`;
  item.append(strong, document.createTextNode(` ${escapeText(value) || 'Not supplied'}`));
  parent.append(item);
}

function buildImageCandidates(product, DJ = {}) {
  const source = product.image || product.imageGallery?.[0] || '';
  const candidates = [];
  if (typeof DJ.getThumbnailAssetCandidates === 'function') {
    candidates.push(...DJ.getThumbnailAssetCandidates(source));
  }
  candidates.push(source);
  return [...new Set(candidates.map((candidate) => relativeAssetUrl(candidate, DJ)).filter(Boolean))];
}

function createResultCard(match, DJ = {}) {
  const product = match.product || {};
  const player = match.player || {};
  const card = document.createElement('article');
  card.className = 'matchup-result-card';

  const media = document.createElement('div');
  media.className = 'matchup-result-media';
  const imageCandidates = buildImageCandidates(product, DJ);
  if (imageCandidates.length) {
    const image = document.createElement('img');
    image.alt = `${escapeText(product.name) || 'Catalog card'} — verified ${escapeText(player.name) || 'NBA player'} mapping`;
    image.decoding = 'async';
    image.loading = 'lazy';
    let candidateIndex = 0;
    image.src = imageCandidates[candidateIndex];
    image.addEventListener('error', () => {
      candidateIndex += 1;
      if (candidateIndex < imageCandidates.length) image.src = imageCandidates[candidateIndex];
      else {
        image.remove();
        media.classList.add('matchup-result-media--empty');
      }
    });
    media.append(image);
  } else {
    media.classList.add('matchup-result-media--empty');
  }
  appendText(media, 'span', 'matchup-result-badge', 'Verified');
  card.append(media);

  const copy = document.createElement('div');
  copy.className = 'matchup-result-copy';
  const season = match.mapping?.depictedSeasonLabel || product.year || '';
  appendText(copy, 'p', 'matchup-result-kicker', season ? `${season} · ${product.condition || 'Card'}` : 'NBA card');
  appendText(copy, 'h3', '', product.name || 'Catalog card');
  const meta = document.createElement('div');
  meta.className = 'matchup-card-meta';
  if (player.name) appendText(meta, 'span', '', `Verified athlete: ${player.name}`);
  if (product.team) appendText(meta, 'span', '', `Catalog team: ${product.team}`);
  if (match.mapping?.subjectRole) appendText(meta, 'span', '', match.mapping.subjectRole.replaceAll('_', ' '));
  copy.append(meta);

  const bottom = document.createElement('div');
  bottom.className = 'matchup-result-bottom';
  const price = typeof DJ.displayPrice === 'function'
    ? DJ.displayPrice(product)
    : (product.displayPrice || product.priceLabel || (Number.isFinite(Number(product.price)) ? `$${Number(product.price).toFixed(2)}` : 'Ask DJ'));
  appendText(bottom, 'span', 'matchup-result-price', price || 'Ask DJ');
  const link = document.createElement('a');
  link.className = 'matchup-result-link';
  link.href = internalPageUrl(typeof DJ.productPageUrl === 'function' ? DJ.productPageUrl(product) : `basketball-cards.html?item=${encodeURIComponent(product.id || '')}`);
  link.textContent = 'View in catalog';
  link.setAttribute('aria-label', `View ${escapeText(product.name) || 'this card'} in the catalog`);
  bottom.append(link);
  copy.append(bottom);
  card.append(copy);
  return card;
}

function renderPlayerSummary(matches) {
  const summary = document.getElementById('playerSummary');
  if (!summary) return;
  const first = matches[0] || {};
  const player = first.player || {};
  const mapping = first.mapping || {};
  const product = first.product || {};
  const uniquePlayers = [...new Map(matches.map((match) => [
    String(match.player?.athleteId || match.player?.name || ''),
    match.player?.name || ''
  ])).values()].filter(Boolean);
  const singlePlayer = uniquePlayers.length === 1;
  summary.replaceChildren();

  const avatar = document.createElement('div');
  avatar.className = 'matchup-player-avatar';
  const headshot = safeExternalImageUrl(player.headshotUrl);
  if (headshot) {
    const image = document.createElement('img');
    image.alt = `${escapeText(player.name) || 'Verified NBA player'} headshot`;
    image.src = headshot;
    image.loading = 'lazy';
    image.addEventListener('error', () => image.replaceWith(document.createTextNode(playerInitials(player.name))));
    avatar.append(image);
  } else {
    avatar.textContent = playerInitials(player.name);
  }
  summary.append(avatar);

  const copy = document.createElement('div');
  const nameRow = document.createElement('div');
  nameRow.className = 'matchup-player-name-row';
  appendText(nameRow, 'h2', '', singlePlayer ? (player.name || 'Verified NBA player') : `Verified athletes (${uniquePlayers.length})`).id = 'playerSummaryHeading';
  appendText(nameRow, 'span', 'matchup-player-badge', singlePlayer ? 'Active mapping' : 'Exact mappings');
  copy.append(nameRow);
  const facts = document.createElement('div');
  facts.className = 'matchup-player-facts';
  appendFact(facts, 'Catalog cards', `${matches.length}`);
  appendFact(facts, singlePlayer ? 'Catalog team' : 'Athletes', singlePlayer ? (product.team || 'Not listed') : uniquePlayers.join(', '));
  appendFact(facts, 'League', 'NBA');
  appendFact(facts, 'Season', singlePlayer ? (mapping.depictedSeasonLabel || 'Not specified') : 'Varies by card');
  appendFact(facts, 'Position', singlePlayer ? (player.primaryPosition || 'Not supplied') : 'Varies by athlete');
  copy.append(facts);
  summary.append(copy);
  summary.hidden = false;
}

function setStatus(message, state = '') {
  const status = document.getElementById('matchupStatus');
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function showEmptyState(title, description) {
  const state = document.getElementById('noMatchState');
  if (!state) return;
  const heading = state.querySelector('h2');
  const copy = state.querySelector('p');
  if (heading) heading.textContent = title;
  if (copy) copy.textContent = description;
  state.hidden = false;
}

function setLabHandoffEnabled(enabled) {
  const handoff = document.getElementById('labHandoff');
  if (!handoff) return;
  handoff.classList.toggle('is-disabled', !enabled);
  if (enabled) {
    handoff.removeAttribute('aria-disabled');
    handoff.removeAttribute('tabindex');
    handoff.href = '../../lineup-lab/';
    return;
  }
  handoff.setAttribute('aria-disabled', 'true');
  handoff.setAttribute('tabindex', '-1');
  handoff.removeAttribute('href');
}

function resetResults() {
  const summary = document.getElementById('playerSummary');
  const resultSection = document.getElementById('matchupResultsSection');
  const results = document.getElementById('matchupResults');
  const count = document.getElementById('matchupResultCount');
  const resultActions = document.getElementById('matchupResultActions');
  const candidateContinuation = document.getElementById('matchupCandidateContinuation');
  if (summary) summary.hidden = true;
  if (resultSection) resultSection.hidden = true;
  if (results) results.replaceChildren();
  if (count) count.textContent = '';
  if (resultActions) resultActions.hidden = true;
  if (candidateContinuation) candidateContinuation.hidden = true;
  showEmptyState('No verified mapping selected', 'Search above to check the buyer-safe catalog. If an item appears in the Shop but not here, its player relationship is still unmatched, ambiguous, or outside this NBA mapping release.');
  setLabHandoffEnabled(false);
}

function renderResultExpansion(resultWindow) {
  const actions = document.getElementById('matchupResultActions');
  const summary = document.getElementById('matchupResultPagination');
  const button = document.getElementById('matchupShowMoreResults');
  if (!actions || !summary || !button) return;
  if (!resultWindow.remaining) {
    actions.hidden = true;
    return;
  }
  const nextCount = Math.min(RESULT_PAGE_SIZE, resultWindow.remaining);
  summary.textContent = `Showing ${resultWindow.visible.length} of ${resultWindow.total} exact verified cards.`;
  button.textContent = `Show ${nextCount} more verified card${nextCount === 1 ? '' : 's'}`;
  actions.hidden = false;
}

function renderResults(matches, DJ = {}, visibleLimit = RESULT_PAGE_SIZE) {
  const resultWindow = getResultWindow(matches, visibleLimit);
  const resultSection = document.getElementById('matchupResultsSection');
  const results = document.getElementById('matchupResults');
  const count = document.getElementById('matchupResultCount');
  const empty = document.getElementById('noMatchState');
  if (!resultSection || !results || !count || !empty) return resultWindow;
  results.replaceChildren(...resultWindow.visible.map((match) => createResultCard(match, DJ)));
  count.textContent = resultWindow.remaining
    ? `Showing ${resultWindow.visible.length} of ${resultWindow.total} verified cards`
    : `${resultWindow.total} verified card${resultWindow.total === 1 ? '' : 's'}`;
  resultSection.hidden = resultWindow.total === 0;
  empty.hidden = resultWindow.total > 0;
  if (resultWindow.total) renderPlayerSummary(resultWindow.all);
  renderResultExpansion(resultWindow);
  return resultWindow;
}

function createStaticCatalogFallbackLoader(fetchImpl = globalThis.fetch) {
  const cachedCatalogs = new Map();
  return function loadStaticCatalogProducts(DJ = {}) {
    const url = getStaticCatalogFallbackUrl(DJ);
    const cached = cachedCatalogs.get(url);
    if (cached) return cached;
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('Catalog fallback loading is unavailable in this environment.'));
    }

    const request = (async () => {
      // The URL is versioned through DJ.versionedProductAsset, so a page-lifetime
      // cache reuses the same reviewed basketball segment without risking a
      // different catalog release under this key.
      const response = await fetchImpl(url, { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Catalog fallback returned ${response.status}.`);
      const products = await response.json();
      if (!Array.isArray(products)) throw new Error('Catalog fallback was not an array.');
      return products;
    })();
    cachedCatalogs.set(url, request);
    request.catch(() => {
      if (cachedCatalogs.get(url) === request) cachedCatalogs.delete(url);
    });
    return request;
  };
}

const loadStaticCatalogProducts = createStaticCatalogFallbackLoader();

async function loadCatalogProducts() {
  const DJ = globalThis.window?.DJ || {};
  const adapter = DJ.remoteCatalog;
  if (adapter?.isConfigured?.() && typeof adapter.listProducts === 'function') {
    try {
      const products = await adapter.listProducts({ source: 'products-basketball.json' });
      if (Array.isArray(products) && products.length) return products;
    } catch (error) {
      console.warn('Verified matchup catalog query fell back to static catalog.', error);
    }
  }
  return loadStaticCatalogProducts(DJ);
}

async function mapCandidates(candidates, query, onProgress) {
  const adapter = globalThis.window?.DJ?.remoteCatalog;
  if (!adapter || typeof adapter.getNbaProductSlabStats !== 'function') {
    throw new Error('The verified NBA mapping service is not available in this environment.');
  }

  const matches = [];
  let cursor = 0;
  let completed = 0;
  let failures = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const product = candidates[cursor++];
      try {
        const payload = await adapter.getNbaProductSlabStats(product.id);
        matches.push(...extractVerifiedMatches(payload, product, query));
      } catch (error) {
        failures += 1;
        console.warn(`Verified mapping lookup failed for product ${product.id}.`, error);
      } finally {
        completed += 1;
        onProgress?.(completed, candidates.length);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(RPC_CONCURRENCY, candidates.length) }, worker));
  return { matches, failures };
}

function clearSearchState() {
  searchState.query = '';
  searchState.candidates = [];
  searchState.checkedCount = 0;
  searchState.matches = [];
  searchState.failures = 0;
  searchState.visibleResults = RESULT_PAGE_SIZE;
  searchState.isChecking = false;
}

function setLookupBusy(isBusy) {
  searchState.isChecking = isBusy;
  const submit = document.querySelector('#playerSearchForm button[type="submit"]');
  const checkMore = document.getElementById('matchupCheckMoreCandidates');
  const showMore = document.getElementById('matchupShowMoreResults');
  if (submit) submit.disabled = isBusy;
  if (checkMore) checkMore.disabled = isBusy;
  if (showMore) showMore.disabled = isBusy;
}

function updateCandidateContinuation() {
  const continuation = document.getElementById('matchupCandidateContinuation');
  const progress = document.getElementById('matchupCandidateProgress');
  const button = document.getElementById('matchupCheckMoreCandidates');
  if (!continuation || !progress || !button) return;
  const total = searchState.candidates.length;
  const remaining = Math.max(0, total - searchState.checkedCount);
  if (!total || !remaining) {
    continuation.hidden = true;
    return;
  }
  const nextCount = Math.min(CANDIDATE_BATCH_SIZE, remaining);
  progress.textContent = `Exact mappings checked for ${searchState.checkedCount} of ${total} buyer-safe catalog candidates. ${remaining} remain; catalog text never becomes a result without public athlete-ID confirmation.`;
  button.textContent = `Check ${nextCount} more candidate${nextCount === 1 ? '' : 's'}`;
  button.disabled = searchState.isChecking;
  continuation.hidden = false;
}

function uniquePlayersFromMatches(matches = []) {
  return [...new Map(matches.map((match) => [
    String(match.player?.athleteId || match.player?.name || ''),
    match.player?.name || ''
  ])).values()].filter(Boolean);
}

function updateSearchOutcome(resultWindow) {
  const remainingCandidates = Math.max(0, searchState.candidates.length - searchState.checkedCount);
  const coverage = remainingCandidates
    ? `after checking ${searchState.checkedCount} of ${searchState.candidates.length} catalog candidates`
    : `after checking all ${searchState.candidates.length} catalog candidates`;
  const failedNotice = searchState.failures
    ? ` ${searchState.failures} exact mapping check${searchState.failures === 1 ? '' : 's'} did not complete, so those candidates remain unconfirmed.`
    : '';

  if (!resultWindow.total) {
    if (remainingCandidates) {
      setStatus(`No verified cards found ${coverage}. ${remainingCandidates} candidate${remainingCandidates === 1 ? '' : 's'} remain for an optional exact check.${failedNotice}`, searchState.failures === searchState.checkedCount ? 'error' : '');
      showEmptyState('No verified mapping in checked candidates', 'The exact public response did not confirm a card yet. More buyer-safe catalog candidates remain, and you can continue their bounded exact checks below.');
    } else {
      const allFailed = searchState.checkedCount > 0 && searchState.failures === searchState.checkedCount;
      setStatus(allFailed
        ? `Verified mapping service unavailable; no title-only results were shown.${failedNotice}`
        : `No verified mapping found ${coverage}.${failedNotice}`, allFailed ? 'error' : '');
      showEmptyState(allFailed ? 'Verified lookup unavailable' : 'No Verified Mapping Found', allFailed
        ? 'The read-only mapping service could not complete this lookup. No inferred cards were displayed.'
        : 'Every checked candidate required an exact public athlete-ID confirmation. None was confirmed, so no cards were displayed.');
    }
    setLabHandoffEnabled(false);
    return;
  }

  const uniquePlayers = uniquePlayersFromMatches(resultWindow.all);
  const playerName = uniquePlayers[0] || 'this player';
  const resultCopy = uniquePlayers.length === 1
    ? `${resultWindow.total} verified card${resultWindow.total === 1 ? '' : 's'} found for ${playerName}`
    : `${resultWindow.total} verified cards found across ${uniquePlayers.length} exact athletes`;
  const moreCopy = remainingCandidates
    ? ` ${remainingCandidates} candidate${remainingCandidates === 1 ? '' : 's'} remain for an optional exact check.`
    : '';
  setStatus(`${resultCopy} ${coverage}.${moreCopy}${failedNotice}`, '');
  // Lineup Lab currently accepts scenario links, not a player-only parameter,
  // so keep this handoff honest and avoid a no-op query.
  setLabHandoffEnabled(uniquePlayers.length === 1);
}

async function checkNextCandidateBatch(token) {
  const batch = getCandidateBatch(searchState.candidates, searchState.checkedCount);
  if (!batch.length || searchState.isChecking || token !== searchState.token) return false;
  const start = searchState.checkedCount + 1;
  const end = searchState.checkedCount + batch.length;
  setLookupBusy(true);
  setStatus(`Checking exact mappings (${start}–${end} of ${searchState.candidates.length})…`, 'loading');
  try {
    const { matches, failures } = await mapCandidates(batch, searchState.query, (completed, total) => {
      if (token === searchState.token) setStatus(`Checking exact mappings (${start + completed - 1} of ${searchState.candidates.length})…`, 'loading');
    });
    if (token !== searchState.token) return false;
    searchState.matches.push(...matches);
    searchState.failures += failures;
    searchState.checkedCount += batch.length;
    const resultWindow = renderResults(searchState.matches, globalThis.window?.DJ || {}, searchState.visibleResults);
    updateCandidateContinuation();
    updateSearchOutcome(resultWindow);
    return true;
  } catch (error) {
    if (token !== searchState.token) return false;
    console.error('Player & Card Matchups exact mapping batch failed.', error);
    setStatus(error?.message || 'The verified mapping batch could not be completed.', 'error');
    if (!searchState.matches.length) {
      showEmptyState('Verified lookup unavailable', 'The tool could not reach its read-only mapping source. No inferred results were displayed.');
    }
    updateCandidateContinuation();
    return false;
  } finally {
    if (token === searchState.token) setLookupBusy(false);
  }
}

async function runSearch(query, token) {
  const input = document.getElementById('playerSearch');
  const normalizedQuery = normalizeSearchText(query);
  clearSearchState();
  resetResults();

  if (searchTokens(normalizedQuery).length === 0 || normalizedQuery.length < 2) {
    setStatus('Enter at least 2 characters to start an exact lookup.', 'error');
    input?.focus();
    return;
  }

  setLookupBusy(true);
  setStatus('Loading the buyer-safe NBA catalog…', 'loading');
  try {
    const products = await loadCatalogProducts();
    if (token !== searchState.token) return;
    const candidates = buildCandidateProducts(products, normalizedQuery);
    if (!candidates.length) {
      setStatus('No NBA catalog candidates matched that search text.', '');
      showEmptyState('No verified mapping found', 'No buyer-safe NBA catalog text narrowed to this name. Title-only and ambiguous matches remain excluded.');
      return;
    }
    searchState.query = normalizedQuery;
    searchState.candidates = candidates;
    // The catalog fetch is complete; the next bounded RPC batch owns the busy
    // state so an initial lookup cannot be mistaken for an already-running one.
    setLookupBusy(false);
    updateCandidateContinuation();
    await checkNextCandidateBatch(token);
  } catch (error) {
    if (token !== searchState.token) return;
    console.error('Player & Card Matchups catalog lookup failed.', error);
    setStatus(error?.message || 'The verified lookup could not be completed.', 'error');
    showEmptyState('Verified lookup unavailable', 'The tool could not reach its read-only catalog source. No inferred results were displayed.');
  } finally {
    if (token === searchState.token) setLookupBusy(false);
  }
}

const searchState = {
  token: 0,
  query: '',
  candidates: [],
  checkedCount: 0,
  matches: [],
  failures: 0,
  visibleResults: RESULT_PAGE_SIZE,
  isChecking: false
};

function boot() {
  const form = document.getElementById('playerSearchForm');
  const input = document.getElementById('playerSearch');
  if (!form || !input) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    searchState.token += 1;
    runSearch(input.value, searchState.token);
  });

  document.getElementById('matchupCheckMoreCandidates')?.addEventListener('click', () => {
    void checkNextCandidateBatch(searchState.token);
  });

  document.getElementById('matchupShowMoreResults')?.addEventListener('click', () => {
    if (!searchState.matches.length || searchState.isChecking) return;
    searchState.visibleResults += RESULT_PAGE_SIZE;
    renderResults(searchState.matches, globalThis.window?.DJ || {}, searchState.visibleResults);
  });

  const initialPlayer = new URLSearchParams(window.location.search).get('player');
  if (initialPlayer) {
    input.value = initialPlayer;
    searchState.token += 1;
    runSearch(initialPlayer, searchState.token);
  }
}

export {
  buildCandidateProducts,
  createStaticCatalogFallbackLoader,
  extractVerifiedMatches,
  getCandidateBatch,
  getResultWindow,
  getStaticCatalogFallbackUrl,
  isNbaCatalogProduct,
  matchesSearch,
  normalizeSearchText,
  uniqueVerifiedMatches
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
