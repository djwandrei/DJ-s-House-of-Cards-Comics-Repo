/**
 * TEST ONLY: old solver fixtures declared total minutes but no matching counts.
 * Construct coherent synthetic counts to keep those tests about rotation math.
 * Missing-data tests construct their rows directly. No production adapter may
 * infer evidence in this way.
 */
export function withSyntheticCounts(player) {
  const totals = player.analytics?.totals;
  if (!totals || !(totals.minutes > 0) || !(player.minutes > 0)) return player;
  const appearances = totals.minutes / player.minutes;
  const fields = { points: 'points', totalRebounds: 'rebounds', assists: 'assists', steals: 'steals', blocks: 'blocks', turnovers: 'turnovers' };
  const paired = { ...totals };
  for (const [field, rate] of Object.entries(fields)) {
    if (!Object.hasOwn(paired, field)) paired[field] = player[rate] * appearances;
  }
  if (Number.isFinite(paired.fieldGoalsAttempted)) {
    paired.fieldGoalsMade ??= player.fgPct * paired.fieldGoalsAttempted;
    paired.threePointFieldGoalsMade ??= 2 * (player.efgPct - player.fgPct) * paired.fieldGoalsAttempted;
  }
  if (Number.isFinite(paired.threePointFieldGoalsAttempted) && !Object.hasOwn(paired, 'threePointFieldGoalsMade')) {
    paired.threePointFieldGoalsMade = player.threePct * paired.threePointFieldGoalsAttempted;
  }
  return { ...player, analytics: { ...player.analytics, totals: paired } };
}
