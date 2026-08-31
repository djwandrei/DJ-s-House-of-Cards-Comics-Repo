const MAX_CANDIDATES = 24;
const MAX_RESULTS = 12;
const RPC_CONCURRENCY = 4;
const STATIC_CATALOG_VERSION = '20260831a';
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

/**
 * Use buyer-safe catalog text only to choose a small RPC work set. The text is
 * never displayed as a verified player relationship.
 */
function buildCandidateProducts(products = [], query = '', limit = MAX_CANDIDATES) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = searchTokens(query);
  const max = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : MAX_CANDIDATES;
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

function resetResults() {
  const summary = document.getElementById('playerSummary');
  const resultSection = document.getElementById('matchupResultsSection');
  const results = document.getElementById('matchupResults');
  const count = document.getElementById('matchupResultCount');
  if (summary) summary.hidden = true;
  if (resultSection) resultSection.hidden = true;
  if (results) results.replaceChildren();
  if (count) count.textContent = '';
  showEmptyState('No verified mapping selected', 'Search above to check the buyer-safe catalog. If an item appears in the Shop but not here, its player relationship is still unmatched, ambiguous, or outside this NBA mapping release.');
  const handoff = document.getElementById('labHandoff');
  if (handoff) {
    handoff.classList.add('is-disabled');
    handoff.setAttribute('aria-disabled', 'true');
    handoff.href = '../../lineup-lab/';
  }
}

function renderResults(matches, DJ = {}) {
  const byProduct = new Map();
  matches.forEach((match) => {
    const productId = Number(match.product?.id);
    if (!Number.isSafeInteger(productId)) return;
    const existing = byProduct.get(productId);
    const currentName = normalizeSearchText(match.player?.name);
    const existingName = normalizeSearchText(existing?.player?.name);
    if (!existing || currentName.localeCompare(existingName) < 0) byProduct.set(productId, match);
  });
  const unique = [...byProduct.values()]
    .filter((match) => Number.isSafeInteger(Number(match.product?.id)))
    .sort((left, right) => (
      Number(left.product?.sortRank || 0) - Number(right.product?.sortRank || 0)
      || Number(right.product?.year || 0) - Number(left.product?.year || 0)
      || Number(left.product?.id || 0) - Number(right.product?.id || 0)
    ))
    .slice(0, MAX_RESULTS);
  const resultSection = document.getElementById('matchupResultsSection');
  const results = document.getElementById('matchupResults');
  const count = document.getElementById('matchupResultCount');
  const empty = document.getElementById('noMatchState');
  if (!resultSection || !results || !count || !empty) return unique;
  results.replaceChildren(...unique.map((match) => createResultCard(match, DJ)));
  count.textContent = `${unique.length} result${unique.length === 1 ? '' : 's'}`;
  resultSection.hidden = unique.length === 0;
  empty.hidden = unique.length > 0;
  if (unique.length) renderPlayerSummary(unique);
  return unique;
}

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

  const response = await fetch(`../../products-public.json?v=${STATIC_CATALOG_VERSION}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Catalog fallback returned ${response.status}.`);
  const products = await response.json();
  if (!Array.isArray(products)) throw new Error('Catalog fallback was not an array.');
  return products;
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

async function runSearch(query, token) {
  const input = document.getElementById('playerSearch');
  const submit = document.querySelector('#playerSearchForm button[type="submit"]');
  const DJ = globalThis.window?.DJ || {};
  const normalizedQuery = normalizeSearchText(query);
  resetResults();

  if (searchTokens(normalizedQuery).length === 0 || normalizedQuery.length < 2) {
    setStatus('Enter at least 2 characters to start an exact lookup.', 'error');
    input?.focus();
    return;
  }

  if (submit) submit.disabled = true;
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

    setStatus(`Checking ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} against exact athlete IDs…`, 'loading');
    const { matches, failures } = await mapCandidates(candidates, normalizedQuery, (completed, total) => {
      if (token === searchState.token) setStatus(`Checking exact mappings (${completed}/${total})…`, 'loading');
    });
    if (token !== searchState.token) return;
    const rendered = renderResults(matches, DJ);
    if (!rendered.length) {
      setStatus(failures === candidates.length ? 'Verified mapping service unavailable; no title-only results were shown.' : 'No verified mapping found for that search.', failures === candidates.length ? 'error' : '');
      showEmptyState('No Verified Mapping Found', 'This search reached only buyer-safe catalog candidates. The public mapping response did not confirm an exact active NBA athlete, so the cards remain excluded.');
      return;
    }

    const uniquePlayers = [...new Map(rendered.map((match) => [
      String(match.player?.athleteId || match.player?.name || ''),
      match.player?.name || ''
    ])).values()].filter(Boolean);
    const playerName = uniquePlayers[0] || 'this player';
    setStatus(uniquePlayers.length === 1
      ? `${rendered.length} verified card${rendered.length === 1 ? '' : 's'} found for ${playerName}.`
      : `${rendered.length} verified cards found across ${uniquePlayers.length} exact athletes.`, '');
    const handoff = document.getElementById('labHandoff');
    if (handoff) {
      if (uniquePlayers.length === 1) {
        handoff.classList.remove('is-disabled');
        handoff.removeAttribute('aria-disabled');
        // Lineup Lab currently accepts scenario links, not a player-only
        // parameter, so keep this handoff honest and avoid a no-op query.
        handoff.href = '../../lineup-lab/';
      } else {
        handoff.classList.add('is-disabled');
        handoff.setAttribute('aria-disabled', 'true');
        handoff.href = '../../lineup-lab/';
      }
    }
  } catch (error) {
    if (token !== searchState.token) return;
    console.error('Player & Card Matchups lookup failed.', error);
    setStatus(error?.message || 'The verified lookup could not be completed.', 'error');
    showEmptyState('Verified lookup unavailable', 'The tool could not reach its read-only catalog or mapping source. No inferred results were displayed.');
  } finally {
    if (token === searchState.token && submit) submit.disabled = false;
  }
}

const searchState = { token: 0 };

function boot() {
  const form = document.getElementById('playerSearchForm');
  const input = document.getElementById('playerSearch');
  if (!form || !input) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    searchState.token += 1;
    runSearch(input.value, searchState.token);
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
  extractVerifiedMatches,
  isNbaCatalogProduct,
  matchesSearch,
  normalizeSearchText
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
