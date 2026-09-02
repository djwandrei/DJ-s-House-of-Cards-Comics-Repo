const NBA_PROVIDER = 'NBA';

function text(value) {
  return String(value ?? '').trim();
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integer(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.trunc(number);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeImageUrl(value) {
  const candidate = text(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate, globalThis.document?.baseURI || 'https://example.invalid/');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

function normalizePhase(value) {
  return text(value).toLowerCase() === 'playoffs' ? 'playoffs' : 'regular';
}

function phaseLabel(phase) {
  return phase === 'playoffs' ? 'Playoffs' : 'Regular season';
}

function normalizeSeason(rawSeason) {
  if (!rawSeason || typeof rawSeason !== 'object') return null;
  const seasonEndYear = integer(rawSeason.seasonEndYear);
  const phase = normalizePhase(rawSeason.phase);
  if (!seasonEndYear || seasonEndYear < 1947 || seasonEndYear > 2200) return null;

  const seasonLabel = text(rawSeason.seasonLabel) || `${seasonEndYear - 1}-${String(seasonEndYear % 100).padStart(2, '0')}`;
  return Object.freeze({
    seasonKey: `${seasonEndYear}:${phase}`,
    seasonEndYear,
    seasonLabel,
    phase,
    gamesPlayed: integer(rawSeason.gamesPlayed),
    gamesStarted: integer(rawSeason.gamesStarted),
    minutesPlayed: finiteNumber(rawSeason.minutesPlayed),
    fieldGoalsMade: finiteNumber(rawSeason.fieldGoalsMade),
    fieldGoalsAttempted: finiteNumber(rawSeason.fieldGoalsAttempted),
    fieldGoalPercentage: finiteNumber(rawSeason.fieldGoalPercentage),
    threePointFieldGoalsMade: finiteNumber(rawSeason.threePointFieldGoalsMade),
    threePointFieldGoalsAttempted: finiteNumber(rawSeason.threePointFieldGoalsAttempted),
    threePointPercentage: finiteNumber(rawSeason.threePointPercentage),
    freeThrowsMade: finiteNumber(rawSeason.freeThrowsMade),
    freeThrowsAttempted: finiteNumber(rawSeason.freeThrowsAttempted),
    freeThrowPercentage: finiteNumber(rawSeason.freeThrowPercentage),
    totalRebounds: finiteNumber(rawSeason.totalRebounds),
    assists: finiteNumber(rawSeason.assists),
    steals: finiteNumber(rawSeason.steals),
    blocks: finiteNumber(rawSeason.blocks),
    turnovers: finiteNumber(rawSeason.turnovers),
    points: finiteNumber(rawSeason.points),
    playerEfficiencyRating: finiteNumber(rawSeason.playerEfficiencyRating),
    trueShootingPercentage: finiteNumber(rawSeason.trueShootingPercentage),
    winShares: finiteNumber(rawSeason.winShares),
    winSharesPer48: finiteNumber(rawSeason.winSharesPer48),
    boxPlusMinus: finiteNumber(rawSeason.boxPlusMinus),
    valueOverReplacementPlayer: finiteNumber(rawSeason.valueOverReplacementPlayer),
  });
}

function normalizePlayer(rawEntry, index) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const rawPlayer = rawEntry.player && typeof rawEntry.player === 'object' ? rawEntry.player : {};
  const rawMapping = rawEntry.mapping && typeof rawEntry.mapping === 'object' ? rawEntry.mapping : {};
  const athleteId = text(rawPlayer.athleteId);
  const name = text(rawPlayer.name);
  if (!athleteId || !name) return null;

  const seenSeasonKeys = new Set();
  const seasons = (Array.isArray(rawEntry.seasons) ? rawEntry.seasons : [])
    .map(normalizeSeason)
    .filter((season) => {
      if (!season || seenSeasonKeys.has(season.seasonKey)) return false;
      seenSeasonKeys.add(season.seasonKey);
      return true;
    })
    .sort((left, right) => (
      right.seasonEndYear - left.seasonEndYear
      || (left.phase === 'regular' ? -1 : 1)
    ));

  return Object.freeze({
    athleteId,
    nbaPlayerId: text(rawPlayer.nbaPlayerId),
    name,
    primaryPosition: text(rawPlayer.primaryPosition),
    birthDate: text(rawPlayer.birthDate),
    heightInches: integer(rawPlayer.heightInches),
    weightPounds: integer(rawPlayer.weightPounds),
    college: text(rawPlayer.college),
    country: text(rawPlayer.country),
    debutSeasonEndYear: integer(rawPlayer.debutSeasonEndYear),
    finalSeasonEndYear: integer(rawPlayer.finalSeasonEndYear),
    headshotUrl: safeImageUrl(rawPlayer.headshotUrl),
    subjectOrder: integer(rawMapping.subjectOrder) || index + 1,
    subjectRole: text(rawMapping.subjectRole) || 'primary',
    depictedSeasonLabel: text(rawMapping.depictedSeasonLabel),
    depictedSeasonStartYear: integer(rawMapping.depictedSeasonStartYear),
    depictedSeasonEndYear: integer(rawMapping.depictedSeasonEndYear),
    seasonMappingMethod: text(rawMapping.seasonMappingMethod) || 'unresolved',
    reviewState: text(rawMapping.reviewState),
    seasons: Object.freeze(seasons),
  });
}

export function normalizeNbaSlabStatsPayload(rawPayload, expectedProductId = null) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const provider = text(rawPayload.provider).toUpperCase();
  const productId = Number(rawPayload.productId);
  const expectedId = expectedProductId == null ? null : Number(expectedProductId);
  if (provider !== NBA_PROVIDER || !Number.isSafeInteger(productId) || productId <= 0
    || (Number.isSafeInteger(expectedId) && expectedId > 0 && productId !== expectedId)) {
    return null;
  }

  const seenAthletes = new Set();
  const players = (Array.isArray(rawPayload.players) ? rawPayload.players : [])
    .map(normalizePlayer)
    .filter((player) => {
      if (!player || seenAthletes.has(player.athleteId)) return false;
      seenAthletes.add(player.athleteId);
      return true;
    })
    .sort((left, right) => left.subjectOrder - right.subjectOrder);

  return Object.freeze({
    schemaVersion: integer(rawPayload.schemaVersion) || 1,
    provider,
    productId,
    players: Object.freeze(players),
  });
}

export function chooseDefaultNbaSeason(player) {
  const seasons = Array.isArray(player?.seasons) ? player.seasons : [];
  if (!seasons.length) {
    return Object.freeze({ season: null, reason: 'no_stats' });
  }

  const depictedSeasonEndYear = integer(player.depictedSeasonEndYear);
  if (depictedSeasonEndYear) {
    const exactRegular = seasons.find((season) => (
      season.seasonEndYear === depictedSeasonEndYear && season.phase === 'regular'
    ));
    const exactAny = exactRegular || seasons.find((season) => season.seasonEndYear === depictedSeasonEndYear);
    if (exactAny) return Object.freeze({ season: exactAny, reason: 'depicted_season' });
  }

  const latestRegular = seasons.find((season) => season.phase === 'regular');
  return Object.freeze({ season: latestRegular || seasons[0], reason: 'latest_available' });
}

function divide(numerator, denominator) {
  const top = finiteNumber(numerator);
  const bottom = finiteNumber(denominator);
  return top == null || bottom == null || bottom <= 0 ? null : top / bottom;
}

export function deriveNbaSeasonMetrics(season) {
  if (!season) return Object.freeze({});
  return Object.freeze({
    pointsPerGame: divide(season.points, season.gamesPlayed),
    reboundsPerGame: divide(season.totalRebounds, season.gamesPlayed),
    assistsPerGame: divide(season.assists, season.gamesPlayed),
    stealsPerGame: divide(season.steals, season.gamesPlayed),
    blocksPerGame: divide(season.blocks, season.gamesPlayed),
    turnoversPerGame: divide(season.turnovers, season.gamesPlayed),
    minutesPerGame: divide(season.minutesPlayed, season.gamesPlayed),
    fieldGoalPercentage: finiteNumber(season.fieldGoalPercentage),
    threePointPercentage: finiteNumber(season.threePointPercentage),
    freeThrowPercentage: finiteNumber(season.freeThrowPercentage),
    trueShootingPercentage: finiteNumber(season.trueShootingPercentage),
    playerEfficiencyRating: finiteNumber(season.playerEfficiencyRating),
    winShares: finiteNumber(season.winShares),
    winSharesPer48: finiteNumber(season.winSharesPer48),
    boxPlusMinus: finiteNumber(season.boxPlusMinus),
    valueOverReplacementPlayer: finiteNumber(season.valueOverReplacementPlayer),
  });
}

export function summarizeNbaCareer(player) {
  const regularSeasons = (Array.isArray(player?.seasons) ? player.seasons : [])
    .filter((season) => season.phase === 'regular' && (season.gamesPlayed || 0) > 0);
  if (!regularSeasons.length) return null;

  const gamesPlayed = regularSeasons.reduce((total, season) => total + season.gamesPlayed, 0);
  const perGame = (field) => {
    const completeSeasons = regularSeasons.filter((season) => finiteNumber(season[field]) != null);
    const completeGames = completeSeasons.reduce((total, season) => total + season.gamesPlayed, 0);
    const total = completeSeasons.reduce((sum, season) => sum + finiteNumber(season[field]), 0);
    return divide(total, completeGames);
  };
  const seasonYears = regularSeasons.map((season) => season.seasonEndYear);
  return Object.freeze({
    seasons: regularSeasons.length,
    firstSeasonEndYear: Math.min(...seasonYears),
    lastSeasonEndYear: Math.max(...seasonYears),
    gamesPlayed,
    pointsPerGame: perGame('points'),
    reboundsPerGame: perGame('totalRebounds'),
    assistsPerGame: perGame('assists'),
  });
}

function formatDecimal(value, digits = 1) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : number.toFixed(digits);
}

