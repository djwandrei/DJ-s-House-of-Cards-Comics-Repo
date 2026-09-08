/**
 * Candidate scoring-production model. Private/offline until validated.
 *
 * This separates estimation from exact selection. It does not alter RAPM,
 * choose minutes, or add a hidden score to the deployed Lineup Lab. Points
 * are derived from 2PM, 3PM, and FTM, never forecast independently of them.
 * Observed attempt frequency and conversion skill have DIFFERENT samples:
 * minutes inform frequency; actual attempts inform shooting accuracy.
 */
import { shootingOpportunity, gameClusterStandardError } from '../../prototypes/basketball-lineup-optimizer/projection-evidence.js';

export const SCORING_COMPONENT_VERSION = 'scout-scoring-components-candidate-v1';
export const SHOT_COMPONENTS = Object.freeze({
  twoPoint: Object.freeze({ attempts: 'twoPointAttempts', makes: 'twoPointMakes', points: 2 }),
  threePoint: Object.freeze({ attempts: 'threePointAttempts', makes: 'threePointersMade', points: 3 }),
  freeThrow: Object.freeze({ attempts: 'freeThrowAttempts', makes: 'freeThrowsMade', points: 1 }),
});
const FIELDS = ['points', 'fieldGoalAttempts', 'fieldGoalsMade', ...Object.values(SHOT_COMPONENTS).flatMap(row => [row.attempts, row.makes])];
const PHASES = ['regular', 'in_season_tournament', 'play_in', 'playoffs'];
// These are disclosed starting candidates, NOT fitted six-season parameters.
// The always-present Jeffreys half-success/half-failure prior prevents a 1/1
// sample (or a 0/1 sample) from implying certain shooting skill.
const DEFAULT_PRIOR_ATTEMPTS = Object.freeze({ twoPoint: 200, threePoint: 180, freeThrow: 100 });
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

function utcDay(value) {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'An explicit ISO game timestamp is required.');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  requireThat(date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    && Number.isFinite(Date.parse(value)), 'Invalid game calendar date.');
  return new Date(value).toISOString().slice(0, 10);
}

function matchingScope(row, scope) {
  return row?.seasonStartYear === scope.seasonStartYear && row.phase === scope.phase;
}

/**
 * The entire scoring family uses ONE jointly reconciled subset. Combining
 * 2PA from one set of games with 3PA/FTA from another can break FG and points
 * identities, even if each independent column looks individually complete.
 * Missing steals do not discard a valid scoring line; a corrected shooting
 * field, however, cannot masquerade as independent training evidence.
 */
export function scoringObservation(row) {
  const reasons = [];
  const box = row?.officialTotals, pbp = row?.pbpTotals;
  const exposure = row?.rateExposure;
  if (row?.minutesReconciled !== true || !finite(row?.officialMinutes) || row.officialMinutes <= 0
    || !finite(row?.minutes) || Math.abs(row.minutes - row.officialMinutes) > 5 / 60 + 1e-9
    || exposure?.officialPer36Minutes !== row.officialMinutes || exposure?.pbpPer36Minutes !== row.officialMinutes) reasons.push('unverified-full-game-minutes');
  if (![row?.officialIdentityIssues, row?.pbpIdentityIssues].every(issues => Array.isArray(issues) && issues.length === 0)) reasons.push('box-identity-not-verified');
  const missing = FIELDS.filter(field => !count(box?.[field]) || !count(pbp?.[field])
    || box[field] !== pbp[field] || row?.fieldReconciliation?.[field] !== 'matched');
  if (missing.length) reasons.push('incomplete-or-unreconciled-scoring-fields');
  const corrected = (row?.sourceCorrections ?? []).filter(correction => FIELDS.includes(correction.field));
  if (corrected.length) reasons.push('user-correction-is-not-independent-evidence');
  if (!missing.length && (box.fieldGoalAttempts !== box.twoPointAttempts + box.threePointAttempts
    || box.fieldGoalsMade !== box.twoPointMakes + box.threePointersMade
    || box.points !== 2 * box.twoPointMakes + 3 * box.threePointersMade + box.freeThrowsMade
    || Object.values(SHOT_COMPONENTS).some(({ attempts, makes }) => box[makes] > box[attempts]))) reasons.push('inconsistent-scoring-identities');
  return { available: reasons.length === 0, reasons, missingFields: missing,
    minutes: reasons.length ? null : row.officialMinutes,
    totals: reasons.length ? null : Object.fromEntries(FIELDS.map(field => [field, box[field]])) };
}

