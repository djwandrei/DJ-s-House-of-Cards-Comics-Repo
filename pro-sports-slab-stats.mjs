const SUPPORTED_PROVIDERS = Object.freeze(['MLB', 'NFL']);
const STAT_GROUPS = Object.freeze({
  MLB: Object.freeze(['batting', 'pitching']),
  NFL: Object.freeze(['passing', 'rushing', 'receiving', 'defense', 'kicking', 'returns', 'scoring']),
});

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
  const phase = text(value).toLowerCase();
  return phase === 'regular' || phase === 'postseason' ? phase : null;
}

function phaseLabel(phase) {
  return phase === 'postseason' ? 'Postseason' : 'Regular season';
}

function statGroupLabel(statGroup) {
  return ({
    batting: 'Batting',
    pitching: 'Pitching',
    passing: 'Passing',
    rushing: 'Rushing',
    receiving: 'Receiving',
    defense: 'Defense',
    kicking: 'Kicking',
    returns: 'Returns',
    scoring: 'Scoring',
  })[statGroup] || 'Season statistics';
}

function statGroupRank(provider, statGroup) {
  const rank = STAT_GROUPS[provider]?.indexOf(statGroup) ?? -1;
  return rank < 0 ? 99 : rank;
}

function normalizeMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const metrics = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    const number = finiteNumber(rawValue);
    if (number != null) metrics[key] = number;
  });
  return Object.freeze(metrics);
}

function normalizeSeason(rawSeason, provider) {
  if (!rawSeason || typeof rawSeason !== 'object') return null;
  const seasonEndYear = integer(rawSeason.seasonEndYear);
  const phase = normalizePhase(rawSeason.phase);
  const statGroup = text(rawSeason.statGroup).toLowerCase();
  if (!seasonEndYear || seasonEndYear < 1876 || seasonEndYear > 2200
    || !phase || !STAT_GROUPS[provider]?.includes(statGroup)) {
    return null;
  }

  const seasonLabel = text(rawSeason.seasonLabel) || String(seasonEndYear);
  return Object.freeze({
    seasonKey: [seasonEndYear, phase, statGroup].join(':'),
    seasonEndYear,
    seasonLabel,
    phase,
    statGroup,
    gamesPlayed: integer(rawSeason.gamesPlayed),
    gamesStarted: integer(rawSeason.gamesStarted),
    metrics: normalizeMetrics(rawSeason.metrics),
  });
}

