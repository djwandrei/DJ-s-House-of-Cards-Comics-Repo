// Browser-safe observed-career timeline and resampling helpers.
// These functions never fit an aging curve or manufacture a future season.

export const CAREER_POLICY = Object.freeze({
  version: 'scout-observed-career-replay-v1',
  minTrials: 50,
  maxTrials: 500,
  maxProfiles: 240,
  maxSeasons: 30,
});

const PHASE_ORDER = Object.freeze({ regular: 0, in_season_tournament: 1, play_in: 2, playoffs: 3 });
const TOTAL_METRICS = Object.freeze(['points', 'assists', 'rebounds', 'turnovers', 'steals', 'blocks']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = value => typeof value === 'string' && value.trim() && value.length <= 160 ? value.trim() : null;
const round = value => finite(value) ? Math.round(value * 10000) / 10000 : null;

function normalizeProfile(raw) {
  if (!object(raw) || !integer(raw.seasonStartYear) || raw.seasonStartYear < 1947
    || !cleanText(raw.phase) || !['team', 'all-teams'].includes(raw.scope)
    || (raw.team !== null && raw.team !== undefined && !cleanText(raw.team))) {
    throw new Error('Career evidence contains an invalid season profile.');
  }
  const games = integer(raw.games) && raw.games >= 0 ? raw.games : null;
  const minutes = finite(raw.minutes) && raw.minutes >= 0 ? raw.minutes : null;
  if (games === null || minutes === null) throw new Error('Career season exposure is unavailable or invalid.');
  const perGame = object(raw.perGame) ? raw.perGame : {};
  const cleanedPerGame = Object.fromEntries(TOTAL_METRICS.map(key => [key,
    finite(perGame[key]) && perGame[key] >= 0 ? round(perGame[key]) : null]));
  const positions = Array.isArray(raw.positions)
    ? [...new Set(raw.positions.filter(value => cleanText(value)).map(value => value.trim()))].slice(0, 8)
    : [];
  const key = [raw.seasonStartYear, raw.phase, raw.team || '', raw.scope].join('|');
  return { ...raw, seasonStartYear: raw.seasonStartYear, phase: raw.phase.trim(),
    scope: raw.scope, team: cleanText(raw.team) || (raw.scope === 'all-teams' ? 'All teams' : 'Unknown team'),
    games, minutes: round(minutes), perGame: cleanedPerGame, positions, key };
}

function orderedYears(years) {
  if (!Array.isArray(years) || !years.length || years.length > CAREER_POLICY.maxSeasons
    || years.some(year => !integer(year) || year < 1947) || new Set(years).size !== years.length) {
    throw new Error('Career season scope must contain distinct NBA season start years.');
  }
  return [...years].sort((a, b) => a - b);
}

function weightedAverage(rows, key) {
  const usable = rows.filter(row => finite(row.perGame[key]) && row.games > 0);
  if (!usable.length) return null;
  const games = usable.reduce((sum, row) => sum + row.games, 0);
  return games > 0 ? round(usable.reduce((sum, row) => sum + row.perGame[key] * row.games, 0) / games) : null;
}

function aggregateSeason(rows, seasonStartYear) {
  // ALL_TEAMS rows are the canonical cross-team aggregate. Team rows are used
  // only when an aggregate is absent, which prevents trade rows being counted
  // twice while retaining the team journey for display.
  const allTeamRows = rows.filter(row => row.scope === 'all-teams');
  const selected = allTeamRows.length ? allTeamRows : rows;
  const teamRows = rows.filter(row => row.scope === 'team');
  const games = selected.reduce((sum, row) => sum + row.games, 0);
  const minutes = selected.reduce((sum, row) => sum + row.minutes, 0);
  const primary = [...selected].sort((a, b) => (PHASE_ORDER[a.phase] ?? 99) - (PHASE_ORDER[b.phase] ?? 99))[0] || null;
  const phases = [...new Set(selected.map(row => row.phase))].sort((a, b) => (PHASE_ORDER[a] ?? 99) - (PHASE_ORDER[b] ?? 99) || a.localeCompare(b));
  const teams = [...new Set(teamRows.map(row => row.team).filter(team => team && team !== 'All teams'))].sort();
  const positions = [...new Set(selected.flatMap(row => row.positions || []))].sort();
  const perGame = Object.fromEntries(TOTAL_METRICS.map(key => [key, weightedAverage(selected, key)]));
  const observedRows = selected.map(row => ({ seasonStartYear: row.seasonStartYear, phase: row.phase, team: row.team,
    scope: row.scope, games: row.games, minutes: row.minutes, perGame: row.perGame, positions: row.positions }));
  return {
    seasonStartYear, season: `${seasonStartYear}–${String(seasonStartYear + 1).slice(-2)}`,
    status: games > 0 ? 'observed' : 'unavailable', gap: false, games, minutes: round(minutes),
    teams: teams.length ? teams : ['All teams'], phases, positions, perGame,
    shooting: primary?.shooting || null, involvement: primary?.involvement ?? null,
    primaryPhase: primary?.phase || null, phaseRows: observedRows,
    caveat: allTeamRows.length ? 'Totals use the package’s all-team aggregate for each observed phase; team rows show the recorded team journey.'
      : 'No all-team aggregate was present, so available team rows were combined without imputing missing seasons.',
  };
}

/**
 * Build a season-keyed observed timeline. Missing years are returned as
 * explicit gap rows so a chart or table cannot turn absence into zero.
 */
export function buildCareerTimeline(profiles, { seasonStartYears } = {}) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > CAREER_POLICY.maxProfiles) {
    throw new Error(`Career view accepts one through ${CAREER_POLICY.maxProfiles} season profiles.`);
  }
  const normalized = profiles.map(normalizeProfile);
  const keys = new Set();
  for (const row of normalized) {
    if (keys.has(row.key)) throw new Error('Career evidence contains a duplicate season/phase/team row.');
    keys.add(row.key);
  }
  const years = seasonStartYears ? orderedYears(seasonStartYears)
    : [...new Set(normalized.map(row => row.seasonStartYear))].sort((a, b) => a - b);
  if (!years.length) throw new Error('No season years are available for this player.');
  const bySeason = new Map(years.map(year => [year, []]));
  for (const row of normalized) if (bySeason.has(row.seasonStartYear)) bySeason.get(row.seasonStartYear).push(row);
  const rows = years.map(year => {
    const seasonRows = bySeason.get(year);
    if (!seasonRows.length) return { seasonStartYear: year, season: `${year}–${String(year + 1).slice(-2)}`,
      status: 'gap', gap: true, games: null, minutes: null, teams: [], phases: [], positions: [],
      perGame: Object.fromEntries(TOTAL_METRICS.map(key => [key, null])), phaseRows: [],
      caveat: 'No season profile was present in the selected package window; no zero is inferred.' };
    return aggregateSeason(seasonRows, year);
  });
  return { version: CAREER_POLICY.version, seasonStartYears: years, rows,
    observedRows: rows.filter(row => row.status === 'observed'), gapRows: rows.filter(row => row.gap),
    note: 'Observed season/phase history only. This timeline does not estimate age effects, future availability, role development or a career outcome.' };
}