function emptyBank() {
  const moments = () => ({ games: 0, outcomeTotal: 0, exposureTotal: 0, outcomeSquared: 0, outcomeExposure: 0, exposureSquared: 0 });
  return { games: 0, minutes: 0, components: Object.fromEntries(Object.keys(SHOT_COMPONENTS).map(key => [key,
    { attempts: 0, makes: 0, gameMoments: moments(), accuracyMoments: moments() }])) };
}

function addMoment(moment, outcome, exposure) {
  if (!(exposure > 0)) return;
  moment.games++; moment.outcomeTotal += outcome; moment.exposureTotal += exposure;
  moment.outcomeSquared += outcome * outcome; moment.outcomeExposure += outcome * exposure;
  moment.exposureSquared += exposure * exposure;
}

function accumulate(bank, observation) {
  bank.games++; bank.minutes += observation.minutes;
  for (const [key, fields] of Object.entries(SHOT_COMPONENTS)) {
    const value = bank.components[key], attempts = observation.totals[fields.attempts], minutes = observation.minutes;
    value.attempts += attempts; value.makes += observation.totals[fields.makes];
    requireThat(count(value.attempts) && count(value.makes) && finite(bank.minutes), 'Aggregate scoring evidence exceeds safe numeric precision.');
    // Zero-attempt appearances still inform shot FREQUENCY. They do not add
    // imaginary shooting trials to the separate accuracy posterior below.
    addMoment(value.gameMoments, attempts, minutes);
    addMoment(value.accuracyMoments, observation.totals[fields.makes], attempts);
  }
}

function verifyIdentities(rows) {
  const seen = new Set(), games = new Map();
  for (const row of rows) {
    requireThat(['gameId', 'playerId', 'teamId'].every(key => typeof row[key] === 'string' && row[key].trim() === row[key] && row[key].length), 'Missing player/game/team identity.');
    const identity = JSON.stringify([row.gameId, row.playerId]);
    requireThat(!seen.has(identity), 'Duplicate player-game, including a conflicting second team.');
    seen.add(identity);
    const date = utcDay(row.scheduledAt), previous = games.get(row.gameId);
    requireThat(!previous || previous === row.scheduledAt, 'One game has conflicting timestamps.');
    games.set(row.gameId, row.scheduledAt);
    requireThat(date.length === 10, 'Invalid game day.');
  }
}

function emptyCoverage() {
  return { consideredPlayerGames: 0, acceptedPlayerGames: 0, omittedPlayerGames: 0, acceptedMinutes: 0,
    firstUtcDay: null, lastUtcDay: null, reasons: {}, missingFields: {} };
}

function recordCoverage(coverage, row, observation) {
  const day = utcDay(row.scheduledAt);
  coverage.consideredPlayerGames++;
  coverage.firstUtcDay = coverage.firstUtcDay === null || day < coverage.firstUtcDay ? day : coverage.firstUtcDay;
  coverage.lastUtcDay = coverage.lastUtcDay === null || day > coverage.lastUtcDay ? day : coverage.lastUtcDay;
  if (observation.available) { coverage.acceptedPlayerGames++; coverage.acceptedMinutes += observation.minutes; }
  else {
    coverage.omittedPlayerGames++;
    for (const reason of observation.reasons) coverage.reasons[reason] = (coverage.reasons[reason] || 0) + 1;
    for (const field of observation.missingFields) coverage.missingFields[field] = (coverage.missingFields[field] || 0) + 1;
  }
}

function playerEvidence(fit, playerId) {
  const entry = fit.playerCoverage.get(playerId);
  if (!entry) return null;
  // Copy this descriptive metadata: callers must not mutate the source fit
  // when annotating a report. "Complete" refers ONLY to supplied pre-cutoff
  // appearances, not proof that a caller downloaded every scheduled game.
  const snapshot = coverage => ({ ...coverage, reasons: { ...coverage.reasons }, missingFields: { ...coverage.missingFields } });
  const { teams, ...overall } = entry;
  return { ...snapshot(overall), allSuppliedScoringLinesAccepted: entry.omittedPlayerGames === 0,
    teams: Object.fromEntries([...teams].map(([teamId, coverage]) => [teamId, snapshot(coverage)])),
    interpretation: 'Same-season/phase, all-team pre-cutoff appearances. Rejected lines remain visible; accepted totals are a subset, not a certified complete season.' };
}

