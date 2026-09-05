/**
 * A small, independently testable conditional-rate model. Playing time is an
 * input chosen by the user, NOT a prediction target. We predict production at
 * that exposure. No team identifier, stint games, or roster size is an input.
 *
 * Prior strength controls noisy samples. Expansion strength removes only an
 * unproven advantage when moving outside the player's observed workload. Zero
 * is a legitimate fitted value: the data need not support a universal decline.
 */
export function workloadRetention(sourceMinutes, targetMinutes, strength) {
  if (!(sourceMinutes > 0) || !(targetMinutes > sourceMinutes) || !(strength > 0)) return 1;
  return Math.exp(-strength * (targetMinutes - sourceMinutes) / sourceMinutes);
}

export function workloadRate({ value, baseline, sample, prior = 0, sourceMinutes, targetMinutes, strength = 0, lowerIsBetter = false }) {
  if (![value, baseline, sample, prior].every(Number.isFinite) || sample < 0 || prior < 0) return null;
  const reliability = sample + prior > 0 ? sample / (sample + prior) : 0;
  const mean = baseline + reliability * (value - baseline);
  const advantage = lowerIsBetter ? mean < baseline : mean > baseline;
  return advantage ? baseline + (mean - baseline) * workloadRetention(sourceMinutes, targetMinutes, strength) : mean;
}

/**
 * Convert a conditional rate into cumulative minute utility. Min-cost flow
 * requires decreasing marginal utility to enforce minute prefixes. Far outside
 * observed support the conditional curve can turn convex; use the running
 * minimum marginal value there as a conservative concave minorant. This guard
 * is separate from the learned response and never changes allowed minutes.
 */
export function workloadUtilityCurve(value, baseline, sourceMinutes, strength, limit = 48) {
  const totals = [0]; let lastMarginal = Infinity, previousPrediction = 0, guardedMinutes = 0;
  for (let minute = 1; minute <= limit; minute++) {
    const rate = workloadRate({ value, baseline, sample: 1, prior: 0, sourceMinutes, targetMinutes: minute, strength });
    const prediction = minute * rate;
    const rawMarginal = prediction - previousPrediction;
    const marginal = Math.min(lastMarginal, rawMarginal);
    if (marginal < rawMarginal - 1e-12) guardedMinutes++;
    totals.push(totals.at(-1) + marginal);
    lastMarginal = marginal; previousPrediction = prediction;
  }
  // For extreme extrapolation (for example a one-minute sample), a concave
  // tangent can eventually imply negative utility. Replace that pathological
  // minorant with the lowest predicted rate over the interval. Its straight
  // line stays nonnegative, concave, and below every conditional prediction;
  // it is deliberately conservative, not a claimed learned fatigue effect.
  if (lastMarginal < 0) {
    const rate = Math.min(...Array.from({ length: limit }, (_, i) => workloadRate({
      value, baseline, sample: 1, prior: 0, sourceMinutes, targetMinutes: i + 1, strength,
    })));
    return { totals: Array.from({ length: limit + 1 }, (_, m) => m * rate), guardedMinutes: limit };
  }
  return { totals, guardedMinutes };
}