export function summarizeCareer(timeline) {
  if (!object(timeline) || !Array.isArray(timeline.rows)) throw new Error('Build a career timeline before summarizing it.');
  const observed = timeline.rows.filter(row => row.status === 'observed');
  const gaps = timeline.rows.filter(row => row.gap);
  if (!observed.length) return { observedSeasons: 0, gapSeasons: gaps.length, totals: {}, coverage: {}, teams: [], teamChanges: 0, roleChanges: 0 };
  const totals = {}, coverage = {};
  for (const key of TOTAL_METRICS) {
    const usable = observed.filter(row => finite(row.perGame?.[key]) && integer(row.games) && row.games > 0);
    coverage[key] = { seasons: usable.length, totalSeasons: observed.length };
    totals[key] = usable.length === observed.length
      ? round(usable.reduce((sum, row) => sum + row.perGame[key] * row.games, 0)) : null;
  }
  const teams = [...new Set(observed.flatMap(row => row.teams || []))].sort();
  let teamChanges = 0, roleChanges = 0;
  for (let index = 1; index < observed.length; index++) {
    const previousTeams = (observed[index - 1].teams || []).join('|'), currentTeams = (observed[index].teams || []).join('|');
    if (previousTeams !== currentTeams) teamChanges++;
    if ((observed[index - 1].positions || []).join('|') !== (observed[index].positions || []).join('|')) roleChanges++;
  }
  const peak = observed.filter(row => finite(row.perGame?.points)).sort((a, b) => b.perGame.points - a.perGame.points || a.seasonStartYear - b.seasonStartYear)[0] || null;
  return { observedSeasons: observed.length, gapSeasons: gaps.length,
    firstSeason: observed[0].seasonStartYear, lastSeason: observed.at(-1).seasonStartYear,
    totals, coverage, teams, teamChanges, roleChanges,
    peakScoringSeason: peak ? { seasonStartYear: peak.seasonStartYear, season: peak.season, perGame: peak.perGame.points } : null,
    note: 'Totals are reconstructed from observed per-game rows multiplied by observed games. Missing component seasons remain unavailable.' };
}

