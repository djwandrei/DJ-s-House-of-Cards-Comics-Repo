/**
 * Small, dependency-free helpers for Basketball Reference NBA season pages.
 *
 * Basketball Reference puts some of its tables inside HTML comments and has
 * changed a few `data-stat` names over time.  These functions intentionally
 * parse the stable semantic attributes rather than table column positions.
 */

export const BASKETBALL_REFERENCE_SOURCE = 'basketball_reference';
export const BASKETBALL_REFERENCE_BASE_URL = 'https://www.basketball-reference.com';

export const ADVANCED_METRIC_MAP = Object.freeze({
  per: 'player_efficiency_rating',
  ts_pct: 'true_shooting_percentage',
  fg3a_per_fga_pct: 'three_point_attempt_rate',
  fta_per_fga_pct: 'free_throw_attempt_rate',
  orb_pct: 'offensive_rebound_percentage',
  drb_pct: 'defensive_rebound_percentage',
  trb_pct: 'total_rebound_percentage',
  ast_pct: 'assist_percentage',
  stl_pct: 'steal_percentage',
  blk_pct: 'block_percentage',
  tov_pct: 'turnover_percentage',
  usg_pct: 'usage_percentage',
  ows: 'offensive_win_shares',
  dws: 'defensive_win_shares',
  ws: 'win_shares',
  ws_per_48: 'win_shares_per_48',
  obpm: 'offensive_box_plus_minus',
  dbpm: 'defensive_box_plus_minus',
  bpm: 'box_plus_minus',
  vorp: 'value_over_replacement_player'
});