/** Fit only from the explicitly named season/phase and dates BEFORE cutoff. */
export function fitScoringComponents(rows, scope, { accuracyPriorAttempts = DEFAULT_PRIOR_ATTEMPTS, frequencyPriorMinutes = 60 } = {}) {
  requireThat(Array.isArray(rows) && typeof scope?.sourceRevision === 'string' && scope.sourceRevision.trim().length
    && Number.isInteger(scope.seasonStartYear) && PHASES.includes(scope.phase), 'Explicit source revision, season, phase, and player-game rows are required.');
  requireThat(/^\d{4}-\d{2}-\d{2}$/.test(scope.trainingBeforeUtcDay ?? ''), 'Training cutoff must be an explicit UTC day.');
  utcDay(`${scope.trainingBeforeUtcDay}T00:00:00Z`);
  requireThat(accuracyPriorAttempts && Object.keys(accuracyPriorAttempts).length === 3
    && Object.keys(SHOT_COMPONENTS).every(key => finite(accuracyPriorAttempts[key]) && accuracyPriorAttempts[key] >= 0 && accuracyPriorAttempts[key] <= 10000), 'Provide all three accuracy priors as nonnegative attempt counts through 10000.');
  requireThat(finite(frequencyPriorMinutes) && frequencyPriorMinutes >= 0 && frequencyPriorMinutes <= 10000, 'Frequency regularization must be an explicit nonnegative minute strength through 10000.');
  const scoped = rows.filter(row => matchingScope(row, scope));
  verifyIdentities(scoped);
  const players = new Map(), playerCoverage = new Map(), league = emptyBank(), sourceGameIds = new Set();
  const coverage = { suppliedRows: rows.length, outsideScope: rows.length - scoped.length, atOrAfterCutoff: 0,
    acceptedPlayerGames: 0, omittedPlayerGames: 0, reasons: {} };
  for (const row of scoped) {
    if (utcDay(row.scheduledAt) >= scope.trainingBeforeUtcDay) { coverage.atOrAfterCutoff++; continue; }
    sourceGameIds.add(row.gameId);
    const observation = scoringObservation(row);
    // Keep missingness BEFORE excluding an unusable line. A valid game on a
    // player's new team must not conceal an unreconciled line on the old team.
    // Membership counts describe evidence; they never set assigned minutes.
    const coverageEntry = playerCoverage.get(row.playerId) ?? { ...emptyCoverage(), teams: new Map() };
    const teamCoverage = coverageEntry.teams.get(row.teamId) ?? emptyCoverage();
    recordCoverage(coverageEntry, row, observation); recordCoverage(teamCoverage, row, observation);
    coverageEntry.teams.set(row.teamId, teamCoverage); playerCoverage.set(row.playerId, coverageEntry);
    if (!observation.available) {
      coverage.omittedPlayerGames++;
      for (const reason of observation.reasons) coverage.reasons[reason] = (coverage.reasons[reason] || 0) + 1;
      continue;
    }
    const bank = players.get(row.playerId) ?? emptyBank();
    accumulate(bank, observation); accumulate(league, observation);
    players.set(row.playerId, bank); coverage.acceptedPlayerGames++;
  }
  return { version: SCORING_COMPONENT_VERSION, status: 'candidate-unvalidated', scope: { ...scope },
    parameters: { accuracyPriorAttempts: { ...accuracyPriorAttempts }, frequencyPriorMinutes, weakPrior: 'Jeffreys-Beta(0.5,0.5)' },
    players, playerCoverage, league, sourceGameIds, coverage,
    interpretation: 'Jointly reconciled scoring subsets; same-season/phase leave-player-out priors. Caller-supplied revision is not proof of package validation. No causal workload response or production deployment.' };
}