function randomStream(seed) {
  if (typeof seed !== 'string' || !/^[A-Za-z0-9:._-]{1,80}$/.test(seed)) throw new Error('Use a short alphanumeric replay seed.');
  let state = 2166136261;
  for (const char of seed) { state ^= char.charCodeAt(0); state = Math.imul(state, 16777619); }
  return () => {
    state += 0x6D2B79F5;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantiles(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([10, 50, 90].map(percent => [percent,
    round(sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)])]));
}

/**
 * Replay observed season rows with replacement. This is a bounded descriptive
 * bootstrap: it quantifies variation in the supplied observations and is not a
 * future-career forecast or an aging/availability model.
 */
export function replayObservedCareer(timeline, { trials = 100, seed = 'career-replay', seasons } = {}) {
  if (!object(timeline) || !Array.isArray(timeline.rows)) throw new Error('Build a career timeline before replaying it.');
  const observed = timeline.rows.filter(row => row.status === 'observed' && integer(row.games) && row.games > 0);
  if (!observed.length) throw new Error('At least one observed season is required for a replay.');
  if (!integer(trials) || trials < CAREER_POLICY.minTrials || trials > CAREER_POLICY.maxTrials) {
    throw new Error(`Use ${CAREER_POLICY.minTrials}–${CAREER_POLICY.maxTrials} replay trials.`);
  }
  const targetSeasons = seasons === undefined ? observed.length : seasons;
  if (!integer(targetSeasons) || targetSeasons < 1 || targetSeasons > CAREER_POLICY.maxSeasons) throw new Error('Replay length is outside the supported season range.');
  const random = randomStream(seed);
  const values = Object.fromEntries(['games', 'minutes', ...TOTAL_METRICS].map(key => [key, []]));
  const complete = Object.fromEntries(TOTAL_METRICS.map(key => [key, 0]));
  for (let trial = 0; trial < trials; trial++) {
    const sample = Array.from({ length: targetSeasons }, () => observed[Math.floor(random() * observed.length)]);
    values.games.push(sample.reduce((sum, row) => sum + row.games, 0));
    values.minutes.push(sample.reduce((sum, row) => sum + row.minutes, 0));
    for (const key of TOTAL_METRICS) {
      if (sample.every(row => finite(row.perGame?.[key]))) {
        complete[key]++;
        values[key].push(sample.reduce((sum, row) => sum + row.perGame[key] * row.games, 0));
      }
    }
  }
  return { version: CAREER_POLICY.version, seed, trials, targetSeasons,
    metrics: Object.fromEntries(Object.entries(values).map(([key, series]) => [key, {
      quantiles: quantiles(series), completeTrials: key in complete ? complete[key] : trials,
    }])),
    note: 'Observed-career replay only: rows are resampled from the supplied history. It does not project a future season, estimate aging, model nonparticipation or validate a career forecast.',
  };
}

