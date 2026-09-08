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

import { workloadRetention } from "./workload-model.js?v=20260907f";
import { SCOUT_GAME_EVIDENCE_VERSION, pairedMetricEvidence } from "./projection-evidence.js?v=20260907f";

// This contract is deliberately narrower than a universal "usage" rating.
// It records the amount of possession-ending work that was actually observed
// alongside a player's minutes.  It can therefore be used to identify a
// low-role per-36 spike without claiming that box scores measured touches,
// playmaking share, or a causal response to a new coach/teammate mix.
export const RESPONSIBILITY_EVIDENCE_VERSION = "scout-responsibility-evidence-v1";
export const DEFAULT_RESPONSIBILITY_PRIOR_MINUTES = 720;

// A possession-ending workload proxy can speak to offensive role expansion,
// but it is not evidence that a player will collect more rebounds, steals, or
// blocks at a new assignment.  Those defensive/board rates retain their own
// metric-specific evidence and the calibrated workload fit.  Keeping this
// allowlist explicit also prevents a future caller from accidentally applying
// an offensive responsibility prior to every stat in the objective.
export const RESPONSIBILITY_SENSITIVE_METRICS = Object.freeze([
  "points",
  "efgPct",
  "threePct",
  "assists",
  "ballSecurity",
  "offensiveImpact",
]);
const RESPONSIBILITY_SENSITIVE_METRIC_SET = new Set(RESPONSIBILITY_SENSITIVE_METRICS);

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