function formatPercentage(value) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : `${(number * 100).toFixed(1)}%`;
}

function formatInteger(value) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : Math.round(number).toLocaleString('en-US');
}

function formatHeight(heightInches) {
  const value = integer(heightInches);
  if (!value || value <= 0) return '';
  return `${Math.floor(value / 12)}′${value % 12}″`;
}

function seasonReasonCopy(player, selection) {
  if (!selection.season) return 'No historical NBA season rows are available yet.';
  if (selection.reason === 'depicted_season') {
    return `The listing title maps to ${escapeHtml(selection.season.seasonLabel)}, which is selected by default.`;
  }
  if (player.depictedSeasonEndYear) {
    return `The mapped card season is unavailable; the latest ${phaseLabel(selection.season.phase).toLowerCase()} is selected by default.`;
  }
  return `The card season is unresolved; the latest ${phaseLabel(selection.season.phase).toLowerCase()} is selected by default.`;
}

function renderMetric(label, value, description = '') {
  return `
    <div class="slab-stats-metric"${description ? ` title="${escapeHtml(description)}"` : ''}>
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
    </div>
  `;
}

export function renderNbaSeasonStats(player, seasonKey = '') {
  const selection = chooseDefaultNbaSeason(player);
  const season = player.seasons.find((candidate) => candidate.seasonKey === seasonKey)
    || selection.season;
  if (!season) {
    return '<p class="slab-stats-empty">Historical NBA stats are not available for this mapped player yet.</p>';
  }

  const metrics = deriveNbaSeasonMetrics(season);
  return `
    <div class="slab-stats-season-heading">
      <strong>${escapeHtml(season.seasonLabel)} ${escapeHtml(phaseLabel(season.phase))}</strong>
      <span>${formatInteger(season.gamesPlayed)} games</span>
    </div>
    <div class="slab-stats-metrics" aria-label="Key season statistics">
      ${renderMetric('PPG', formatDecimal(metrics.pointsPerGame), 'Points per game')}
      ${renderMetric('RPG', formatDecimal(metrics.reboundsPerGame), 'Rebounds per game')}
      ${renderMetric('APG', formatDecimal(metrics.assistsPerGame), 'Assists per game')}
      ${renderMetric('TS%', formatPercentage(metrics.trueShootingPercentage), 'True shooting percentage')}
      ${renderMetric('BPM', formatDecimal(metrics.boxPlusMinus), 'Box plus/minus')}
      ${renderMetric('VORP', formatDecimal(metrics.valueOverReplacementPlayer), 'Value over replacement player')}
    </div>
    <dl class="slab-stats-detail-grid">
      <div><dt>MPG</dt><dd>${formatDecimal(metrics.minutesPerGame)}</dd></div>
      <div><dt>FG%</dt><dd>${formatPercentage(metrics.fieldGoalPercentage)}</dd></div>
      <div><dt>3P%</dt><dd>${formatPercentage(metrics.threePointPercentage)}</dd></div>
      <div><dt>FT%</dt><dd>${formatPercentage(metrics.freeThrowPercentage)}</dd></div>
      <div><dt>STL</dt><dd>${formatDecimal(metrics.stealsPerGame)}</dd></div>
      <div><dt>BLK</dt><dd>${formatDecimal(metrics.blocksPerGame)}</dd></div>
      <div><dt>PER</dt><dd>${formatDecimal(metrics.playerEfficiencyRating)}</dd></div>
      <div><dt>WS</dt><dd>${formatDecimal(metrics.winShares)}</dd></div>
    </dl>
  `;
}

