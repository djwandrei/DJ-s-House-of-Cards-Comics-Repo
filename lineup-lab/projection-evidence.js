/**
 * Paired statistical evidence and decision uncertainty, independent of minutes
 * chosen by the solver. Never substitute MPG * an imaginary number of games.
 * A missing numerator cannot borrow another team's/season's denominator.
 */
export const RATE_EVIDENCE_VERSION = "paired-evidence-v1";

export function nonnegativeEvidence(value) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Actual counts only. Zero attempts is known non-participation, not a 0% skill estimate. */
export function pairedMetricEvidence(player, metric) {
  for (const [totals, scope] of [[player?.analytics?.seasonTotals, "season-wide"], [player?.analytics?.totals, "selected-team-observed"]]) {
    if (!totals) continue;
    const minutes = nonnegativeEvidence(totals.minutes);
    if (!(minutes > 0)) continue;
    if (metric === "threePct" || metric === "efgPct") {
      const three = metric === "threePct";
      const attempts = nonnegativeEvidence(totals[three ? "threePointFieldGoalsAttempted" : "fieldGoalsAttempted"]);
      const made = nonnegativeEvidence(totals[three ? "threePointFieldGoalsMade" : "fieldGoalsMade"]);
      const threes = nonnegativeEvidence(totals.threePointFieldGoalsMade);
      if (attempts === null || made === null || made > attempts || (!three && (threes === null || threes > made))) continue;
      const numerator = three ? made : made + .5 * threes;
      return { sample: attempts, sampleScope: scope, numerator, minutes,
        value: attempts > 0 ? numerator / attempts : 0,
        // E[X^2] for 0/1/1.5 effective makes; eFG is NOT a binomial proportion.
        secondMomentTotal: three ? made : made + 1.25 * threes,
        participationPer36: attempts * 36 / minutes };
    }
    const field = metric === "ballSecurity" ? "turnovers" : metric === "rebounds" ? "totalRebounds" : metric;
    const numerator = nonnegativeEvidence(totals[field]);
    if (numerator !== null) return { sample: minutes, sampleScope: scope, numerator, minutes, value: numerator * 36 / minutes };
  }
  return null;
}

/**
 * Approximate posterior uncertainty in the SAME units as the mean. Counting
 * events use a Gamma/Poisson working model; shooting uses bounded moments.
 * These are sensitivity scales, not validated player confidence intervals:
 * game dependence, changing opponents and selection effects remain unmodeled.
 */
export function posteriorRate(raw, evidence) {
  const { sample, prior, baseline } = evidence;
  const denominator = sample + prior;
  const mean = denominator > 0 ? baseline + sample / denominator * (raw - baseline) : baseline;
  if (evidence.signed || !(denominator > 0)) return { mean, standardError: null };
  if (evidence.metric === "threePct" || evidence.metric === "efgPct") {
    const ceiling = evidence.metric === "threePct" ? 1 : 1.5;
    const priorSecondMoment = ceiling * baseline;
    const secondMoment = (Number(evidence.secondMomentTotal) + prior * priorSecondMoment) / denominator;
    const variance = Number.isFinite(secondMoment) ? Math.max(0, secondMoment - mean * mean) : ceiling * Math.max(0, mean) - mean * mean;
    return { mean, standardError: Math.sqrt(Math.max(0, variance) / (denominator + 1)) };
  }
  return { mean, standardError: Math.sqrt(Math.max(0, mean) * 36 / denominator) };
}

/**
 * A smooth, league-anchored score instead of cohort ranks. Tiny differences
 * remain tiny when an unrelated player enters/leaves the pool. The scale is a
 * normalization choice, NOT a learned exchange rate or a win probability.
 * BPM stays signed. Spacing earns zero credit without demonstrated attempts.
 */
export function cardinalMetricScore(value, baseline, metric) {
  if (!Number.isFinite(value)) return 0;
  if (metric === "threePct") return value > 0 ? value / (value + Math.max(.01, baseline)) : 0;
  const scale = metric.endsWith("Impact") ? 5 : Math.max(.01, baseline || 1);
  const direction = metric === "ballSecurity" ? -1 : 1;
  return .5 + Math.atan(direction * (value - baseline) / scale) / Math.PI;
}

/** Smooth opportunity weighting; no threshold at one arbitrary attempt count. */
export function demonstratedShootingValue(accuracy, participationPer36, metric) {
  if (metric !== "threePct") return accuracy;
  // Two attempts per 36 is an explicit scaling convention, not an assertion
  // about defensive gravity. Unknown opportunity receives no spacing credit.
  const volume = nonnegativeEvidence(participationPer36) ?? 0;
  return accuracy * volume / (volume + 2);
}

/**
 * Extrapolation widens decision uncertainty; it does NOT pretend to estimate a
 * causal fatigue curve. Offensive responsibility is a separate input, so extra
 * minutes alone never increase a player's requested usage. No hard cap/target
 * is introduced. At zero assigned minutes all contribution is exactly zero.
 */
export function decisionRateAtWorkload({ mean, standardError, sourceMinutes, targetMinutes, sourceUsage, targetUsage, risk = .5, lowerIsBetter = false, signed = false }) {
  const minuteExpansion = sourceMinutes > 0 ? Math.max(1, targetMinutes / sourceMinutes) : 1;
  const usageExpansion = sourceUsage > 0 && targetUsage != null ? Math.max(1, targetUsage / sourceUsage) : 1;
  const reserve = standardError == null ? 0 : risk * standardError * minuteExpansion * usageExpansion;
  const decision = mean + (lowerIsBetter ? reserve : -reserve);
  return { mean, reserve, decision: signed ? decision : Math.max(0, decision), minuteExpansion, usageExpansion,
    interpretation: "Model-based downside sensitivity, not a calibrated prediction interval or a causal fatigue estimate." };
}

/** Nonnegative concave minorant needed by the exact integer min-cost flow. */
export function concaveDecisionCurve(predictions) {
  let marginal = Infinity, guardedMinutes = 0;
  const totals = [0];
  for (let minute = 1; minute < predictions.length; minute++) {
    const raw = predictions[minute] - predictions[minute - 1];
    marginal = Math.min(marginal, raw);
    if (marginal < raw - 1e-12) guardedMinutes++;
    totals.push(totals.at(-1) + marginal);
  }
  if (marginal < 0) {
    const floor = Math.max(0, Math.min(...predictions.slice(1).map((total, i) => total / (i + 1))));
    return { totals: predictions.map((_, minute) => minute * floor), guardedMinutes: predictions.length - 1 };
  }
  return { totals, guardedMinutes };
}