const HTML_ENTITIES = Object.freeze({
  amp: '&',
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  hellip: '…'
});

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attributeValue(markup = '', name) {
  const match = String(markup).match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

export function decodeHtml(value = '') {
  return String(value)
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code) => {
      const numeric = String(code).toLowerCase().startsWith('x')
        ? Number.parseInt(String(code).slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : _match;
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => HTML_ENTITIES[String(name).toLowerCase()] ?? match);
}

export function stripHtml(markup = '') {
  return decodeHtml(String(markup)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function normalizePlayerName(name = '') {
  return stripHtml(name)
    .replace(/\s*[\*†‡]+\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function parseInteger(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === '-' || normalized === '—') return null;
  const parsed = Number.parseInt(normalized.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNumber(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized === '-' || normalized === '—') return null;
  const parsed = Number.parseFloat(normalized.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isMultiTeamAggregate(teamCode = '') {
  const normalized = String(teamCode).trim().toUpperCase();
  return normalized === 'TOT' || /^\d+TM$/.test(normalized);
}

export function extractTableById(html, tableId) {
  const expression = new RegExp(
    `<table\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(tableId)}["'][^>]*>[\\s\\S]*?<\\/table>`,
    'i'
  );
  return String(html).match(expression)?.[0] ?? '';
}

function parseCellMap(rowMarkup) {
  const cells = {};
  const expression = /<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi;
  for (const match of rowMarkup.matchAll(expression)) {
    const dataStat = attributeValue(match[1], 'data-stat');
    if (!dataStat) continue;
    cells[dataStat] = {
      html: match[2],
      text: stripHtml(match[2])
    };
  }
  return cells;
}

function playerFromCell(cell) {
  if (!cell) return null;
  const hrefMatch = cell.html.match(/<a\b[^>]*\bhref\s*=\s*["']\/players\/[a-z]\/([^/"']+)\.html["'][^>]*>/i);
  if (!hrefMatch) return null;
  const externalId = hrefMatch[1].trim().toLowerCase();
  const fullName = stripHtml(cell.html).replace(/\s*[\*†‡]+\s*$/u, '').trim();
  return externalId && fullName ? { externalId, fullName } : null;
}

function firstCell(cells, names) {
  for (const name of names) {
    if (cells[name]) return cells[name];
  }
  return null;
}

function cellText(cells, names) {
  return firstCell(cells, names)?.text ?? '';
}

function rawCellValues(cells) {
  return Object.fromEntries(Object.entries(cells).map(([key, value]) => [key, value.text]));
}

export function parseBasketballReferenceTable(html, tableIds) {
  const ids = Array.isArray(tableIds) ? tableIds : [tableIds];
  let table = '';
  let tableId = '';
  for (const candidateId of ids) {
    table = extractTableById(html, candidateId);
    if (table) {
      tableId = candidateId;
      break;
    }
  }
  if (!table) return { tableId: '', rows: [] };

  // BRef's current pages occasionally omit the optional closing </tbody>.
  // Browsers accept that markup, but a strict non-greedy match would discard
  // every row, so treat the remainder of the table as the body in that case.
  const bodyStart = table.match(/<tbody\b[^>]*>/i);
  if (!bodyStart || bodyStart.index === undefined) return { tableId, rows: [] };
  const afterBodyStart = bodyStart.index + bodyStart[0].length;
  const bodyEndOffset = table.slice(afterBodyStart).search(/<\/tbody>/i);
  const body = bodyEndOffset >= 0
    ? table.slice(afterBodyStart, afterBodyStart + bodyEndOffset)
    : table.slice(afterBodyStart);
  const rows = [];
  for (const match of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if (/\bthead\b/i.test(attributeValue(match[1], 'class'))) continue;
    const cells = parseCellMap(match[2]);
    if (Object.keys(cells).length) rows.push(cells);
  }
  return { tableId, rows };
}

function sourceRecordId({ seasonEndYear, seasonPhase, profile, externalId, teamCode }) {
  return `${seasonEndYear}:${seasonPhase}:${profile}:${externalId}:${teamCode}`;
}

export function parseTotalsPage(html, { seasonEndYear, seasonPhase, sourceUrl }) {
  const { tableId, rows } = parseBasketballReferenceTable(html, ['totals_stats', 'totals']);
  const parsedRows = [];
  for (const cells of rows) {
    const player = playerFromCell(firstCell(cells, ['name_display', 'player']));
    if (!player) continue;
    const teamCode = cellText(cells, ['team_name_abbr', 'team_id']).toUpperCase();
    if (!teamCode) continue;
    const row = {
      ...player,
      normalizedName: normalizePlayerName(player.fullName),
      listedPosition: cellText(cells, ['pos']),
      playerAge: parseInteger(cellText(cells, ['age'])),
      teamCode,
      isMultiTeamAggregate: isMultiTeamAggregate(teamCode),
      gamesPlayed: parseInteger(cellText(cells, ['games', 'g'])),
      gamesStarted: parseInteger(cellText(cells, ['games_started', 'gs'])),
      minutesPlayed: parseInteger(cellText(cells, ['mp'])),
      fieldGoalsMade: parseInteger(cellText(cells, ['fg'])),
      fieldGoalsAttempted: parseInteger(cellText(cells, ['fga'])),
      threePointFieldGoalsMade: parseInteger(cellText(cells, ['fg3'])),
      threePointFieldGoalsAttempted: parseInteger(cellText(cells, ['fg3a'])),
      freeThrowsMade: parseInteger(cellText(cells, ['ft'])),
      freeThrowsAttempted: parseInteger(cellText(cells, ['fta'])),
      offensiveRebounds: parseInteger(cellText(cells, ['orb'])),
      defensiveRebounds: parseInteger(cellText(cells, ['drb'])),
      totalRebounds: parseInteger(cellText(cells, ['trb'])),
      assists: parseInteger(cellText(cells, ['ast'])),
      steals: parseInteger(cellText(cells, ['stl'])),
      blocks: parseInteger(cellText(cells, ['blk'])),
      turnovers: parseInteger(cellText(cells, ['tov'])),
      personalFouls: parseInteger(cellText(cells, ['pf'])),
      points: parseInteger(cellText(cells, ['pts'])),
      sourceUrl,
      sourceRecordId: sourceRecordId({
        seasonEndYear,
        seasonPhase,
        profile: 'totals',
        externalId: player.externalId,
        teamCode
      }),
      rawPayload: rawCellValues(cells)
    };
    parsedRows.push(row);
  }
  return { tableId, rows: parsedRows };
}

export function parseAdvancedPage(html, { seasonEndYear, seasonPhase, sourceUrl }) {
  const { tableId, rows } = parseBasketballReferenceTable(html, ['advanced', 'advanced_stats']);
  const parsedRows = [];
  for (const cells of rows) {
    const player = playerFromCell(firstCell(cells, ['name_display', 'player']));
    if (!player) continue;
    const teamCode = cellText(cells, ['team_name_abbr', 'team_id']).toUpperCase();
    if (!teamCode) continue;
    const metrics = {};
    for (const [sourceField, metricCode] of Object.entries(ADVANCED_METRIC_MAP)) {
      const value = parseNumber(cellText(cells, [sourceField]));
      if (value !== null) metrics[metricCode] = value;
    }
    parsedRows.push({
      ...player,
      normalizedName: normalizePlayerName(player.fullName),
      listedPosition: cellText(cells, ['pos']),
      playerAge: parseInteger(cellText(cells, ['age'])),
      teamCode,
      isMultiTeamAggregate: isMultiTeamAggregate(teamCode),
      metrics,
      sourceUrl,
      sourceRecordId: sourceRecordId({
        seasonEndYear,
        seasonPhase,
        profile: 'advanced',
        externalId: player.externalId,
        teamCode
      }),
      rawPayload: rawCellValues(cells)
    });
  }
  return { tableId, rows: parsedRows };
}

export function parseLeagueTeamsPage(html, { seasonEndYear }) {
  const { rows } = parseBasketballReferenceTable(html, 'per_game-team');
  const teams = new Map();
  for (const cells of rows) {
    const teamCell = firstCell(cells, ['team']);
    if (!teamCell) continue;
    const hrefMatch = teamCell.html.match(new RegExp(`/teams/([A-Z0-9]{2,8})/${seasonEndYear}\\.html`, 'i'));
    if (!hrefMatch) continue;
    const teamCode = hrefMatch[1].toUpperCase();
    // BRef annotates some standings entries with an asterisk (for example a
    // division winner). It is not part of the historical team name.
    const teamName = stripHtml(teamCell.html)
      .replace(/\s*[\*†‡]+\s*$/u, '')
      .trim();
    if (teamCode && teamName) teams.set(teamCode, teamName);
  }
  return teams;
}

export function seasonPageUrls(seasonEndYear, seasonPhase) {
  const year = Number(seasonEndYear);
  if (seasonPhase === 'playoffs') {
    return {
      totals: `${BASKETBALL_REFERENCE_BASE_URL}/playoffs/NBA_${year}_totals.html`,
      advanced: `${BASKETBALL_REFERENCE_BASE_URL}/playoffs/NBA_${year}_advanced.html`
    };
  }
  return {
    totals: `${BASKETBALL_REFERENCE_BASE_URL}/leagues/NBA_${year}_totals.html`,
    advanced: `${BASKETBALL_REFERENCE_BASE_URL}/leagues/NBA_${year}_advanced.html`
  };
}

export function leaguePageUrl(seasonEndYear) {
  return `${BASKETBALL_REFERENCE_BASE_URL}/leagues/NBA_${Number(seasonEndYear)}.html`;
}

export function basketballReferencePlayerPageUrl(externalId) {
  const id = String(externalId).trim().toLowerCase();
  return id ? `${BASKETBALL_REFERENCE_BASE_URL}/players/${id[0]}/${id}.html` : '';
}

// Basketball Reference's season tables expose one `Pos` value for each player
// row. Player profiles, however, can name every real NBA position the player
// has been listed at during his career (for example, "Power Forward and
// Center"). Keep that broader profile evidence separate from a season's
// source-listed role: it is appropriate for eligibility, but it is not a
// possession-level record of where the player played in one specific season.
const PROFILE_POSITION_PATTERNS = Object.freeze([
  ['PG', /\bpoint\s+guard\b/i],
  ['SG', /\bshooting\s+guard\b/i],
  ['SF', /\bsmall\s+forward\b/i],
  ['PF', /\bpower\s+forward\b/i],
  ['C', /\bcenter\b/i],
]);

function playerProfilePositionText(html = '') {
  const source = String(html);
  // A profile starts its fact line with a bold "Position:" label and normally
  // ends it with a second bold "Shoots:" label. Stop at either that next
  // semantic label or the enclosing paragraph so a biography cannot be
  // mistaken for a position.
  const label = /<strong\b[^>]*>\s*Position:\s*<\/strong>/i.exec(source);
  if (!label || label.index === undefined) return '';
  const afterLabel = source.slice(label.index + label[0].length);
  const boundary = /<strong\b[^>]*>\s*(?:Shoots|Bats):\s*<\/strong>|<\/p\s*>/i.exec(afterLabel);
  const fragment = boundary?.index === undefined
    ? afterLabel.slice(0, 700)
    : afterLabel.slice(0, boundary.index);
  return stripHtml(fragment)
    // Profile fact lines use a diamond between fields; it is not a position.
    .replace(/\s*[◆♦▪]\s*.*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse Basketball Reference's career-profile position fact into canonical NBA
 * codes. The result deliberately retains the original text for auditability.
 * A broad "Guard" or "Forward" profile is preserved only when the page does
 * not name a narrower role, so "Shooting Guard" never becomes two positions.
 */
export function parseBasketballReferencePlayerProfilePositions(html = '') {
  const positionText = playerProfilePositionText(html);
  const matches = PROFILE_POSITION_PATTERNS
    .map(([code, pattern]) => ({ code, index: positionText.search(pattern) }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index || left.code.localeCompare(right.code));
  const positions = [...new Set(matches.map(({ code }) => code))];
  if (!positions.length) {
    // Older pages occasionally describe a player only as a generic guard or
    // forward. That is still evidence for the optimizer's broad G/F buckets,
    // but it must not invent a point, shooting, small, or power distinction.
    if (/\bguard\b/i.test(positionText)) positions.push('G');
    if (/\bforward\b/i.test(positionText)) positions.push('F');
  }
  return { positionText, positions };
}

export function basketballReferenceTeamPageUrl(teamCode, seasonEndYear) {
  const code = String(teamCode).trim().toUpperCase();
  return code ? `${BASKETBALL_REFERENCE_BASE_URL}/teams/${code}/${Number(seasonEndYear)}.html` : '';
}

export function extractHeadshotAsset(html, externalId) {
  const escapedId = escapeRegExp(String(externalId).trim().toLowerCase());
  const match = String(html).match(new RegExp(`https?:[^"'\\s>]*?/images/headshots/${escapedId}\\.jpg`, 'i'));
  return match?.[0] ?? '';
}

export function extractTeamLogoAsset(html, teamCode, seasonEndYear) {
  const code = escapeRegExp(String(teamCode).trim().toUpperCase());
  const year = Number(seasonEndYear);
  const match = String(html).match(new RegExp(`https?:[^"'\\s>]*?/tlogo/bbr/${code}-${year}\\.png`, 'i'));
  return match?.[0] ?? '';
}