function renderPlayerProfile(player, index, productId) {
  const defaultSelection = chooseDefaultNbaSeason(player);
  const defaultSeasonKey = defaultSelection.season?.seasonKey || '';
  const career = summarizeNbaCareer(player);
  const panelId = `slab-stats-panel-${productId}-${index}`;
  const tabId = `slab-stats-tab-${productId}-${index}`;
  const selectId = `slab-stats-season-${productId}-${index}`;
  const profileBits = [
    player.primaryPosition,
    formatHeight(player.heightInches),
    player.weightPounds ? `${player.weightPounds} lb` : '',
    player.college,
  ].filter(Boolean);

  return `
    <section class="slab-stats-player" id="${panelId}" role="tabpanel" aria-labelledby="${tabId}" data-slab-player-panel="${index}"${index ? ' hidden' : ''}>
      <div class="slab-stats-player-head">
        ${player.headshotUrl ? `<img src="${escapeHtml(player.headshotUrl)}" alt="${escapeHtml(`${player.name} NBA headshot`)}" loading="lazy" decoding="async">` : '<span class="slab-stats-player-placeholder" aria-hidden="true">NBA</span>'}
        <div>
          <h5>${escapeHtml(player.name)}</h5>
          ${profileBits.length ? `<p>${profileBits.map(escapeHtml).join(' <span aria-hidden="true">&middot;</span> ')}</p>` : ''}
        </div>
      </div>
      ${player.seasons.length ? `
        <label class="slab-stats-season-select" for="${selectId}">
          <span>Stat season</span>
          <select id="${selectId}" data-slab-season-select="${index}">
            ${player.seasons.map((season) => `
              <option value="${escapeHtml(season.seasonKey)}"${season.seasonKey === defaultSeasonKey ? ' selected' : ''}>${escapeHtml(`${season.seasonLabel} - ${phaseLabel(season.phase)}`)}</option>
            `).join('')}
          </select>
        </label>
        <p class="slab-stats-context">${seasonReasonCopy(player, defaultSelection)}</p>
      ` : ''}
      <span class="visually-hidden" role="status" data-slab-season-announcement="${index}"></span>
      <div data-slab-season-output="${index}">${renderNbaSeasonStats(player, defaultSeasonKey)}</div>
      ${career ? `
        <details class="slab-stats-career">
          <summary>Career snapshot</summary>
          <p>${career.seasons} regular seasons &middot; ${formatInteger(career.gamesPlayed)} games &middot; ${formatDecimal(career.pointsPerGame)} PPG &middot; ${formatDecimal(career.reboundsPerGame)} RPG &middot; ${formatDecimal(career.assistsPerGame)} APG</p>
        </details>
      ` : ''}
    </section>
  `;
}