function finiteNonNegativeInteger(value) {
  const number = finiteNonNegative(value);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

/**
 * Validate the optional responsibility evidence attached by a data adapter.
 *
 * The optimizer never reconstructs this object from a player's selected-team
 * stint.  The adapter must explicitly label a season-wide, all-team sample (or
 * a future Scout game subset) before it can influence the larger-role prior.
 * Keeping this boundary strict prevents a four-game trade stint from being
 * mistaken for the player's established offensive responsibility.
 */
export function readResponsibilityEvidence(player) {
  const analytics = player?.analytics;
  if (!analytics || typeof analytics !== "object" || Array.isArray(analytics)) return null;
  const candidates = [
    analytics.responsibilityEvidence,
    analytics.seasonEvidence?.responsibilityEvidence,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (candidate.version !== RESPONSIBILITY_EVIDENCE_VERSION) continue;
    if (!['season-wide', 'scout-player-game-subset'].includes(candidate.scope)) continue;
    // A serialized browser row can outlive the query that produced it. If the
    // producer included an identity, bind it before accepting any numbers;
    // absence remains backward-compatible with the season-wide adapter.
    if (candidate.playerId != null && String(candidate.playerId) !== String(player?.id ?? "")) continue;
    if (candidate.scope === "scout-player-game-subset"
      && (!candidate.sourceRevision || typeof candidate.sourceRevision !== "string")) continue;
    const games = finiteNonNegativeInteger(candidate.games ?? candidate.verifiedGames);
    const minutes = finiteNonNegative(candidate.minutes ?? candidate.officialMinutes);
    const involvementPer36 = finiteNonNegative(candidate.offensiveInvolvementPer36);
    if (!(games > 0) || !(minutes > 0) || involvementPer36 === null) continue;
    const expectedInvolvement = involvementPer36 * minutes / 36;
    const involvement = finiteNonNegative(candidate.offensiveInvolvement);
    if (involvement !== null
      && Math.abs(involvement - expectedInvolvement) > 1e-8 * Math.max(1, expectedInvolvement)) continue;
    const componentRates = [
      finiteNonNegative(candidate.fieldGoalAttemptsPer36),
      finiteNonNegative(candidate.freeThrowAttemptsPer36),
      finiteNonNegative(candidate.turnoversPer36),
    ];
    if (componentRates.every(value => value !== null)) {
      const componentInvolvement = componentRates[0] + (0.44 * componentRates[1]) + componentRates[2];
      if (Math.abs(componentInvolvement - involvementPer36)
        > 1e-8 * Math.max(1, involvementPer36)) continue;
    }
    return {
      version: RESPONSIBILITY_EVIDENCE_VERSION,
      scope: candidate.scope,
      games,
      minutes,
      minutesPerGame: minutes / games,
      offensiveInvolvement: involvement ?? expectedInvolvement,
      offensiveInvolvementPer36: involvementPer36,
      fieldGoalAttemptsPer36: finiteNonNegative(candidate.fieldGoalAttemptsPer36),
      freeThrowAttemptsPer36: finiteNonNegative(candidate.freeThrowAttemptsPer36),
      assistsPer36: finiteNonNegative(candidate.assistsPer36),
      turnoversPer36: finiteNonNegative(candidate.turnoversPer36),
      sourceRevision: typeof candidate.sourceRevision === "string" ? candidate.sourceRevision : null,
      completeness: typeof candidate.completeness === "string" ? candidate.completeness : "unspecified",
    };
  }
  return null;
}

/**
 * Resolve the response strength for one player/metric.
 *
 * A validated chronological fit wins when one exists. Otherwise a small,
 * explicit responsibility prior is available only for rows carrying the
 * evidence contract above. Its strength increases modestly when the observed
 * workload is thin, so a reserve's one-game per-36 spike cannot receive the
 * same larger-role credit as a player who sustained the rate over a season.
 * This is a sensitivity prior, not a learned fatigue or usage-elasticity fit.
 */
export function responsibilityExpansionFor(player, metric, parameters = {}) {
  const calibratedByMetric = parameters?.expansionStrengthByMetric;
  const hasCalibratedMetric = calibratedByMetric
    && typeof calibratedByMetric === "object"
    && !Array.isArray(calibratedByMetric)
    && Object.hasOwn(calibratedByMetric, metric);
  const calibrated = hasCalibratedMetric
    ? finiteNonNegative(calibratedByMetric[metric])
    : null;
  // A fitted zero is a real chronological result. It must win over the
  // fallback responsibility prior, otherwise a calibrated season would gain
  // an unvalidated decline merely because its fitted response was zero.
  if (hasCalibratedMetric && calibrated !== null) {
    return {
      strength: calibrated,
      source: "chronological-workload-fit",
      evidence: readResponsibilityEvidence(player),
      reliability: null,
      priorMinutes: null,
    };
  }
  // An explicitly supplied but malformed fit is not evidence for the prior.
  // Keep the failure visible and fail closed instead of silently replacing a
  // bad calibration with a different modeling assumption.
  if (hasCalibratedMetric) {
    return {
      strength: 0,
      source: "chronological-workload-fit-invalid",
      evidence: readResponsibilityEvidence(player),
      reliability: null,
      priorMinutes: null,
    };
  }
  const evidence = readResponsibilityEvidence(player);
  const baseStrength = finiteNonNegative(parameters?.responsibilityExpansionStrength);
  if (!evidence || !(baseStrength > 0)) {
    return {
      strength: 0,
      source: evidence ? "responsibility-prior-disabled" : "responsibility-evidence-unavailable",
      evidence,
      reliability: null,
      priorMinutes: null,
    };
  }
  const priorMinutes = finiteNonNegative(parameters?.responsibilityPriorMinutes)
    ?? DEFAULT_RESPONSIBILITY_PRIOR_MINUTES;
  const reliability = evidence.minutes / (evidence.minutes + priorMinutes);
  if (!RESPONSIBILITY_SENSITIVE_METRIC_SET.has(metric)) {
    return {
      strength: 0,
      source: "responsibility-prior-not-applicable",
      evidence,
      reliability,
      priorMinutes,
    };
  }
  // Thin evidence gets at most a 50% increase in the prior strength.  The cap
  // keeps the curve from turning every short but legitimate role into a hard
  // exclusion, while still making the Beringer-style low-exposure spike pay a
  // larger uncertainty/role cost than a sustained starter rate.
  const strength = Math.min(1.5, baseStrength * (1 + (0.5 * (1 - reliability))));
  return {
    strength,
    source: "responsibility-evidence-prior",
    evidence,
    reliability,
    priorMinutes,
  };
}

/** Return usage as a 0–1 share, preserving a real zero and rejecting nonsense. */
export function readPlayerUsage(player) {
  // The interrupted Scout rows do not yet certify full on-court possession
  // exposure for usage. Do not pull an older dataset's USG into the new model
  // merely because it shares this browser row. Explicit what-if responsibility
  // still works, but stays an assumption rather than measured Scout usage.
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) return null;
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
export function readSeasonRoleMinutes(player, metric = null) {
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) {
    const scout = player.analytics.scoutPlayerGameEvidence;
    if (scout?.version !== SCOUT_GAME_EVIDENCE_VERSION || scout.scope?.playerId !== player.id) return null;
    // A component observed in 6-minute games must not borrow a 36-minute role
    // from games in which that component was missing. The reference exposure
    // changes extrapolation uncertainty, never a hard minute floor or ceiling.
    const paired = metric ? pairedMetricEvidence(player, metric) : scout.workload;
    const games = finiteNonNegative(paired?.verifiedGames), minutes = finiteNonNegative(paired?.minutes);
    return games > 0 && minutes !== null ? Math.min(48, minutes / games) : null;
  }
  const totals = player?.analytics?.seasonTotals;
  const games = finiteNonNegative(totals?.games);
  const minutes = finiteNonNegative(totals?.minutes);
  if (games > 0 && minutes !== null) return Math.min(48, minutes / games);
  // A future Scout adapter may provide the strict responsibility contract
  // without copying a second seasonTotals object into the browser row. Use it
  // only when it is explicitly season-wide; selected-team evidence remains a
  // descriptive context field and never becomes a rotation target.
  const responsibility = readResponsibilityEvidence(player);
  if (responsibility?.scope === "season-wide" && responsibility.games > 0) {
    return Math.min(48, responsibility.minutes / responsibility.games);
  }
  return Math.min(48, finiteNonNegative(player?.minutes) ?? 0);
}

