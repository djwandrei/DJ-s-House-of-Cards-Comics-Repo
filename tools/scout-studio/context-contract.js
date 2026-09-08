// Shared browser/Node contract for descriptive Scout context partitions.
// Keep this module dependency-free so the private source adapter and the
// isolated preview cannot drift into exposing different context keys.
export const SCOUT_CONTEXT_GROUPS = Object.freeze([
  Object.freeze({ key: 'all', label: 'All observed possessions', order: 0 }),
  Object.freeze({ key: 'season', label: 'Season', order: 1 }),
  Object.freeze({ key: 'phase', label: 'Competition phase', order: 2 }),
  Object.freeze({ key: 'venue', label: 'Venue', order: 3 }),
  Object.freeze({ key: 'period', label: 'Period', order: 4 }),
  Object.freeze({ key: 'half', label: 'Half', order: 5 }),
  Object.freeze({ key: 'window', label: 'Recent window', order: 6 }),
  Object.freeze({ key: 'game_state', label: 'Game state', order: 7 }),
  Object.freeze({ key: 'transition', label: 'Transition label', order: 8 }),
  Object.freeze({ key: 'score_state', label: 'Score state', order: 9 }),
  Object.freeze({ key: 'competition', label: 'Competition proxy', order: 10 }),
  Object.freeze({ key: 'leverage', label: 'Leverage proxy', order: 11 }),
]);

const allowedContextValues = Object.freeze({
  // These are the season-start years supported by the current Scout Studio
  // contract. A future package must update this allowlist deliberately.
  season: new Set(['2020', '2021', '2022', '2023', '2024', '2025']),
  phase: new Set(['regular', 'in_season_tournament', 'play_in', 'playoffs', 'unclassified']),
  venue: new Set(['home', 'away', 'unclassified']),
  period: new Set(['q1', 'q2', 'q3', 'q4', 'overtime', 'unclassified']),
  half: new Set(['first_half', 'second_half', 'overtime', 'unclassified']),
  window: new Set(['last_5', 'last_10', 'last_20']),
  clutch: new Set(['unclassified']),
  transition: new Set(['provider_fastbreak_v1', 'non_provider_fastbreak', 'unclassified']),
  score_state: new Set(['tied', 'ahead_1_5', 'ahead_6_10', 'ahead_11_15', 'ahead_16_plus',
    'trailing_1_5', 'trailing_6_10', 'trailing_11_15', 'trailing_16_plus', 'unclassified']),
  competition: new Set(['competitive_proxy_v1', 'garbage_time_proxy_v1', 'unclassified']),
  leverage: new Set(['low', 'standard', 'medium', 'high', 'unclassified']),
});
const contextGroup = key => SCOUT_CONTEXT_GROUPS.find(group => group.key === key);
const titleToken = value => String(value).replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());

export function scoutContextDescriptor(value) {
  const key = String(value ?? '').trim();
  if (key === 'all') return { key, group: 'all', label: 'All observed possessions', order: 0 };
  const separator = key.indexOf(':');
  if (separator <= 0) {
    // The two boolean clutch partitions predate the generic prefix format.
    if (key === 'clutch_v1' || key === 'non_clutch_v1') {
      return { key, group: 'game_state', label: key === 'clutch_v1' ? 'Clutch proxy' : 'Non-clutch proxy', order: 7 };
    }
    return null;
  }
  const group = key.slice(0, separator);
  const valuePart = key.slice(separator + 1);
  if (!allowedContextValues[group]?.has(valuePart)) return null;
  const descriptorGroup = contextGroup(group === 'clutch' ? 'game_state' : group);
  if (!descriptorGroup) return null;
  const label = group === 'clutch' ? 'Clutch status: Unclassified' : `${descriptorGroup.label}: ${titleToken(valuePart)}`;
  return { key, group: descriptorGroup.key, label, order: descriptorGroup.order };
}
