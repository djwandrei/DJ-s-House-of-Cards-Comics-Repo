/**
 * Dependency-free parsers for season-level Baseball Reference and
 * Pro Football Reference player tables. The source sites place some tables
 * inside HTML comments, so these helpers parse the source markup directly
 * instead of relying on a browser DOM.
 */

export const BASEBALL_REFERENCE_SOURCE = 'baseball_reference';
export const PRO_FOOTBALL_REFERENCE_SOURCE = 'pro_football_reference';
export const BASEBALL_REFERENCE_BASE_URL = 'https://www.baseball-reference.com';
export const PRO_FOOTBALL_REFERENCE_BASE_URL = 'https://www.pro-football-reference.com';

export const BASEBALL_STAT_GROUPS = Object.freeze(['batting', 'pitching']);
export const FOOTBALL_STAT_GROUPS = Object.freeze([
  'passing',
  'rushing',
  'receiving',
  'defense',
  'kicking',
  'returns',
  'scoring',
]);

const HTML_ENTITIES = Object.freeze({
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', ndash: '–',
  quot: '"', rsquo: '’', hellip: '…', dagger: '†', Dagger: '‡',
});

const NON_METRIC_FIELDS = new Set([
  'ranker', 'rk', 'name_display', 'player', 'age', 'team_name',
  'team_name_abbr', 'team_id', 'team', 'comp_name_abbr', 'pos',
  'position', 'awards',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attributeValue(markup = '', name = '') {
  const expression = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*["']([^"']*)["']`, 'i');
  return String(markup).match(expression)?.[1] ?? '';
}

export function decodeHtml(value = '') {
  return String(value)
    .replace(/&#(x?[0-9a-f]+);?/gi, (_match, code) => {
      const radix = code.toLowerCase().startsWith('x') ? 16 : 10;
      const digits = radix === 16 ? code.slice(1) : code;
      const parsed = Number.parseInt(digits, radix);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _match;
    })
    .replace(/&([a-z]+);/gi, (match, name) => HTML_ENTITIES[name] ?? match);
}

export function stripHtml(markup = '') {
  return decodeHtml(String(markup).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAthleteName(name = '') {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
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
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})*|\d*)(?:\.\d+)?%?$/.test(normalized)) return null;
  const percentage = normalized.endsWith('%');
  const parsed = Number.parseFloat(normalized.replace(/[,%]/g, ''));
  if (!Number.isFinite(parsed)) return null;
  return percentage ? parsed / 100 : parsed;
}

export function isMultiTeamAggregate(teamCode = '') {
  const normalized = String(teamCode).trim().toUpperCase();
  return normalized === 'TOT' || /^\d+TM$/.test(normalized);
}

export function extractTableById(html, tableId) {
  const expression = new RegExp(
    `<table\\b[^>]*\\bid\\s*=\\s*["']${escapeRegExp(tableId)}["'][^>]*>[\\s\\S]*?<\\/table>`,
    'i',
  );
  return String(html).match(expression)?.[0] ?? '';
}

function parseCellMap(rowMarkup) {
  const cells = {};
  const expression = /<(?:th|td)\b([^>]*)>([\s\S]*?)<\/(?:th|td)>/gi;
  for (const match of String(rowMarkup).matchAll(expression)) {
    const dataStat = attributeValue(match[1], 'data-stat');
    if (!dataStat) continue;
    cells[dataStat] = { html: match[2], text: stripHtml(match[2]) };
  }
  return cells;
}

export function parseSportsReferenceTable(html, tableId) {
  const table = extractTableById(html, tableId);
  if (!table) return [];
  const bodyStart = table.match(/<tbody\b[^>]*>/i);
  if (!bodyStart || bodyStart.index === undefined) return [];
  const start = bodyStart.index + bodyStart[0].length;
  const endOffset = table.slice(start).search(/<\/tbody>/i);
  const body = endOffset >= 0 ? table.slice(start, start + endOffset) : table.slice(start);
  const rows = [];
  for (const match of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    if (/\bthead\b/i.test(attributeValue(match[1], 'class'))) continue;
    const cells = parseCellMap(match[2]);
    if (Object.keys(cells).length) rows.push(cells);
  }
  return rows;
}

function firstCell(cells, names) {
  for (const name of names) if (cells[name]) return cells[name];
  return null;
}

function cellText(cells, names) {
  return firstCell(cells, names)?.text ?? '';
}

function rawCellValues(cells) {
  return Object.fromEntries(Object.entries(cells).map(([key, value]) => [key, value.text]));
}

function metricKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function numericMetrics(cells) {
  const metrics = {};
  for (const [key, cell] of Object.entries(cells)) {
    if (NON_METRIC_FIELDS.has(key.toLowerCase())) continue;
    const value = parseNumber(cell.text);
    if (value !== null) metrics[metricKey(key)] = value;
  }
  return metrics;
}

function playerFromCell(cell, playerExpression, normalizeExternalId = (value) => value) {
  if (!cell) return null;
  const match = cell.html.match(playerExpression);
  if (!match) return null;
  const externalId = normalizeExternalId(match[1].trim());
  const fullName = stripHtml(cell.html).replace(/\s*[\*†‡]+\s*$/u, '').trim();
  return externalId && fullName ? { externalId, fullName } : null;
}

function teamFromCell(cell, seasonYear, extension) {
  if (!cell) return { teamCode: '', teamName: '' };
  const expression = new RegExp(`/teams/([A-Z0-9]{2,8})/${Number(seasonYear)}\\.${extension}`, 'i');
  const teamCode = cell.html.match(expression)?.[1]?.toUpperCase() ?? cell.text.trim().toUpperCase();
  const teamName = stripHtml(cell.html).replace(/\s*[\*†‡]+\s*$/u, '').trim();
  return { teamCode, teamName };
}

function baseballTeamNames(html, seasonYear, statGroup) {
  const names = new Map();
  for (const cells of parseSportsReferenceTable(html, `teams_standard_${statGroup}`)) {
    const team = teamFromCell(firstCell(cells, ['team_name', 'team']), seasonYear, 'shtml');
    if (team.teamCode && team.teamName) names.set(team.teamCode, team.teamName);
  }
  return names;
}

function inningsToOuts(value) {
  const normalized = String(value ?? '').trim();
  const match = /^(\d+)(?:\.([012]))?$/.exec(normalized);
  if (!match) return null;
  return Number.parseInt(match[1], 10) * 3 + Number.parseInt(match[2] ?? '0', 10);
}

function sourceRecordId({ seasonYear, seasonPhase, statGroup, externalId, teamCode }) {
  return `${seasonYear}:${seasonPhase}:${statGroup}:${externalId}:${teamCode}`;
}

function preferDuplicateRow(current, candidate) {
  // Sports Reference can emit two league-specific 2TM rows for one player
  // (for example, an AL and NL split). The warehouse key intentionally keeps
  // one aggregate row per player/team/phase/group, so retain the row carrying
  // the larger workload and preserve the discarded variant in provenance.
  const currentGames = current.gamesPlayed ?? -1;
  const candidateGames = candidate.gamesPlayed ?? -1;
  if (candidateGames > currentGames) return candidate;
  if (candidateGames < currentGames) return current;
  const currentMetricCount = Object.keys(current.metrics ?? {}).length;
  const candidateMetricCount = Object.keys(candidate.metrics ?? {}).length;
  return candidateMetricCount > currentMetricCount ? candidate : current;
}

function dedupeRows(rows) {
  const bySourceRecordId = new Map();
  const duplicateVariants = new Map();
  for (const row of rows) {
    const existing = bySourceRecordId.get(row.sourceRecordId);
    if (!existing) {
      bySourceRecordId.set(row.sourceRecordId, row);
      continue;
    }
    const preferred = preferDuplicateRow(existing, row);
    const discarded = preferred === existing ? row : existing;
    bySourceRecordId.set(row.sourceRecordId, {
      ...preferred,
      rawPayload: {
        ...preferred.rawPayload,
        _deduped_variants: [
          ...(preferred.rawPayload?._deduped_variants ?? []),
          discarded.rawPayload,
        ],
      },
    });
    duplicateVariants.set(row.sourceRecordId, (duplicateVariants.get(row.sourceRecordId) ?? 1) + 1);
  }
  return { rows: [...bySourceRecordId.values()], duplicateCount: [...duplicateVariants.values()].reduce((sum, count) => sum + count - 1, 0) };
}

export function baseballReferenceSeasonPageUrl(seasonYear, statGroup) {
  if (!BASEBALL_STAT_GROUPS.includes(statGroup)) throw new Error(`Unsupported MLB stat group: ${statGroup}`);
  return `${BASEBALL_REFERENCE_BASE_URL}/leagues/majors/${Number(seasonYear)}-standard-${statGroup}.shtml`;
}

export function parseBaseballReferenceSeasonPage(html, { seasonYear, statGroup, sourceUrl }) {
  if (!BASEBALL_STAT_GROUPS.includes(statGroup)) throw new Error(`Unsupported MLB stat group: ${statGroup}`);
  const teamNames = baseballTeamNames(html, seasonYear, statGroup);
  const tableSpecs = [
    [`players_standard_${statGroup}`, 'regular'],
    [`players_standard_${statGroup}_post`, 'postseason'],
  ];
  const parsedRows = [];
  const tableCounts = {};
  for (const [tableId, seasonPhase] of tableSpecs) {
    const rows = parseSportsReferenceTable(html, tableId);
    tableCounts[tableId] = rows.length;
    for (const cells of rows) {
      const player = playerFromCell(
        firstCell(cells, ['name_display', 'player']),
        /\/players\/[a-z0-9]\/([^/"']+)\.shtml/i,
        (value) => value.toLowerCase(),
      );
      if (!player) continue;
      const teamCell = firstCell(cells, ['team_name_abbr', 'team_id', 'team']);
      const teamCode = (teamCell?.text ?? '').trim().toUpperCase();
      if (!teamCode) continue;
      const isAggregate = isMultiTeamAggregate(teamCode);
      const metrics = numericMetrics(cells);
      const inningsOuts = statGroup === 'pitching'
        ? inningsToOuts(cellText(cells, ['p_ip', 'ip']))
        : null;
      if (inningsOuts !== null) metrics.innings_pitched_outs = inningsOuts;
      const rawPayload = rawCellValues(cells);
      parsedRows.push({
        ...player,
        normalizedName: normalizeAthleteName(player.fullName),
        teamCode,
        teamName: isAggregate ? '' : (teamNames.get(teamCode) ?? teamCode),
        seasonYear: Number(seasonYear),
        seasonPhase,
        statGroup,
        isMultiTeamAggregate: isAggregate,
        listedPosition: cellText(cells, ['pos', 'position']),
        playerAge: parseInteger(cellText(cells, ['age'])),
        gamesPlayed: parseInteger(cellText(cells, statGroup === 'batting' ? ['b_games', 'G', 'g'] : ['p_g', 'G', 'g'])),
        metrics,
        sourceUrl,
        sourceRecordId: sourceRecordId({ seasonYear, seasonPhase, statGroup, externalId: player.externalId, teamCode }),
        rawPayload,
      });
    }
  }
  const deduped = dedupeRows(parsedRows);
  return { tableCounts, rows: deduped.rows, duplicateCount: deduped.duplicateCount };
}

export function proFootballReferenceSeasonPageUrl(seasonYear, statGroup) {
  if (!FOOTBALL_STAT_GROUPS.includes(statGroup)) throw new Error(`Unsupported NFL stat group: ${statGroup}`);
  return `${PRO_FOOTBALL_REFERENCE_BASE_URL}/years/${Number(seasonYear)}/${statGroup}.htm`;
}

export function parseProFootballReferenceSeasonPage(html, { seasonYear, statGroup, sourceUrl }) {
  if (!FOOTBALL_STAT_GROUPS.includes(statGroup)) throw new Error(`Unsupported NFL stat group: ${statGroup}`);
  const rows = parseSportsReferenceTable(html, statGroup);
  const parsedRows = [];
  for (const cells of rows) {
    const player = playerFromCell(
      firstCell(cells, ['name_display', 'player']),
      /\/players\/[A-Z0-9]\/([^/"']+)\.htm/i,
    );
    if (!player) continue;
    const team = teamFromCell(firstCell(cells, ['team_name_abbr', 'team_id', 'team']), seasonYear, 'htm');
    if (!team.teamCode) continue;
    const isAggregate = isMultiTeamAggregate(team.teamCode);
    parsedRows.push({
      ...player,
      normalizedName: normalizeAthleteName(player.fullName),
      teamCode: team.teamCode,
      teamName: isAggregate ? '' : (team.teamName || team.teamCode),
      seasonYear: Number(seasonYear),
      seasonPhase: 'regular',
      statGroup,
      isMultiTeamAggregate: isAggregate,
      listedPosition: cellText(cells, ['pos', 'position']),
      playerAge: parseInteger(cellText(cells, ['age'])),
      gamesPlayed: parseInteger(cellText(cells, ['g', 'games'])),
      gamesStarted: parseInteger(cellText(cells, ['gs', 'games_started'])),
      metrics: numericMetrics(cells),
      sourceUrl,
      sourceRecordId: sourceRecordId({
        seasonYear,
        seasonPhase: 'regular',
        statGroup,
        externalId: player.externalId,
        teamCode: team.teamCode,
      }),
      rawPayload: rawCellValues(cells),
    });
  }
  return { tableCounts: { [statGroup]: rows.length }, rows: parsedRows };
}
