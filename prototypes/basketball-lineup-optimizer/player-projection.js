/**
 * Pure responsibility/usage projections used by the historical model.
 *
 * Minutes and usage are intentionally separate concepts. Giving a player more
 * court time does not automatically demand star-level offense. A low-usage
 * group, however, still has to finish 100% of the team's possessions. These
 * helpers keep requested responsibility separate and expose its evidence.
 * All-team MPG can describe observed workload; selected-team games never set
 * requested minutes. Usage-dependent mean effects remain validation-gated.
 */

import { workloadRetention } from "./workload-model.js?v=__LINEUP_LAB_ASSET_VERSION__";

const USAGE_ALIASES = Object.freeze([
  "usage_percentage",
  "usagePercentage",
  "usage_pct",
  "usagePct",
  "usg_pct",
  "usgPct",
  "usg",
]);

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
 * Read the independently requested usage share. Raising minutes alone leaves
 * that share unchanged. Only previously fitted conditional minute-response
 * coefficients may affect the mean here; no causal usage elasticity is assumed.
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
  // Usage is a separate scenario input, not a function of assigned minutes.
  // A catch-and-finish center can play 36 minutes at the same usage as at 12.
  // Requesting star-like responsibility must be explicit (or unit-dependent).
  const requestedUsage = finiteNonNegative(parameters?.offensiveResponsibilities?.[player.id]);
  const targetUsage = requestedUsage !== null && requestedUsage <= 1 ? requestedUsage : sourceUsage;
  const expansionShare = requestedMinutes > 0
    ? Math.max(0, requestedMinutes - sourceMinutes) / requestedMinutes
    : 0;

  if (parameters?.expansionStrengthByMetric && Object.hasOwn(parameters.expansionStrengthByMetric, metric)) {
    const calibratedStrength = parameters.expansionStrengthByMetric[metric];
    return {
      available: true, source: "chronological-workload-fit", sourceMinutes,
      targetMinutes: requestedMinutes, sourceUsage, targetUsage,
      usageRatio: sourceUsage > 0 && targetUsage !== null ? targetUsage / sourceUsage : null, expansionShare,
      rateRetention: workloadRetention(sourceMinutes, requestedMinutes, calibratedStrength),
      evidenceGrade: "conditional-prediction",
      reason: "Workload response fitted on earlier games and evaluated on later games. Zero decline is allowed; this is not a causal fatigue estimate.",
    };
  }

  // No fitted usage-response curve has passed complete-box-score validation.
  // Remove the old invented elasticity and minute->usage conversion. Keep the
  // conditional mean unchanged; the separate decision-uncertainty layer may
  // penalize unsupported scenarios without calling that a learned decline.
  return {
    available: sourceUsage !== null,
    source: sourceUsage !== null ? "reported-usage" : "usage-unavailable",
    sourceMinutes,
    targetMinutes: requestedMinutes,
    sourceUsage,
    targetUsage,
    usageRatio: sourceUsage > 0 && targetUsage !== null ? targetUsage / sourceUsage : null,
    expansionShare,
    rateRetention: 1,
    evidenceGrade: "usage-response-unvalidated",
    reason: "Minutes do not set usage. No unvalidated usage elasticity changes expected rates; expanded responsibility is a separate uncertainty scenario.",
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
  return players.map((player) => {
    const minutes = Math.max(0, Number(minutesById?.[player.id]) || 0);
    const sourceUsage = readPlayerUsage(player);
    const requested = finiteNonNegative(parameters?.offensiveResponsibilities?.[player.id]);
    const scenarioProvided = requested !== null && requested <= 1;
    return {
      id: String(player.id),
      minutes,
      sourceUsage,
      scenarioProvided,
      targetUsage: scenarioProvided ? requested : sourceUsage,
    };
  }).filter(row => row.minutes > 0);
}

/**
 * Audit minute-weighted responsibility without silently filling missing usage.
 * A 240-player-minute rotation has 48 usage-minutes of team possessions. This
 * is a compatibility check on the user's scenario, not a possession forecast:
 * source USG rates came from different teammates and contexts. If the shares
 * leave a gap or an overlap, report it instead of manufacturing star-like roles
 * or an unvalidated group penalty. Explicit scenarios are labelled separately
 * from measured evidence, including when a player has no measured usage.
 */
export function projectRotationUsageDemand(players, minutesById, parameters) {
  const rows = candidateUsageRows(players, minutesById, parameters);
  const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  const complete = totalMinutes > 0 && rows.every((row) => row.targetUsage !== null);
  if (!complete) {
    return {
      available: false,
      applied: false,
      adjustmentPoints: 0,
      missingPlayerIds: rows.filter((row) => row.targetUsage === null).map((row) => row.id),
      reason: "A measured usage rate or explicit scenario was not available for every selected player.",
      players: rows,
    };
  }

  const requiredUsageMinutes = totalMinutes / 5;
  const observedUsageMinutes = rows.every(row => row.sourceUsage !== null)
    ? rows.reduce((sum, row) => sum + row.minutes * row.sourceUsage, 0) : null;
  const requestedUsageMinutes = rows.reduce((sum, row) => sum + row.minutes * row.targetUsage, 0);
  const requestedShare = requestedUsageMinutes / requiredUsageMinutes;
  const deficitShare = Math.max(0, 1 - requestedShare);

  return {
    available: true,
    applied: false,
    observedUsageShare: observedUsageMinutes === null ? null : observedUsageMinutes / requiredUsageMinutes,
    projectedUsageShare: requestedShare,
    scenarioPlayerIds: rows.filter(row => row.scenarioProvided).map(row => row.id),
    deficitShare,
    excessShare: Math.max(0, requestedShare - 1),
    unresolvedShare: deficitShare,
    adjustmentPoints: 0,
    missingPlayerIds: [],
    reason: deficitShare > 1e-12
      ? "The assumed roles leave an offensive responsibility gap; no extra usage or score penalty was invented."
      : "The assumed roles cover or overlap team responsibility; this does not prove offensive effectiveness.",
    players: rows.map(row => ({
      ...row,
      usageExpansion: row.sourceUsage > 0 ? row.targetUsage / row.sourceUsage : null,
    })),
  };
}