function normalizePlayer(rawEntry, provider, index) {
  if (!rawEntry || typeof rawEntry !== 'object') return null;
  const rawPlayer = rawEntry.player && typeof rawEntry.player === 'object' ? rawEntry.player : {};
  const rawMapping = rawEntry.mapping && typeof rawEntry.mapping === 'object' ? rawEntry.mapping : {};
  const athleteId = text(rawPlayer.athleteId);
  const name = text(rawPlayer.name);
  if (!athleteId || !name || text(rawPlayer.leagueCode).toUpperCase() !== provider) return null;

  const seenSeasonKeys = new Set();
  const seasons = (Array.isArray(rawEntry.seasons) ? rawEntry.seasons : [])
    .map((season) => normalizeSeason(season, provider))
    .filter((season) => {
      if (!season || seenSeasonKeys.has(season.seasonKey)) return false;
      seenSeasonKeys.add(season.seasonKey);
      return true;
    })
    .sort((left, right) => (
      right.seasonEndYear - left.seasonEndYear
      || (left.phase === 'regular' ? -1 : 1)
      || statGroupRank(provider, left.statGroup) - statGroupRank(provider, right.statGroup)
    ));

  return Object.freeze({
    athleteId,
    name,
    primaryPosition: text(rawPlayer.primaryPosition),
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

export function normalizeProSportsSlabStatsPayload(rawPayload, expectedProductId = null) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const provider = text(rawPayload.provider).toUpperCase();
  const productId = Number(rawPayload.productId);
  const expectedId = expectedProductId == null ? null : Number(expectedProductId);
  if (!SUPPORTED_PROVIDERS.includes(provider) || !Number.isSafeInteger(productId) || productId <= 0
    || (Number.isSafeInteger(expectedId) && expectedId > 0 && productId !== expectedId)) {
    return null;
  }

  const seenAthletes = new Set();
  const players = (Array.isArray(rawPayload.players) ? rawPayload.players : [])
    .map((entry, index) => normalizePlayer(entry, provider, index))
    .filter((player) => {
      if (!player || seenAthletes.has(player.athleteId)) return false;
      seenAthletes.add(player.athleteId);
      return true;
    })
    .sort((left, right) => left.subjectOrder - right.subjectOrder || left.name.localeCompare(right.name));

  return Object.freeze({
    schemaVersion: integer(rawPayload.schemaVersion) || 1,
    provider,
    productId,
    players: Object.freeze(players),
  });
}

function preferredStatGroup(provider, primaryPosition) {
  const position = text(primaryPosition).toUpperCase();
  if (provider === 'MLB') {
    return /(^|[^A-Z])P($|[^A-Z])|PITCH|LHP|RHP/.test(position) ? 'pitching' : 'batting';
  }
  if (position === 'QB') return 'passing';
  if (['RB', 'FB'].includes(position)) return 'rushing';
  if (['WR', 'TE'].includes(position)) return 'receiving';
  if (['K', 'PK'].includes(position)) return 'kicking';
  if (/(^|[^A-Z])(DE|DT|NT|DL|LB|OLB|ILB|CB|S|FS|SS|DB)($|[^A-Z])/.test(position)) return 'defense';
  return '';
}

export function chooseDefaultProSportsSeason(player, provider) {
  const seasons = Array.isArray(player?.seasons) ? player.seasons : [];
  if (!seasons.length) return Object.freeze({ season: null, reason: 'no_stats' });

  const preferredGroup = preferredStatGroup(provider, player.primaryPosition);
  const preferred = (candidates) => candidates.find((season) => season.statGroup === preferredGroup) || candidates[0] || null;
  const depictedSeasonEndYear = integer(player.depictedSeasonEndYear);
  if (depictedSeasonEndYear) {
    const matchingYear = seasons.filter((season) => season.seasonEndYear === depictedSeasonEndYear);
    const matchingRegular = matchingYear.filter((season) => season.phase === 'regular');
    const season = preferred(matchingRegular) || preferred(matchingYear);
    if (season) return Object.freeze({ season, reason: 'depicted_season' });
  }

  const regular = seasons.filter((season) => season.phase === 'regular');
  return Object.freeze({
    season: preferred(regular) || preferred(seasons),
    reason: 'latest_available',
  });
}

function formatInteger(value) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : Math.round(number).toLocaleString('en-US');
}

function formatDecimal(value, digits = 1) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : number.toFixed(digits);
}

function formatRate(value, digits = 3) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : number.toFixed(digits).replace(/^0(?=\.)/, '');
}

function formatPercentage(value, digits = 1) {
  const number = finiteNumber(value);
  return number == null ? '&mdash;' : number.toFixed(digits) + '%';
}

function metric(label, key, format = formatInteger, description = '') {
  return Object.freeze({ label, key, format, description });
}

