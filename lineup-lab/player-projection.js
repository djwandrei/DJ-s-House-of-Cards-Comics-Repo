/**
 * Pure responsibility/usage projections used by the historical model.
 *
 * Minutes and usage are intentionally separate concepts. Giving a player more
 * court time does not automatically demand star-level offense. A low-usage
 * group, however, still has to finish 100% of the team's possessions. These
 * helpers estimate that extra responsibility and conservatively reduce only an
 * unproven above-baseline advantage. Team-stint games and total minutes are
 * never inputs.
 */

import { workloadRetention } from "./workload-model.js?v=20260905c";

const USAGE_ALIASES = Object.freeze([
  "usage_percentage",
  "usagePercentage",
  "usage_pct",
  "usagePct",
  "usg_pct",
  "usgPct",
  "usg",
]);

const RESPONSIBILITY_ELASTICITY = Object.freeze({
  points: 0.65,
  efgPct: 0.85,
  threePct: 0.75,
  rebounds: 0.1,
  assists: 0.55,
  steals: 0.08,
  blocks: 0.08,
  ballSecurity: 0.75,
  offensiveImpact: 0.4,
  defensiveImpact: 0.2,
});

function finiteNonNegative(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function advancedSources(player) {
  return [player?.analytics?.seasonAdvanced, player?.analytics?.advanced]
    .filter((source) => source && typeof source === "object" && !Array.isArray(source));
}

/** Return usage as a 0–1 share, preserving a real zero and rejecting nonsense. */
export function readPlayerUsage(player) {
  for (const source of advancedSources(player)) {
    for (const alias of USAGE_ALIASES) {
      if (source[alias] == null || source[alias] === "" || typeof source[alias] === "boolean") continue;
      const raw = Number(source[alias]);
      if (!Number.isFinite(raw) || raw < 0) continue;
      const normalized = raw > 1 && raw <= 100 ? raw / 100 : raw;
      if (normalized <= 1) return normalized;
    }
  }
  return null;
}

/**
 * All-team season MPG is evidence about the size of the observed role. The
 * selected-team stint length is deliberately excluded, so trades do not lower
 * confidence merely because a player appeared for fewer games with that club.
 */
export function readSeasonRoleMinutes(player) {
  const totals = player?.analytics?.seasonTotals;
  const games = finiteNonNegative(totals?.games);
  const minutes = finiteNonNegative(totals?.minutes);
  if (games > 0 && minutes !== null) return Math.min(48, minutes / games);
  return Math.min(48, finiteNonNegative(player?.minutes) ?? 0);
}

/**
 * Estimate how much more on-ball responsibility a common rotation role asks a
 * player to carry. A player already at or above league-average usage is not
 * penalized just for receiving more minutes. A low-usage player is moved only
 * partway toward average, in proportion to the unobserved part of the role.
 */
export function projectPlayerResponsibility(
  player,
  metric,
  targetMinutes,
  parameters,
) {
  const sourceMinutes = readSeasonRoleMinutes(player);
  const requestedMinutes = Math.max(0, Number(targetMinutes) || 0);
  const sourceUsage = readPlayerUsage(player);
  const leagueUsage = Number(parameters?.leagueAverageUsage) || 0.2;
  const strength = Number(parameters?.responsibilityExpansionStrength) || 0;
  const expansionShare = requestedMinutes > 0
    ? Math.max(0, requestedMinutes - sourceMinutes) / requestedMinutes
    : 0;
  const elasticity = RESPONSIBILITY_ELASTICITY[metric] ?? 0.35;

  if (parameters?.expansionStrengthByMetric && Object.hasOwn(parameters.expansionStrengthByMetric, metric)) {
    const calibratedStrength = parameters.expansionStrengthByMetric[metric];
    return {
      available: true, source: "chronological-workload-fit", sourceMinutes,
      targetMinutes: requestedMinutes, sourceUsage, targetUsage: sourceUsage,
      usageRatio: sourceUsage > 0 ? 1 : null, expansionShare,
      rateRetention: workloadRetention(sourceMinutes, requestedMinutes, calibratedStrength),
      evidenceGrade: "conditional-prediction",
      reason: "Workload response fitted on earlier games and evaluated on later games. Zero decline is allowed; this is not a causal fatigue estimate.",
    };
  }

  if (sourceUsage !== null && sourceUsage > 0) {
    const targetUsage = sourceUsage + (
      Math.max(0, leagueUsage - sourceUsage) * expansionShare * strength
    );
    const usageRatio = targetUsage / sourceUsage;
    const rateRetention = usageRatio > 1
      ? Math.max(0.35, Math.pow(usageRatio, -elasticity))
      : 1;
    return {
      available: true,
      source: "reported-usage",
      sourceMinutes,
      targetMinutes: requestedMinutes,
      sourceUsage,
      targetUsage,
      usageRatio,
      expansionShare,
      rateRetention,
      evidenceGrade: expansionShare === 0 ? "established" : "projected",
      reason: expansionShare === 0
        ? "The observed role already covers the requested workload."
        : "The rate was tested against the extra team usage a larger low-usage role may need to absorb.",
    };
  }

  // Older fixtures and CSV imports may not include usage. Preserve the prior
  // conservative role-volume contract: only the share supported by observed
  // minutes keeps an above-baseline advantage. This is intentionally stricter
  // than the reported-usage path, because the model cannot distinguish a true
  // low-usage specialist from a missing analytics row.
  const fallbackRetention = requestedMinutes > 0 && sourceMinutes > 0
    ? Math.min(1, sourceMinutes / requestedMinutes)
    : 1;
  return {
    available: false,
    source: "role-volume-fallback",
    sourceMinutes,
    targetMinutes: requestedMinutes,
    sourceUsage: null,
    targetUsage: null,
    usageRatio: null,
    expansionShare,
    rateRetention: fallbackRetention,
    evidenceGrade: "usage-unavailable",
    reason: "Reported usage was unavailable, so a smaller disclosed role-volume fallback was used.",
  };
}

/**
 * Reduce only an unproven advantage toward the same-season baseline. A below-
 * baseline player can never improve merely because the model projects a larger
 * responsibility. For turnovers, lower values are better, so the direction is
 * reversed explicitly.
 */
export function projectMetricForResponsibility({
  player,
  metric,
  observedValue,
  baselineValue,
  targetMinutes,
  parameters,
}) {
  const responsibility = projectPlayerResponsibility(
    player,
    metric,
    targetMinutes,
    parameters,
  );
  const observed = Number(observedValue);
  const baseline = Number(baselineValue);
  const hasAdvantage = metric === "ballSecurity"
    ? observed < baseline
    : observed > baseline;
  const projectedValue = hasAdvantage
    ? baseline + ((observed - baseline) * responsibility.rateRetention)
    : observed;
  return {
    value: projectedValue,
    adjusted: hasAdvantage && responsibility.rateRetention < 1 - 1e-12,
    ...responsibility,
  };
}

function candidateUsageRows(players, minutesById, parameters) {
  const maximumUsage = Number(parameters?.maximumProjectedUsage) || 0.38;
  return players.map((player) => {
    const minutes = Math.max(0, Number(minutesById?.[player.id]) || 0);
    const sourceUsage = readPlayerUsage(player);
    return {
      id: String(player.id),
      minutes,
      sourceUsage,
      targetUsage: sourceUsage,
      remainingCapacity: sourceUsage === null
        ? 0
        : Math.max(0, (maximumUsage - sourceUsage) * minutes),
    };
  });
}

/**
 * Audit whether a complete selected group contains enough observed usage to
 * account for one team possession at a time. Missing usage fails closed: the
 * model reports the gap but applies no hidden score correction unless every
 * selected row has comparable evidence.
 */
export function projectRotationUsageDemand(players, minutesById, parameters) {
  const rows = candidateUsageRows(players, minutesById, parameters);
  const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  const complete = totalMinutes > 0 && rows.every((row) => row.sourceUsage !== null);
  if (!complete) {
    return {
      available: false,
      applied: false,
      adjustmentPoints: 0,
      missingPlayerIds: rows.filter((row) => row.sourceUsage === null).map((row) => row.id),
      reason: "Comparable usage evidence was not available for every selected player.",
      players: rows,
    };
  }

  const requiredUsageMinutes = totalMinutes / 5;
  const observedUsageMinutes = rows.reduce(
    (sum, row) => sum + (row.minutes * row.sourceUsage),
    0,
  );
  let remaining = Math.max(0, requiredUsageMinutes - observedUsageMinutes);

  // Allocate missing possessions first to players who have both documented
  // on-ball responsibility and remaining headroom. This is an explanatory
  // projection; it does not assign box-score events or alter hard constraints.
  while (remaining > 1e-9) {
    const active = rows.filter((row) => row.remainingCapacity > 1e-9 && row.minutes > 0);
    if (active.length === 0) break;
    const priorityTotal = active.reduce(
      (sum, row) => sum + (Math.sqrt(Math.max(0.01, row.sourceUsage)) * row.remainingCapacity),
      0,
    );
    let distributed = 0;
    for (const row of active) {
      const priority = Math.sqrt(Math.max(0.01, row.sourceUsage)) * row.remainingCapacity;
      const share = priorityTotal > 0 ? remaining * (priority / priorityTotal) : 0;
      const addition = Math.min(row.remainingCapacity, share);
      row.targetUsage += addition / row.minutes;
      row.remainingCapacity -= addition;
      distributed += addition;
    }
    if (!(distributed > 1e-12)) break;
    remaining -= distributed;
  }

  const deficitShare = requiredUsageMinutes > 0
    ? Math.max(0, requiredUsageMinutes - observedUsageMinutes) / requiredUsageMinutes
    : 0;
  const unresolvedShare = requiredUsageMinutes > 0 ? remaining / requiredUsageMinutes : 0;
  const penaltyScale = Number(parameters?.usageCoveragePenaltyPoints) || 0;
  const adjustmentPoints = -Math.min(10, deficitShare * penaltyScale + unresolvedShare * 6);

  return {
    available: true,
    applied: deficitShare > 1e-12,
    observedUsageShare: observedUsageMinutes / requiredUsageMinutes,
    projectedUsageShare: (requiredUsageMinutes - remaining) / requiredUsageMinutes,
    deficitShare,
    unresolvedShare,
    adjustmentPoints,
    missingPlayerIds: [],
    reason: deficitShare > 1e-12
      ? "The selected group must expand documented player usage to account for every team possession."
      : "The selected group already contains enough documented usage for a complete team offense.",
    players: rows.map(({ remainingCapacity, ...row }) => ({
      ...row,
      usageExpansion: row.sourceUsage > 0 ? row.targetUsage / row.sourceUsage : 1,
    })),
  };
}