export function renderNbaSlabStatsPanel(payload) {
  const players = Array.isArray(payload?.players) ? payload.players : [];
  if (!players.length) return '';
  const productId = Number(payload.productId);
  const hasMultiplePlayers = players.length > 1;

  return `
    <div class="slab-stats-heading">
      <div>
        <span class="slab-stats-kicker">DJ's Slab-to-Stats</span>
        <h4>Meet the player behind the card</h4>
      </div>
      <span class="slab-stats-league">NBA</span>
    </div>
    ${hasMultiplePlayers ? `
      <div class="slab-stats-tabs" role="tablist" aria-label="Players depicted on this item">
        ${players.map((player, index) => `
          <button type="button" role="tab" id="slab-stats-tab-${productId}-${index}" aria-controls="slab-stats-panel-${productId}-${index}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}" data-slab-player-tab="${index}">${escapeHtml(player.name)}</button>
        `).join('')}
      </div>
    ` : `<span class="visually-hidden" id="slab-stats-tab-${productId}-0">NBA player profile</span>`}
    ${players.map((player, index) => renderPlayerProfile(player, index, productId)).join('')}
    <p class="slab-stats-disclaimer">Historical performance only; not a card valuation, scouting grade, or projection. <a href="lineup-lab/">Explore DJ's Lineup Lab</a>.</p>
  `;
}