function accuracyPosterior(fit, bank, key) {
  const observed = bank.components[key], rest = fit.league.components[key];
  // Leave this player's own attempts OUT of the empirical prior. Otherwise
  // the same 1-for-1 sample can count once as evidence and again as baseline.
  const otherAttempts = rest.attempts - observed.attempts, otherMakes = rest.makes - observed.makes;
  const baseline = otherAttempts > 0 ? otherMakes / otherAttempts : null;
  // A small comparison pool cannot supply hundreds of independent trials.
  // The configured strength is an upper limit, capped by actual OTHER-player
  // attempts. This is still empirical Bayes, not a fully learned hierarchy.
  const prior = baseline === null ? 0 : Math.min(fit.parameters.accuracyPriorAttempts[key], otherAttempts);
  if (observed.attempts === 0 && prior === 0) return { mean: null, standardError: null, baseline,
    comparisonPoolAttempts: otherAttempts, requestedPriorAttempts: fit.parameters.accuracyPriorAttempts[key], empiricalPriorAttempts: 0, observedAttempts: 0 };
  const alpha = observed.makes + .5 + prior * (baseline ?? 0);
  const beta = observed.attempts - observed.makes + .5 + prior * (1 - (baseline ?? 0));
  const total = alpha + beta;
  const betaStandardError = Math.sqrt(alpha * beta / (total * total * (total + 1)));
  const rawClusterError = gameClusterStandardError(observed.accuracyMoments);
  const clusterStandardError = rawClusterError === null ? null : observed.attempts / total * rawClusterError;
  // Games can be more variable than independent shot trials. Retain the
  // larger reserve, not the sum (which would count the same noise twice).
  // This still omits serial dependence and uncertainty in the league prior;
  // it is a working sensitivity measure, never a calibrated prediction band.
  return { mean: alpha / total, standardError: Math.max(betaStandardError, clusterStandardError ?? 0),
    betaStandardError, clusterStandardError,
    baseline, comparisonPoolAttempts: otherAttempts, requestedPriorAttempts: fit.parameters.accuracyPriorAttempts[key],
    empiricalPriorAttempts: prior, observedAttempts: observed.attempts };
}

function totalsFromComponents(components, prefix) {
  const quantity = (key, field) => components[key][`${prefix}${field}`];
  const two = quantity('twoPoint', 'Makes'), three = quantity('threePoint', 'Makes'), free = quantity('freeThrow', 'Makes');
  const twoAttempts = quantity('twoPoint', 'Attempts'), threeAttempts = quantity('threePoint', 'Attempts'), freeAttempts = quantity('freeThrow', 'Attempts');
  const sum = values => values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;
  const fieldGoalAttempts = sum([twoAttempts, threeAttempts]), fieldGoalsMade = sum([two, three]);
  const points = sum([two === null ? null : 2 * two, three === null ? null : 3 * three, free]);
  return { twoPointAttempts: twoAttempts, twoPointMakes: two, threePointAttempts: threeAttempts, threePointersMade: three,
    freeThrowAttempts: freeAttempts, freeThrowsMade: free, fieldGoalAttempts, fieldGoalsMade, points,
    fieldGoalPercentage: fieldGoalAttempts > 0 && fieldGoalsMade !== null ? fieldGoalsMade / fieldGoalAttempts : null,
    effectiveFieldGoalPercentage: fieldGoalAttempts > 0 && fieldGoalsMade !== null && three !== null ? (fieldGoalsMade + .5 * three) / fieldGoalAttempts : null };
}

/**
 * Conditional scoring at USER minutes and, optionally, USER shot rates.
 * Without an override, use exposure-regularized observed attempt frequency:
 * an NBA-average prior must not manufacture three-point volume for someone
 * with no observed 3PA. A/(M+k) is a zero-centered rate regularizer, not extra
 * observed minutes, an inferred usage rate, or a complete Bayesian count model.
 * k=60 is a DISCLOSED CANDIDATE, not a validated NBA stabilization threshold.
 * Held-out selection must compare it with k=0 and other declared strengths.
 * Giving a reserve more minutes scales exposure, not sample size or usage.
 * Increased shot demand is flagged as extrapolation; no unvalidated causal
 * accuracy decline is imposed. Such a response needs an independently tested
 * fit. The optional downside calculation is sensitivity, not a confidence band.
 */
