/**
 * Paired statistical evidence and decision uncertainty, independent of minutes
 * chosen by the solver. Never substitute MPG * an imaginary number of games.
 * A missing numerator cannot borrow another team's/season's denominator.
 */
export const RATE_EVIDENCE_VERSION = "paired-evidence-v4-scout-game-variation";
export const SCOUT_GAME_EVIDENCE_VERSION = "scout-paired-player-games-v1";

const SCOUT_METRIC_FIELDS = Object.freeze({
  points: ["points"], rebounds: ["rebounds"], assists: ["assists"],
  steals: ["steals"], blocks: ["blocks"], ballSecurity: ["turnovers"],
  freeThrowAttemptRate: ["fieldGoalAttempts", "freeThrowAttempts"],
  // Use the joint shooting subset, not independently summed FGA/3PA columns
  // with different missing games. The four counts also test two-point algebra.
  efgPct: ["fieldGoalAttempts", "fieldGoalsMade", "threePointAttempts", "threePointersMade"],
  threePct: ["fieldGoalAttempts", "fieldGoalsMade", "threePointAttempts", "threePointersMade"],
});

function verifiedGameMinutes(row) {
  // Workload context has its own independent exposure check. Missing steals
  // should not erase verified minutes, but a guessed clock or ambiguous player
  // identity cannot become the reference role for any production projection.
  return row.minutesReconciled === true
    && typeof row.officialMinutes === "number" && Number.isFinite(row.officialMinutes) && row.officialMinutes > 0
    && row.rateExposure?.officialPer36Minutes === row.officialMinutes
    && [row.officialIdentityIssues, row.pbpIdentityIssues].every(issues => Array.isArray(issues) && issues.length === 0)
    ? row.officialMinutes : null;
}

function emptyGameMoments() {
  return { games: 0, outcomeTotal: 0, exposureTotal: 0,
    outcomeSquared: 0, outcomeExposure: 0, exposureSquared: 0 };
}

function addGameMoment(moments, outcome, exposure) {
  // A zero-attempt game contains frequency evidence, but no accuracy trial.
  // Only positive exposure belongs in the accuracy ratio's effective clusters.
  if (!(exposure > 0)) return;
  moments.games++;
  moments.outcomeTotal += outcome;
  moments.exposureTotal += exposure;
  moments.outcomeSquared += outcome * outcome;
  moments.outcomeExposure += outcome * exposure;
  moments.exposureSquared += exposure * exposure;
}

/**
 * Game-cluster variance of a ratio of totals, expressed in the requested unit.
 * Each game contributes (count - fittedRate * exposure), not one independent
 * trial per minute/shot. Variable opponents and roles can make game-to-game
 * production noisier than a Poisson/binomial model of individual events.
 *
 * This is observational sampling variation, not a learned usage elasticity or
 * calibrated forecast interval. With fewer than two contributing games the
 * between-game estimate is unavailable, NOT zero certainty. It supplements a
 * working event-level reserve; it never replaces it with a smaller reserve.
 */
export function gameClusterStandardError(moments, unit = 1) {
  if (!moments || !Number.isSafeInteger(moments.games) || moments.games < 2
    || ![moments.outcomeTotal, moments.exposureTotal, moments.outcomeSquared,
      moments.outcomeExposure, moments.exposureSquared].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
    || !(moments.exposureTotal > 0) || !(unit > 0) || !Number.isFinite(unit)) return null;
  const rate = moments.outcomeTotal / moments.exposureTotal;
  const residualSquares = moments.outcomeSquared - 2 * rate * moments.outcomeExposure
    + rate * rate * moments.exposureSquared;
  // Allow floating-point cancellation around zero, not inconsistent moments.
  const scale = Math.max(1, moments.outcomeSquared, rate * rate * moments.exposureSquared);
  if (residualSquares < -1e-10 * scale) return null;
  const variance = (moments.games / (moments.games - 1)) * Math.max(0, residualSquares)
    / (moments.exposureTotal * moments.exposureTotal);
  return Math.sqrt(variance) * unit;
}

/**
 * Compile available player-game observations from the NEW Scout modelEvidence
 * contract into the same paired-count interface used by the solver. This can
 * operate on an interrupted package: it neither labels that package complete
 * nor substitutes another release. The caller must name the exact revision,
 * player, season and phase; all-team games in that scope remain together.
 *
 * Each metric gets its OWN joint verified subset and matching minutes. A
 * missing steal must not discard a valid shooting line, but a missing shooting
 * count must not borrow full-season minutes. Reconciliation flags are checked
 * against the actual official/PBP counts, not accepted as standalone proof.
 * No per-100 rate is inferred from the package's partial-lineup possessions.
 * No new usage-response coefficient, causal effect, or RAPM fit is made here.
 */