const SEASON_METRIC_LAYOUTS = Object.freeze({
  MLB: Object.freeze({
    batting: Object.freeze({
      headline: Object.freeze([
        metric('AVG', 'battingAverage', formatRate, 'Batting average'),
        metric('HR', 'homeRuns', formatInteger, 'Home runs'),
        metric('RBI', 'runsBattedIn', formatInteger, 'Runs batted in'),
        metric('OPS', 'onBasePlusSlugging', formatRate, 'On-base plus slugging'),
        metric('SB', 'stolenBases', formatInteger, 'Stolen bases'),
        metric('WAR', 'war', formatDecimal, 'Wins above replacement'),
      ]),
      detail: Object.freeze([
        metric('G', 'gamesPlayed', formatInteger, 'Games played'),
        metric('PA', 'plateAppearances', formatInteger, 'Plate appearances'),
        metric('AB', 'atBats', formatInteger, 'At bats'),
        metric('H', 'hits', formatInteger, 'Hits'),
        metric('2B', 'doubles', formatInteger, 'Doubles'),
        metric('3B', 'triples', formatInteger, 'Triples'),
        metric('OBP', 'onBasePercentage', formatRate, 'On-base percentage'),
        metric('SLG', 'sluggingPercentage', formatRate, 'Slugging percentage'),
      ]),
    }),
    pitching: Object.freeze({
      headline: Object.freeze([
        metric('W', 'wins', formatInteger, 'Wins'),
        metric('L', 'losses', formatInteger, 'Losses'),
        metric('ERA', 'earnedRunAverage', (value) => formatDecimal(value, 2), 'Earned run average'),
        metric('SO', 'strikeouts', formatInteger, 'Strikeouts'),
        metric('SV', 'saves', formatInteger, 'Saves'),
        metric('WHIP', 'whip', (value) => formatDecimal(value, 2), 'Walks and hits per inning pitched'),
      ]),
      detail: Object.freeze([
        metric('G', 'gamesPlayed', formatInteger, 'Games played'),
        metric('IP outs', 'inningsPitchedOuts', formatInteger, 'Outs recorded'),
        metric('ER', 'earnedRuns', formatInteger, 'Earned runs'),
        metric('H', 'hitsAllowed', formatInteger, 'Hits allowed'),
        metric('BB', 'walks', formatInteger, 'Walks'),
        metric('HR', 'homeRunsAllowed', formatInteger, 'Home runs allowed'),
        metric('K/9', 'strikeoutsPerNine', formatDecimal, 'Strikeouts per nine innings'),
        metric('WAR', 'war', formatDecimal, 'Wins above replacement'),
      ]),
    }),
  }),
  NFL: Object.freeze({
    passing: Object.freeze({
      headline: Object.freeze([
        metric('YDS', 'passingYards', formatInteger, 'Passing yards'),
        metric('TD', 'passingTouchdowns', formatInteger, 'Passing touchdowns'),
        metric('INT', 'interceptions', formatInteger, 'Interceptions thrown'),
        metric('CMP%', 'completionPercentage', formatPercentage, 'Completion percentage'),
        metric('RTG', 'passerRating', formatDecimal, 'Passer rating'),
        metric('Y/A', 'yardsPerAttempt', formatDecimal, 'Yards per attempt'),
      ]),
      detail: Object.freeze([
        metric('G', 'gamesPlayed', formatInteger, 'Games played'),
        metric('GS', 'gamesStarted', formatInteger, 'Games started'),
        metric('CMP', 'completions', formatInteger, 'Completions'),
        metric('ATT', 'attempts', formatInteger, 'Attempts'),
        metric('SACK', 'sacks', formatInteger, 'Sacks taken'),
        metric('1ST', 'firstDowns', formatInteger, 'Passing first downs'),
      ]),
    }),
    rushing: Object.freeze({
      headline: Object.freeze([
        metric('YDS', 'rushingYards', formatInteger, 'Rushing yards'),
        metric('TD', 'rushingTouchdowns', formatInteger, 'Rushing touchdowns'),
        metric('ATT', 'attempts', formatInteger, 'Rushing attempts'),
        metric('Y/A', 'yardsPerAttempt', formatDecimal, 'Yards per attempt'),
        metric('1ST', 'firstDowns', formatInteger, 'Rushing first downs'),
        metric('GP', 'gamesPlayed', formatInteger, 'Games played'),
      ]),
      detail: Object.freeze([
        metric('GS', 'gamesStarted', formatInteger, 'Games started'),
      ]),
    }),
    receiving: Object.freeze({
      headline: Object.freeze([
        metric('REC', 'receptions', formatInteger, 'Receptions'),
        metric('YDS', 'receivingYards', formatInteger, 'Receiving yards'),
        metric('TD', 'receivingTouchdowns', formatInteger, 'Receiving touchdowns'),
        metric('TGT', 'targets', formatInteger, 'Targets'),
        metric('Y/R', 'yardsPerReception', formatDecimal, 'Yards per reception'),
        metric('1ST', 'firstDowns', formatInteger, 'Receiving first downs'),
      ]),
      detail: Object.freeze([
        metric('GP', 'gamesPlayed', formatInteger, 'Games played'),
        metric('GS', 'gamesStarted', formatInteger, 'Games started'),
        metric('CATCH%', 'catchPercentage', formatPercentage, 'Catch percentage'),
      ]),
    }),
    defense: Object.freeze({
      headline: Object.freeze([
        metric('TKL', 'tacklesCombined', formatInteger, 'Combined tackles'),
        metric('SACK', 'sacks', formatDecimal, 'Sacks'),
        metric('INT', 'interceptions', formatInteger, 'Defensive interceptions'),
        metric('PD', 'passesDefended', formatInteger, 'Passes defended'),
        metric('TFL', 'tacklesForLoss', formatInteger, 'Tackles for loss'),
        metric('FF', 'forcedFumbles', formatInteger, 'Forced fumbles'),
      ]),
      detail: Object.freeze([
        metric('GP', 'gamesPlayed', formatInteger, 'Games played'),
        metric('GS', 'gamesStarted', formatInteger, 'Games started'),
        metric('SOLO', 'tacklesSolo', formatInteger, 'Solo tackles'),
        metric('QBH', 'quarterbackHits', formatInteger, 'Quarterback hits'),
      ]),
    }),
    kicking: Object.freeze({
      headline: Object.freeze([
        metric('FGM', 'fieldGoalsMade', formatInteger, 'Field goals made'),
        metric('FGA', 'fieldGoalsAttempted', formatInteger, 'Field goal attempts'),
        metric('FG%', 'fieldGoalPercentage', formatPercentage, 'Field goal percentage'),
        metric('XPM', 'extraPointsMade', formatInteger, 'Extra points made'),
        metric('XPA', 'extraPointsAttempted', formatInteger, 'Extra point attempts'),
        metric('TB', 'touchbacks', formatInteger, 'Kickoff touchbacks'),
      ]),
      detail: Object.freeze([
        metric('GP', 'gamesPlayed', formatInteger, 'Games played'),
      ]),
    }),
    returns: Object.freeze({
      headline: Object.freeze([
        metric('KR', 'kickReturns', formatInteger, 'Kick returns'),
        metric('KR YDS', 'kickReturnYards', formatInteger, 'Kick-return yards'),
        metric('KR TD', 'kickReturnTouchdowns', formatInteger, 'Kick-return touchdowns'),
        metric('PR', 'puntReturns', formatInteger, 'Punt returns'),
        metric('PR YDS', 'puntReturnYards', formatInteger, 'Punt-return yards'),
        metric('PR TD', 'puntReturnTouchdowns', formatInteger, 'Punt-return touchdowns'),
      ]),
      detail: Object.freeze([
        metric('GP', 'gamesPlayed', formatInteger, 'Games played'),
      ]),
    }),
    scoring: Object.freeze({
      headline: Object.freeze([
        metric('PTS', 'points', formatInteger, 'Points scored'),
        metric('TD', 'totalTouchdowns', formatInteger, 'Total touchdowns'),
        metric('PPG', 'pointsPerGame', formatDecimal, 'Points per game'),
        metric('FGM', 'fieldGoalsMade', formatInteger, 'Field goals made'),
        metric('XPM', 'extraPointsMade', formatInteger, 'Extra points made'),
        metric('GP', 'gamesPlayed', formatInteger, 'Games played'),
      ]),
      detail: Object.freeze([
        metric('GS', 'gamesStarted', formatInteger, 'Games started'),
      ]),
    }),
  }),
});