/**
 * Read the independently requested usage share. Raising minutes alone leaves
 * that share unchanged. Only a matching conditional minute-response fit may
 * temper above-baseline rates; it is not treated as a causal usage elasticity.
 */
export function projectPlayerResponsibility(
  player,
  metric,
  targetMinutes,
  parameters,
) {
  const sourceMinutes = readSeasonRoleMinutes(player, metric);
  const requestedMinutes = Math.max(0, Number(targetMinutes) || 0);
  const sourceUsage = readPlayerUsage(player);
  // Usage is a separate scenario input, not a function of assigned minutes.
  // A catch-and-finish center can play 36 minutes at the same usage as at 12.
  // Requesting star-like responsibility must be explicit (or unit-dependent).
  const requestedUsage = finiteNonNegative(parameters?.offensiveResponsibilities?.[player.id]);
  const targetUsage = requestedUsage !== null && requestedUsage <= 1 ? requestedUsage : sourceUsage;
  const expansionShare = requestedMinutes > 0 && sourceMinutes !== null
    ? Math.max(0, requestedMinutes - sourceMinutes) / requestedMinutes
    : 0;

  const expansion = responsibilityExpansionFor(player, metric, parameters);
  const hasChronologicalFit = expansion.source === "chronological-workload-fit";
  if (sourceMinutes !== null && (expansion.strength > 0 || hasChronologicalFit)) {
    return {
      available: true, source: expansion.source, sourceMinutes,
      targetMinutes: requestedMinutes, sourceUsage, targetUsage,
      usageRatio: sourceUsage > 0 && targetUsage !== null ? targetUsage / sourceUsage : null, expansionShare,
      rateRetention: expansion.strength > 0
        ? workloadRetention(sourceMinutes, requestedMinutes, expansion.strength)
        : 1,
      expansionStrength: expansion.strength,
      responsibilityEvidence: expansion.evidence,
      responsibilityReliability: expansion.reliability,
      responsibilityPriorMinutes: expansion.priorMinutes,
      evidenceGrade: hasChronologicalFit
        ? "conditional-prediction" : "responsibility-prior",
      reason: hasChronologicalFit
        ? "Workload response fitted on earlier games and evaluated on later games. Zero decline is allowed; this is not a causal fatigue estimate."
        : "A disclosed responsibility prior tempers an above-baseline rate outside the player's observed role. It is evidence-gated sensitivity, not a causal usage or fatigue estimate.",
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
    expansionStrength: 0,
    responsibilityEvidence: expansion.evidence,
    responsibilityReliability: expansion.reliability,
    responsibilityPriorMinutes: expansion.priorMinutes,
    evidenceGrade: "usage-response-unvalidated",
    reason: expansion.evidence
      ? "Minutes do not set usage. The responsibility prior is disabled for this metric or policy; expanded responsibility remains a separate uncertainty scenario."
      : "Minutes do not set usage. No evidence-gated responsibility prior or validated usage elasticity is available; expanded responsibility is a separate uncertainty scenario.",
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