export function compileScoutPlayerGameEvidence(playerGames, scope) {
  if (!Array.isArray(playerGames) || typeof scope?.playerId !== "string" || !scope.playerId.trim()
    || typeof scope?.sourceRevision !== "string" || !scope.sourceRevision.trim()
    || !Number.isInteger(scope?.seasonStartYear)
    || !["regular", "in_season_tournament", "play_in", "playoffs"].includes(scope?.phase)) {
    throw new Error("Scout game evidence requires rows and an explicit player/season/phase/source revision.");
  }
  const rows = playerGames.filter(row => row?.playerId === scope.playerId
    && row.seasonStartYear === scope.seasonStartYear && row.phase === scope.phase);
  const seen = new Set();
  for (const row of rows) {
    if (!row.gameId || !row.teamId || seen.has(row.gameId)) throw new Error("Duplicate or incomplete Scout player-game identity.");
    seen.add(row.gameId);
  }
  const metrics = {}, coverage = {};
  const exposureRows = rows.filter(row => verifiedGameMinutes(row) !== null);
  const workloadMinutes = exposureRows.reduce((total, row) => total + row.officialMinutes, 0);
  const workload = Object.freeze({ minutes: workloadMinutes, verifiedGames: exposureRows.length,
    minutesPerGame: exposureRows.length ? workloadMinutes / exposureRows.length : null,
    suppliedGames: rows.length, omittedGameIds: rows.filter(row => verifiedGameMinutes(row) === null).map(row => row.gameId),
    sourceRevision: scope.sourceRevision, wholeSeasonCertified: false });
  for (const [metric, fields] of Object.entries(SCOUT_METRIC_FIELDS)) {
    const totals = Object.fromEntries(fields.map(field => [field, 0]));
    let minutes = 0, verifiedGames = 0;
    const omittedGameIds = [];
    const rateGameMoments = emptyGameMoments(), opportunityGameMoments = emptyGameMoments();
    for (const row of rows) {
      const official = row.officialTotals, pbp = row.pbpTotals;
      const validExposure = verifiedGameMinutes(row) !== null;
      const validCounts = fields.every(field => Number.isSafeInteger(official?.[field]) && official[field] >= 0
        && official[field] === pbp?.[field] && row.fieldReconciliation?.[field] === "matched");
      const identitiesChecked = [row.officialIdentityIssues, row.pbpIdentityIssues]
        .every(issues => Array.isArray(issues) && issues.length === 0);
      const shooting = metric === "efgPct" || metric === "threePct" || metric === "freeThrowAttemptRate";
      const validShooting = metric === "freeThrowAttemptRate" || !shooting || (validCounts
        && official.fieldGoalsMade <= official.fieldGoalAttempts
        && official.threePointersMade <= official.threePointAttempts
        && official.threePointersMade <= official.fieldGoalsMade
        && official.threePointAttempts <= official.fieldGoalAttempts
        && official.fieldGoalsMade - official.threePointersMade <= official.fieldGoalAttempts - official.threePointAttempts);
      if (!validExposure || !validCounts || !identitiesChecked || !validShooting) { omittedGameIds.push(row.gameId); continue; }
      verifiedGames++;
      minutes += row.officialMinutes;
      for (const field of fields) totals[field] += official[field];
      const attempts = shooting ? official[metric === "threePct" ? "threePointAttempts" : "fieldGoalAttempts"] : row.officialMinutes;
      const count = metric === "freeThrowAttemptRate" ? official.freeThrowAttempts : metric === "threePct" ? official.threePointersMade : metric === "efgPct"
        ? official.fieldGoalsMade + .5 * official.threePointersMade : official[fields[0]];
      addGameMoment(rateGameMoments, count, attempts);
      if (shooting) addGameMoment(opportunityGameMoments, attempts, row.officialMinutes);
    }
    coverage[metric] = { suppliedGames: rows.length, verifiedGames, omittedGameIds,
      completeWithinSuppliedGames: rows.length > 0 && verifiedGames === rows.length,
      // Supplied rows from a partial package are not a whole-season census.
      wholeSeasonCertified: false };
    if (!verifiedGames || !(minutes > 0) || (metric === "freeThrowAttemptRate" && !(totals.fieldGoalAttempts > 0))) { metrics[metric] = null; continue; }
    const three = metric === "threePct", freeThrowRate = metric === "freeThrowAttemptRate", shooting = three || metric === "efgPct" || freeThrowRate;
    const sample = shooting ? totals[freeThrowRate ? "fieldGoalAttempts" : three ? "threePointAttempts" : "fieldGoalAttempts"] : minutes;
    const numerator = shooting ? (freeThrowRate ? totals.freeThrowAttempts : three ? totals.threePointersMade : totals.fieldGoalsMade + .5 * totals.threePointersMade) : totals[fields[0]];
    metrics[metric] = Object.freeze({ sample, numerator, minutes,
      sampleScope: "scout-verified-player-game-subset", value: shooting ? (sample > 0 ? numerator / sample : 0) : numerator * 36 / minutes,
      ...(shooting ? { secondMomentTotal: freeThrowRate ? totals.freeThrowAttempts : three ? totals.threePointersMade : totals.fieldGoalsMade + 1.25 * totals.threePointersMade,
        participationPer36: sample * 36 / minutes } : {}),
      verifiedGames, suppliedGames: rows.length, sourceRevision: scope.sourceRevision,
      rateGameMoments: Object.freeze(rateGameMoments),
      ...(shooting ? { opportunityGameMoments: Object.freeze(opportunityGameMoments) } : {}),
    });
  }
  return Object.freeze({ version: SCOUT_GAME_EVIDENCE_VERSION,
    scope: Object.freeze({ playerId: scope.playerId, seasonStartYear: scope.seasonStartYear, phase: scope.phase, sourceRevision: scope.sourceRevision }),
    metrics: Object.freeze(metrics), coverage: Object.freeze(coverage), workload,
    interpretation: "Metric-specific independently reconciled game subsets; not a completed package or a fitted usage-response model." });
}

