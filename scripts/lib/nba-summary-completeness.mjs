/**
 * The ingestion contract for independent, official player-game box scores.
 * Keep this module dependency-free: download/resume checks must not load a
 * multi-season analytics fit just to decide whether a game is complete.
 *
 * Presence is NOT reconciliation. Passing this contract means the required
 * Summary observations exist; the separate PBP comparison still decides
 * whether they are safe training evidence. Missing values never become zero.
 */
export const BOX_FIELDS = Object.freeze([
  'points', 'fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts', 'twoPointMakes',
  'threePointAttempts', 'threePointersMade', 'freeThrowAttempts', 'freeThrowsMade',
  'offensiveRebounds', 'defensiveRebounds', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'personalFouls',
]);

export function readOfficialBox(player) {
  const source = player?.officialBoxScore;
  return Object.fromEntries(BOX_FIELDS.map(field => [field,
    source?.source === 'summary_endpoint' && source.availableFields?.includes(field)
      && !source.invalidFields?.includes(field)
      && Number.isSafeInteger(source.fields?.[field]) && source.fields[field] >= 0
      ? source.fields[field] : null,
  ]));
}

const identity = row => `${row?.providerTeamId ?? ''}~${row?.id ?? ''}`;
const played = row => typeof row?.minutesPlayed === 'number' && row.minutesPlayed > 0;

export function inspectSummaryCompleteness(record, overlay = null) {
  const players = overlay?.players ?? record?.players ?? [];
  const teamIds = [record?.game?.homeProviderTeamId, record?.game?.awayProviderTeamId];
  const rows = new Map(), required = new Map(), duplicatePlayers = [];
  const requirePlayer = row => {
    if (row?.id && teamIds.includes(row.providerTeamId)) required.set(identity(row), row);
  };
  for (const row of players) {
    const key = identity(row);
    if (rows.has(key)) duplicatePlayers.push(key);
    rows.set(key, row);
    if (played(row) || row?.isStarter === true) requirePlayer(row);
  }
  // An overlay cannot appear complete by dropping a player who played. Use
  // the archived Summary AND reconstructed lineup membership as expectations,
  // without copying any PBP-derived counts into the official fields.
  for (const row of record?.players ?? []) if (played(row) || row?.isStarter === true) requirePlayer(row);
  for (const lineup of record?.lineups ?? []) {
    for (const id of lineup.playerIds ?? []) requirePlayer({ id, providerTeamId: lineup.providerTeamId });
  }
  const missingPlayers = [];
  for (const [key, expected] of required) {
    const row = rows.get(key), box = readOfficialBox(row);
    const fields = BOX_FIELDS.filter(field => box[field] === null);
    // A real 0:00 appearance can be in an end-of-period lineup. Zero is a
    // present observation, not a denominator fit for a per-minute estimate.
    // Rate eligibility belongs to the downstream evidence/reconciliation gate.
    const minutesMissing = typeof row?.minutesPlayed !== 'number' || !Number.isFinite(row.minutesPlayed) || row.minutesPlayed < 0;
    if (fields.length || minutesMissing) missingPlayers.push({
      playerId: expected.id, teamId: expected.providerTeamId, fields, minutesMissing,
    });
  }
  const teamsPresent = teamIds.every(teamId => teamId && [...required.values()].some(row => row.providerTeamId === teamId));
  return {
    version: 'nba_required_summary_fields_v1',
    complete: required.size > 0 && teamsPresent && !duplicatePlayers.length && !missingPlayers.length,
    requiredPlayers: required.size, teamsPresent, duplicatePlayers, missingPlayers,
    reconciled: false, // Only independent box-score reconciliation may certify this.
  };
}