export function projectScoringComponents(fit, playerId, { minutes, attemptsPer36 = {}, riskWeight = 0 } = {}) {
  requireThat(fit?.version === SCORING_COMPONENT_VERSION && fit.players instanceof Map, 'A matching component fit is required.');
  requireThat(finite(minutes) && minutes >= 0 && minutes <= 48, 'Requested regulation minutes must be from 0 to 48.');
  requireThat(finite(riskWeight) && riskWeight >= 0 && riskWeight <= 3, 'Risk weight must be from 0 to 3.');
  requireThat(attemptsPer36 && typeof attemptsPer36 === 'object' && !Array.isArray(attemptsPer36)
    && Object.entries(attemptsPer36).every(([key, value]) => Object.hasOwn(SHOT_COMPONENTS, key) && finite(value) && value >= 0 && value <= 100), 'Shot-rate scenarios require supported categories and finite attempts per 36 from 0 to 100.');
  const bank = fit.players.get(playerId);
  const evidence = playerEvidence(fit, playerId);
  if (!bank) return { available: false, evidence, reason: 'No independently reconciled training scoring line for this player; no legacy/average substitution.' };
  const components = {};
  for (const key of Object.keys(SHOT_COMPONENTS)) {
    const row = bank.components[key], posterior = accuracyPosterior(fit, bank, key);
    const opportunity = shootingOpportunity({ sample: row.attempts, minutes: bank.minutes, opportunityGameMoments: row.gameMoments }, riskWeight);
    const scenarioProvided = Object.hasOwn(attemptsPer36, key);
    const frequencyReliability = bank.minutes / (bank.minutes + fit.parameters.frequencyPriorMinutes);
    const estimatedPer36 = opportunity.observedPer36 * frequencyReliability;
    const rate = scenarioProvided ? attemptsPer36[key] : estimatedPer36;
    // An explicit volume is a condition, not noisy evidence to silently reduce.
    // With no override, the existing actual-count/game-cluster reserve checks
    // whether a high per-36 frequency has enough observations to earn credit.
    const decisionRate = scenarioProvided ? rate : opportunity.decisionPer36 * frequencyReliability;
    const meanAttempts = rate * minutes / 36, decisionAttempts = decisionRate * minutes / 36;
    const lowerAccuracy = posterior.mean === null ? null : Math.max(0, posterior.mean - riskWeight * posterior.standardError);
    components[key] = { observedAttempts: row.attempts, observedMinutes: bank.minutes, observedGames: bank.games,
      observedAttemptsPer36: opportunity.observedPer36, requestedAttemptsPer36: rate, scenarioProvided,
      estimatedAttemptsPer36: estimatedPer36, frequencyRegularizationMinutes: fit.parameters.frequencyPriorMinutes,
      frequencyReliability, frequencyParametersFitted: false,
      outsideObservedRate: scenarioProvided && rate > opportunity.observedPer36 + 1e-9,
      priorOnlyAccuracy: row.attempts === 0 && posterior.mean !== null, accuracy: posterior,
      meanAttempts, meanMakes: meanAttempts === 0 ? 0 : posterior.mean === null ? null : meanAttempts * posterior.mean,
      decisionAttempts, decisionMakes: decisionAttempts === 0 ? 0 : lowerAccuracy === null ? null : decisionAttempts * lowerAccuracy };
  }
  const mean = totalsFromComponents(components, 'mean'), decision = totalsFromComponents(components, 'decision');
  return { available: mean.points !== null, version: fit.version, sourceRevision: fit.scope.sourceRevision,
    playerId, minutes, riskWeight, evidence, components, mean, decision,
    productionUnits: 'expected counts at supplied minutes and shot rates; fractional expected makes are intentional',
    calibrated: false, causalUsageResponse: false, measuredUsageShare: null,
    warnings: [
      ...(evidence.omittedPlayerGames > 0 ? ['Some supplied appearances failed independent scoring checks. This estimate uses only the accepted subset; per-team gaps are retained in evidence.'] : []),
      ...(Object.values(components).some(row => row.outsideObservedRate) ? ['Requested shooting demand exceeds observed frequency; no validated difficulty-response fit is available.'] : []),
      ...(Object.values(components).some(row => row.priorOnlyAccuracy && row.meanAttempts > 0) ? ['A requested shot type has prior-only accuracy, not observed player skill.'] : []),
      'Downside totals are sensitivity scenarios, not calibrated forecast intervals. Component correlations and unseen-lineup effects remain unmodeled.',
    ] };
}