// These are score-unit conventions, NOT fitted shooting/spacing coefficients.
// Keep them named and separate from the user's priority weights and from the
// statistical evidence. Changing one requires a model-version/validation pass.
export const SHOOTING_SCORE_SCALES = Object.freeze({
  threePointAttemptsPer36: 2,
  fieldGoalValuePointsPer36: 4,
});

export function nonnegativeEvidence(value) {
  if (value == null || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Actual counts only. Zero attempts is known non-participation, not a 0% skill estimate. */
export function pairedMetricEvidence(player, metric) {
  if (Object.hasOwn(player?.analytics ?? {}, "scoutPlayerGameEvidence")) {
    const scout = player.analytics.scoutPlayerGameEvidence;
    // Explicit Scout data takes precedence. A missing component must stay
    // missing, not silently revert to older Basketball Reference season totals.
    if (scout?.version !== SCOUT_GAME_EVIDENCE_VERSION || scout.scope?.playerId !== player.id) return null;
    const row = scout.metrics?.[metric];
    if (!row || ![row.sample, row.numerator, row.minutes, row.value].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
      || !(row.minutes > 0) || !Number.isSafeInteger(row.verifiedGames) || row.verifiedGames < 1) return null;
    // The compact transport is an input boundary, not proof of its own truth.
    // Recheck its scope and count/exposure algebra even if the producer was the
    // compiler above. This prevents a stale per-36 value from being combined
    // with a newer sample or a different package revision after serialization.
    const shooting = metric === "threePct" || metric === "efgPct" || metric === "freeThrowAttemptRate";
    if (row.sampleScope !== "scout-verified-player-game-subset"
      || typeof scout.scope.sourceRevision !== "string" || !scout.scope.sourceRevision.trim()
      || row.sourceRevision !== scout.scope.sourceRevision
      || !Number.isSafeInteger(row.suppliedGames) || row.suppliedGames < row.verifiedGames
      || (shooting ? !Number.isSafeInteger(row.sample) : row.sample !== row.minutes)
      || (metric === "efgPct" ? !Number.isSafeInteger(row.numerator * 2) : !Number.isSafeInteger(row.numerator))
      || (metric === "freeThrowAttemptRate" && !(row.sample > 0))
      || (shooting && !["freeThrowAttemptRate", "efgPct"].includes(metric) && row.numerator > row.sample)
      || (metric === "efgPct" && row.numerator > row.sample * 1.5)) return null;
    const expectedValue = shooting ? (row.sample > 0 ? row.numerator / row.sample : 0) : row.numerator * 36 / row.minutes;
    if (Math.abs(row.value - expectedValue) > 1e-10 * Math.max(1, Math.abs(expectedValue))) return null;
    if (shooting && (!Number.isFinite(row.participationPer36)
      || Math.abs(row.participationPer36 - row.sample * 36 / row.minutes) > 1e-10 * Math.max(1, row.participationPer36))) return null;
    return row;
  }
  for (const [totals, scope] of [[player?.analytics?.seasonTotals, "season-wide"], [player?.analytics?.totals, "selected-team-observed"]]) {
    if (!totals) continue;
    const minutes = nonnegativeEvidence(totals.minutes);
    if (!(minutes > 0)) continue;
    if (metric === "threePct" || metric === "efgPct") {
      // Internal box-score identities must hold when all relevant counts are
      // present. Validating FGM <= FGA alone misses impossible two-point lines
      // such as 9/10 FG with 2/8 from three (7 makes on 2 remaining attempts).
      const fga = nonnegativeEvidence(totals.fieldGoalsAttempted);
      const fgm = nonnegativeEvidence(totals.fieldGoalsMade);
      const tpa = nonnegativeEvidence(totals.threePointFieldGoalsAttempted);
      const tpm = nonnegativeEvidence(totals.threePointFieldGoalsMade);
      if ((fga !== null && fgm !== null && fgm > fga)
          || (tpa !== null && tpm !== null && tpm > tpa)
          || (fga !== null && tpa !== null && tpa > fga)
          || (fgm !== null && tpm !== null && tpm > fgm)
          || ([fga, fgm, tpa, tpm].every(value => value !== null)
            && fgm - tpm > fga - tpa)) continue;
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
    if (metric === "freeThrowAttemptRate") {
      const fga = nonnegativeEvidence(totals.fieldGoalsAttempted);
      const fta = nonnegativeEvidence(totals.freeThrowsAttempted);
      if (fga !== null && fta !== null && fga > 0) return { sample: fga, sampleScope: scope, numerator: fta, minutes, value: fta / fga,
        secondMomentTotal: fta, participationPer36: fga * 36 / minutes };
      continue;
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
 * Verified Scout games can add a larger game-cluster sampling reserve. Dependence
 * between games, future opponents and selection effects remain unmodeled.
 */
export function posteriorRate(raw, evidence) {
  const { sample, prior, baseline } = evidence;
  const denominator = sample + prior;
  // With no observations the posterior is exactly the prior. Evaluating
  // 0 * NaN would poison it when the new package correctly reports a missing
  // raw rate, and falling back to an older raw rate would hide that gap.
  const mean = denominator > 0 && sample > 0 ? baseline + sample / denominator * (raw - baseline) : baseline;
  if (evidence.signed || !(denominator > 0)) return { mean, standardError: null };
  const shooting = evidence.metric === "threePct" || evidence.metric === "efgPct";
  const ratioMetric = evidence.metric === "freeThrowAttemptRate";
  let eventStandardError;
  if (shooting) {
    const ceiling = evidence.metric === "threePct" ? 1 : 1.5;
    const priorSecondMoment = ceiling * baseline;
    const secondMoment = (Number(evidence.secondMomentTotal) + prior * priorSecondMoment) / denominator;
    const variance = Number.isFinite(secondMoment) ? Math.max(0, secondMoment - mean * mean) : ceiling * Math.max(0, mean) - mean * mean;
    eventStandardError = Math.sqrt(Math.max(0, variance) / (denominator + 1));
  } else if (ratioMetric) {
    // FTA/FGA is an unbounded rate: free throws can exceed field-goal
    // attempts. Use a Poisson-style event reserve in ratio units instead of
    // treating it like a per-36 counting stat.
    eventStandardError = Math.sqrt(Math.max(0, mean) / denominator);
  } else eventStandardError = Math.sqrt(Math.max(0, mean) * 36 / denominator);
  const moments = evidence.rateGameMoments;
  // Moment totals must describe THIS numerator and denominator. Merging an
  // entire season's moments with a partial metric recreates the trade-gap bug.
  const matchedMoments = moments?.exposureTotal === sample && moments?.outcomeTotal === evidence.numerator;
  const rawClusterError = matchedMoments ? gameClusterStandardError(moments, shooting || ratioMetric ? 1 : 36) : null;
  // The posterior mean is baseline + w*(observed-baseline). Treating the
  // baseline as fixed, the empirical observed-rate variation scales by w.
  // Retain the event/prior working reserve as a floor, not a second penalty
  // to ADD: summing both would count the same observed noise twice.
  const clusterStandardError = rawClusterError === null ? null : sample / denominator * rawClusterError;
  return { mean, standardError: Math.max(eventStandardError, clusterStandardError ?? 0),
    eventStandardError, clusterStandardError,
    clusterEvidenceGames: rawClusterError === null ? 0 : moments.games,
    uncertaintySource: clusterStandardError > eventStandardError ? "verified-game-variation" : "event-prior-working-model",
    calibratedInterval: false };
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
  // The efficiency component is now points above/below average shooting on
  // supported FGA volume, not raw eFG%. Zero is neutral, including no attempts.
  if (metric === "efgPct") return .5 + Math.atan(value / SHOOTING_SCORE_SCALES.fieldGoalValuePointsPer36) / Math.PI;
  const scale = metric.endsWith("Impact") ? 5 : Math.max(.01, baseline || 1);
  const direction = metric === "ballSecurity" ? -1 : 1;
  return .5 + Math.atan(direction * (value - baseline) / scale) / Math.PI;
}

/** Smooth opportunity weighting; no threshold at one arbitrary attempt count. */
export function demonstratedShootingValue(accuracy, participationPer36, metric, baseline = 0,
  observedParticipationPer36 = participationPer36) {
  if (metric !== "threePct" && metric !== "efgPct") return accuracy;
  // Two attempts per 36 is an explicit scaling convention, not an assertion
  // about defensive gravity. Unknown opportunity receives no spacing credit.
  const volume = nonnegativeEvidence(participationPer36) ?? 0;
  // Efficiency rewards surplus points at supported attempt volume, not all
  // scoring again. A 1-for-1 finisher cannot earn a full high-efficiency score;
  // a zero-attempt prior is neutral rather than a measured finishing advantage.
  if (metric === "efgPct") {
    // Do not erase a below-average efficiency penalty by discounting its
    // volume. That would make greater risk aversion IMPROVE a poor shooter's
    // score. Supported volume discounts only positive surplus; deficits keep
    // their observed volume. Both branches meet continuously at zero surplus.
    const exposure = accuracy < baseline
      ? nonnegativeEvidence(observedParticipationPer36) ?? 0 : volume;
    return 2 * (accuracy - baseline) * exposure;
  }
  return accuracy * volume / (volume + SHOOTING_SCORE_SCALES.threePointAttemptsPer36);
}

/**
 * Separate observed shooting frequency from how much volume the decision can
 * safely credit. Inverting (A - lambda*T)/sqrt(lambda*T) = z gives the lower
 * Poisson score bound below. A is ACTUAL attempts and T is matching minutes;
 * multiplying minutes by six never multiplies the sample by six.
 *
 * This is a working count-uncertainty sensitivity, not a calibrated interval
 * for NBA games (attempts are not independent homogeneous Poisson events).
 * No league-rate prior or future role/shot-difficulty response is fabricated.
 * Risk zero returns the observed rate. More evidence at the same rate narrows
 * the reserve; a proven high-frequency reserve can beat a low-frequency star.
 */
export function shootingOpportunity(evidence, risk = .5) {
  const attempts = nonnegativeEvidence(evidence?.sample);
  const minutes = nonnegativeEvidence(evidence?.minutes);
  if (attempts === null || !(minutes > 0)) return { available: false, observedPer36: null, decisionPer36: 0 };
  const observedPer36 = attempts * 36 / minutes;
  const z = nonnegativeEvidence(risk) ?? .5;
  // Algebraically equivalent to ((sqrt(4*A + z*z) - z)/2)^2,
  // but this form avoids catastrophic cancellation at very small A.
  const supportedCount = attempts > 0
    ? (2 * attempts / (Math.sqrt(4 * attempts + z * z) + z)) ** 2 : 0;
  const moments = evidence?.opportunityGameMoments;
  const matchedMoments = moments?.outcomeTotal === attempts && moments?.exposureTotal === minutes;
  const clusterStandardError = matchedMoments ? gameClusterStandardError(moments, 36) : null;
  const eventDecisionPer36 = supportedCount * 36 / minutes;
  const decisionPer36 = Math.min(eventDecisionPer36,
    clusterStandardError === null ? observedPer36 : Math.max(0, observedPer36 - z * clusterStandardError));
  return { available: true, observedPer36, decisionPer36,
    attempts, minutes, reservePer36: observedPer36 - decisionPer36,
    clusterStandardError, clusterEvidenceGames: clusterStandardError === null ? 0 : moments.games,
    uncertaintySource: decisionPer36 < eventDecisionPer36 ? "verified-game-variation" : "poisson-score-working-bound",
    calibratedInterval: false };
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