function activatePlayerTab(container, nextIndex, { focus = false } = {}) {
  const tabs = [...container.querySelectorAll('[data-slab-player-tab]')];
  const panels = [...container.querySelectorAll('[data-slab-player-panel]')];
  if (!tabs.length || nextIndex < 0 || nextIndex >= tabs.length) return;

  tabs.forEach((tab, index) => {
    const selected = index === nextIndex;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  panels.forEach((panel, index) => {
    panel.hidden = index !== nextIndex;
  });
}

function bindPanelInteractions(container, payload) {
  const tabs = [...container.querySelectorAll('[data-slab-player-tab]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activatePlayerTab(container, index));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex = index;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else nextIndex = (index + 1) % tabs.length;
      activatePlayerTab(container, nextIndex, { focus: true });
    });
  });

  container.querySelectorAll('[data-slab-season-select]').forEach((select) => {
    select.addEventListener('change', () => {
      const playerIndex = Number(select.dataset.slabSeasonSelect);
      const player = payload.players[playerIndex];
      const output = container.querySelector(`[data-slab-season-output="${playerIndex}"]`);
      if (player && output) {
        output.innerHTML = renderNbaSeasonStats(player, select.value);
        const selectedSeason = player.seasons.find((season) => season.seasonKey === select.value);
        const announcement = container.querySelector(`[data-slab-season-announcement="${playerIndex}"]`);
        if (selectedSeason && announcement) {
          announcement.textContent = `Showing ${selectedSeason.seasonLabel} ${phaseLabel(selectedSeason.phase)} stats for ${player.name}.`;
        }
      }
    });
  });
}

export async function mountNbaSlabStatsPanel(container, product, options = {}) {
  const HtmlElement = globalThis.HTMLElement;
  if (!HtmlElement || !(container instanceof HtmlElement)) return false;
  const productId = Number(product?.id);
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const requestStats = options.requestStats
    || globalThis.DJ?.remoteCatalog?.getNbaProductSlabStats;
  if (!Number.isSafeInteger(productId) || productId <= 0 || typeof requestStats !== 'function') {
    container.hidden = true;
    container.replaceChildren();
    container.removeAttribute('aria-busy');
    return false;
  }

  container.hidden = false;
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = '<p class="slab-stats-loading" role="status">Matching this card to verified NBA statistics&hellip;</p>';

  try {
    const rawPayload = await requestStats.call(globalThis.DJ?.remoteCatalog, productId);
    if (!isCurrent() || !container.isConnected) return false;
    const payload = normalizeNbaSlabStatsPayload(rawPayload, productId);
    const markup = renderNbaSlabStatsPanel(payload);
    if (!markup) {
      container.hidden = true;
      container.replaceChildren();
      container.removeAttribute('aria-busy');
      return false;
    }

    container.innerHTML = markup;
    container.removeAttribute('aria-busy');
    bindPanelInteractions(container, payload);
    return true;
  } catch (error) {
    if (isCurrent() && container.isConnected) {
      container.hidden = true;
      container.replaceChildren();
      container.removeAttribute('aria-busy');
      console.warn('NBA Slab-to-Stats data could not be loaded.', error);
    }
    return false;
  }
}