/** Held-out evaluation plumbing; invoking this is separate from fitting. */
export function evaluateScoringComponents(fit, rows, { conditionOnObservedAttempts = false } = {}) {
  requireThat(fit?.version === SCORING_COMPONENT_VERSION && fit.players instanceof Map && fit.sourceGameIds instanceof Set, 'A matching component fit is required.');
  requireThat(Array.isArray(rows) && typeof conditionOnObservedAttempts === 'boolean', 'Explicit evaluation rows and conditioning mode are required.');
  const scoped = rows.filter(row => matchingScope(row, fit.scope));
  verifyIdentities(scoped);
  requireThat(scoped.every(row => utcDay(row.scheduledAt) >= fit.scope.trainingBeforeUtcDay && !fit.sourceGameIds.has(row.gameId)), 'Evaluation must use unseen games on UTC days after all training observations.');
  const result = { status: 'evaluation-not-promotion', mode: conditionOnObservedAttempts ? 'conversion-conditional-on-realized-attempts' : 'production-conditional-on-realized-minutes',
    sourceRevision: fit.scope.sourceRevision, considered: scoped.length, reconciledTargets: 0, accepted: 0, excluded: {},
    points: { squaredError: 0, absoluteError: 0, mse: null, mae: null },
    components: Object.fromEntries(Object.keys(SHOT_COMPONENTS).map(key => [key, { attempts: 0, unavailableAccuracyAttempts: 0, conversionBrierSum: 0, conversionBrier: null }])),
    interpretation: 'No prediction of minutes. Conditional-attempt evaluation is not evidence of shot-volume forecasting or causal usage response.' };
  for (const row of scoped) {
    const observation = scoringObservation(row);
    const reject = reason => { result.excluded[reason] = (result.excluded[reason] || 0) + 1; };
    if (!observation.available) { reject('unreconciled-target'); continue; }
    result.reconciledTargets++;
    // Evaluation can contain overtime appearances beyond regulation. Preserve
    // their actual exposure by computing one-minute rates and scaling outside
    // the scenario UI's regulation limit; never truncate source minutes to 48.
    const prediction = projectScoringComponents(fit, row.playerId, { minutes: 1 });
    // Conversion coverage is independent of complete points coverage. A new
    // shot type with unknown accuracy must remain visible, not remove that
    // player's known shot types from Brier scoring and make results look better.
    // Unknown players also contribute unavailable attempts, rather than simply
    // disappearing from the accuracy evaluation denominator report.
    for (const [key, fields] of Object.entries(SHOT_COMPONENTS)) {
      const probability = prediction.components?.[key]?.accuracy.mean ?? null;
      const attempts = row.officialTotals[fields.attempts], makes = row.officialTotals[fields.makes], entry = result.components[key];
      if (probability === null) { entry.unavailableAccuracyAttempts += attempts; continue; }
      entry.attempts += attempts;
      entry.conversionBrierSum += makes * (1 - probability) ** 2 + (attempts - makes) * probability ** 2;
    }
    if (!prediction.available) { reject('unavailable-player-prediction'); continue; }
    // Conditional-attempt evaluation uses actual counts directly. One shot in
    // a few recorded seconds can imply an enormous per-36 rate; passing that
    // rate through a user-control limit would selectively discard tiny samples.
    // Do not use observed makes or points as predictors of their own targets.
    let predictedPoints = prediction.mean.points * row.officialMinutes;
    if (conditionOnObservedAttempts) {
      const contributions = Object.entries(SHOT_COMPONENTS).map(([key, fields]) => {
        const attempts = row.officialTotals[fields.attempts], probability = prediction.components[key].accuracy.mean;
        return attempts === 0 ? 0 : probability === null ? null : fields.points * attempts * probability;
      });
      predictedPoints = contributions.every(finite) ? contributions.reduce((a, b) => a + b, 0) : null;
    }
    if (predictedPoints === null) { reject('unavailable-conditional-accuracy'); continue; }
    const difference = predictedPoints - row.officialTotals.points;
    result.accepted++; result.points.squaredError += difference * difference; result.points.absoluteError += Math.abs(difference);
  }
  if (result.accepted) { result.points.mse = result.points.squaredError / result.accepted; result.points.mae = result.points.absoluteError / result.accepted; }
  for (const entry of Object.values(result.components)) if (entry.attempts) entry.conversionBrier = entry.conversionBrierSum / entry.attempts;
  return result;
}