function metricValue(season, definition) {
  if (definition.key === 'gamesPlayed') return season.gamesPlayed;
  if (definition.key === 'gamesStarted') return season.gamesStarted;
  return season.metrics?.[definition.key];
}

function renderMetric(definition, season) {
  return [
    '<div class="slab-stats-metric" title="', escapeHtml(definition.description), '">',
    '<span>', escapeHtml(definition.label), '</span>',
    '<strong>', definition.format(metricValue(season, definition)), '</strong>',
    '</div>',
  ].join('');
}

function seasonReasonCopy(player, selection) {
  if (!selection.season) return 'No historical season rows are available yet.';
  if (selection.reason === 'depicted_season') {
    return 'The listing title maps to ' + escapeHtml(selection.season.seasonLabel) + ', which is selected by default.';
  }
  if (player.depictedSeasonEndYear) {
    return 'The mapped card season is unavailable; the latest ' + phaseLabel(selection.season.phase).toLowerCase() + ' is selected by default.';
  }
  return 'The card season is unresolved; the latest ' + phaseLabel(selection.season.phase).toLowerCase() + ' is selected by default.';
}

export function renderProSportsSeasonStats(player, provider, seasonKey = '') {
  const selection = chooseDefaultProSportsSeason(player, provider);
  const season = player.seasons.find((candidate) => candidate.seasonKey === seasonKey) || selection.season;
  if (!season) {
    return '<p class="slab-stats-empty">Historical stats are not available for this mapped player yet.</p>';
  }

  const layout = SEASON_METRIC_LAYOUTS[provider]?.[season.statGroup];
  if (!layout) {
    return '<p class="slab-stats-empty">Historical stats are not available for this mapped player yet.</p>';
  }
  const detailDefinitions = layout.detail.filter((definition) => metricValue(season, definition) != null);
  const heading = season.seasonLabel + ' ' + phaseLabel(season.phase) + ' · ' + statGroupLabel(season.statGroup);
  return [
    '<div class="slab-stats-season-heading"><strong>', escapeHtml(heading), '</strong><span>',
    formatInteger(season.gamesPlayed), ' games</span></div>',
    '<div class="slab-stats-metrics" aria-label="Key season statistics">',
    layout.headline.map((definition) => renderMetric(definition, season)).join(''),
    '</div>',
    detailDefinitions.length ? '<dl class="slab-stats-detail-grid">' + detailDefinitions.map((definition) => (
      '<div><dt>' + escapeHtml(definition.label) + '</dt><dd>' + definition.format(metricValue(season, definition)) + '</dd></div>'
    )).join('') + '</dl>' : '',
  ].join('');
}

function renderPlayerProfile(player, provider, index, productId) {
  const defaultSelection = chooseDefaultProSportsSeason(player, provider);
  const defaultSeasonKey = defaultSelection.season?.seasonKey || '';
  const panelId = 'pro-slab-stats-panel-' + productId + '-' + index;
  const tabId = 'pro-slab-stats-tab-' + productId + '-' + index;
  const selectId = 'pro-slab-stats-season-' + productId + '-' + index;
  const profileBits = [player.primaryPosition].filter(Boolean);
  const headshot = player.headshotUrl
    ? '<img src="' + escapeHtml(player.headshotUrl) + '" alt="' + escapeHtml(player.name + ' ' + provider + ' headshot') + '" loading="lazy" decoding="async">'
    : '<span class="slab-stats-player-placeholder" aria-hidden="true">' + escapeHtml(provider) + '</span>';
  const selector = player.seasons.length ? [
    '<label class="slab-stats-season-select" for="', selectId, '"><span>Stat season</span>',
    '<select id="', selectId, '" data-pro-slab-season-select="', index, '">',
    player.seasons.map((season) => {
      const label = season.seasonLabel + ' - ' + phaseLabel(season.phase) + ' · ' + statGroupLabel(season.statGroup);
      return '<option value="' + escapeHtml(season.seasonKey) + '"' + (season.seasonKey === defaultSeasonKey ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join(''),
    '</select></label><p class="slab-stats-context">', seasonReasonCopy(player, defaultSelection), '</p>',
  ].join('') : '';

  return [
    '<section class="slab-stats-player" id="', panelId, '" role="tabpanel" aria-labelledby="', tabId,
    '" data-pro-slab-player-panel="', index, '"', index ? ' hidden' : '', '>',
    '<div class="slab-stats-player-head">', headshot, '<div><h5>', escapeHtml(player.name), '</h5>',
    profileBits.length ? '<p>' + profileBits.map(escapeHtml).join(' <span aria-hidden="true">&middot;</span> ') + '</p>' : '',
    '</div></div>', selector,
    '<span class="visually-hidden" role="status" data-pro-slab-season-announcement="', index, '"></span>',
    '<div data-pro-slab-season-output="', index, '">', renderProSportsSeasonStats(player, provider, defaultSeasonKey), '</div>',
    '</section>',
  ].join('');
}

export function renderProSportsSlabStatsPanel(payload) {
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const provider = text(payload?.provider).toUpperCase();
  const productId = Number(payload?.productId);
  if (!players.length || !SUPPORTED_PROVIDERS.includes(provider) || !Number.isSafeInteger(productId)) return '';
  const tabs = players.length > 1 ? [
    '<div class="slab-stats-tabs" role="tablist" aria-label="Players depicted on this item">',
    players.map((player, index) => [
      '<button type="button" role="tab" id="pro-slab-stats-tab-', productId, '-', index,
      '" aria-controls="pro-slab-stats-panel-', productId, '-', index,
      '" aria-selected="', index === 0 ? 'true' : 'false', '" tabindex="', index === 0 ? '0' : '-1',
      '" data-pro-slab-player-tab="', index, '">', escapeHtml(player.name), '</button>',
    ].join('')).join(''),
    '</div>',
  ].join('') : '<span class="visually-hidden" id="pro-slab-stats-tab-' + productId + '-0">' + escapeHtml(provider + ' player profile') + '</span>';

  return [
    '<div class="slab-stats-heading"><div><span class="slab-stats-kicker">DJ&apos;s Slab-to-Stats</span>',
    '<h4>Meet the player behind the card</h4></div><span class="slab-stats-league">', escapeHtml(provider), '</span></div>',
    tabs,
    players.map((player, index) => renderPlayerProfile(player, provider, index, productId)).join(''),
    '<p class="slab-stats-disclaimer">Historical performance only; not a card valuation, scouting grade, or projection.</p>',
  ].join('');
}

function activatePlayerTab(container, nextIndex, options = {}) {
  const tabs = [...container.querySelectorAll('[data-pro-slab-player-tab]')];
  const panels = [...container.querySelectorAll('[data-pro-slab-player-panel]')];
  if (!tabs.length || nextIndex < 0 || nextIndex >= tabs.length) return;
  tabs.forEach((tab, index) => {
    const selected = index === nextIndex;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
    if (selected && options.focus) tab.focus();
  });
  panels.forEach((panel, index) => {
    panel.hidden = index !== nextIndex;
  });
}

function bindPanelInteractions(container, payload) {
  const tabs = [...container.querySelectorAll('[data-pro-slab-player-tab]')];
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

  container.querySelectorAll('[data-pro-slab-season-select]').forEach((select) => {
    select.addEventListener('change', () => {
      const playerIndex = Number(select.dataset.proSlabSeasonSelect);
      const player = payload.players[playerIndex];
      const output = container.querySelector('[data-pro-slab-season-output="' + playerIndex + '"]');
      if (!player || !output) return;
      output.innerHTML = renderProSportsSeasonStats(player, payload.provider, select.value);
      const selectedSeason = player.seasons.find((season) => season.seasonKey === select.value);
      const announcement = container.querySelector('[data-pro-slab-season-announcement="' + playerIndex + '"]');
      if (selectedSeason && announcement) {
        announcement.textContent = 'Showing ' + selectedSeason.seasonLabel + ' ' + phaseLabel(selectedSeason.phase) + ' ' + statGroupLabel(selectedSeason.statGroup) + ' stats for ' + player.name + '.';
      }
    });
  });
}

export async function mountProSportsSlabStatsPanel(container, product, options = {}) {
  const HtmlElement = globalThis.HTMLElement;
  if (!HtmlElement || !(container instanceof HtmlElement)) return false;
  const productId = Number(product?.id);
  const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
  const requestStats = options.requestStats || globalThis.DJ?.remoteCatalog?.getProSportsProductSlabStats;
  if (!Number.isSafeInteger(productId) || productId <= 0 || typeof requestStats !== 'function') {
    container.hidden = true;
    container.replaceChildren();
    return false;
  }

  container.hidden = false;
  container.setAttribute('aria-busy', 'true');
  container.innerHTML = '<p class="slab-stats-loading" role="status">Matching this card to verified player statistics&hellip;</p>';
  try {
    const rawPayload = await requestStats.call(globalThis.DJ?.remoteCatalog, productId);
    if (!isCurrent() || !container.isConnected) return false;
    const payload = normalizeProSportsSlabStatsPayload(rawPayload, productId);
    const markup = renderProSportsSlabStatsPanel(payload);
    if (!markup) {
      container.hidden = true;
      container.replaceChildren();
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
      console.warn('Pro-sports Slab-to-Stats data could not be loaded.', error);
    }
    return false;
  }
}
