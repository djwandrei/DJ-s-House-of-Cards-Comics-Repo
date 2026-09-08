// Private package -> bounded presentation contract. Never spread archive rows
// into responses: identities, fitted effects and coefficients stay here.
import { scoutContextDescriptor } from '../../tools/scout-studio/context-contract.js';
export { SCOUT_CONTEXT_GROUPS, scoutContextDescriptor } from '../../tools/scout-studio/context-contract.js';
export const SCOUT_STUDIO_CONTRACT_VERSION = 1;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const round = value => value === null ? null : Math.round(value * 10000) / 10000;
const text = value => typeof value === 'string' && value.trim() && value.length <= 160
  && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value.trim() : 'Unnamed source record';
const ratio = (a, b) => number(a) !== null && number(b) !== null && b > 0 ? round(a / b) : null;
const fraction = (a, b) => count(a) !== null && count(b) !== null && a <= b ? ratio(a, b) : null;

const safeReliabilityGrade = value => ['no_sample', 'insufficient', 'low', 'medium', 'high'].includes(value) ? value : null;
export function describeScoutContexts(contexts, { maxRows = 64 } = {}) {
  if (contexts === null || contexts === undefined) return [];
  if (typeof contexts !== 'object' || Array.isArray(contexts)) throw new Error('Scout context map is invalid.');
  const entries = Object.entries(contexts).map(([key, metric]) => {
    const descriptor = scoutContextDescriptor(key);
    return descriptor ? { descriptor, metric } : null;
  }).filter(Boolean);
  if (entries.length > maxRows) throw new Error('Scout context map exceeds the bounded presentation contract.');
  entries.sort((left, right) => left.descriptor.order - right.descriptor.order
    || left.descriptor.key.localeCompare(right.descriptor.key));
  return entries.map(({ descriptor, metric }) => {
    const sample = describeScoutSample(metric);
    const reliabilityScore = number(metric?.reliability?.reliabilityScore);
    return { ...descriptor, ...sample,
      reliabilityGrade: safeReliabilityGrade(metric?.reliability?.grade),
      reliabilityScore: reliabilityScore !== null && reliabilityScore >= 0 && reliabilityScore <= 1 ? round(reliabilityScore) : null };
  });
}

export function describeScoutOnOff(row) {
  const onMinutes = number(row?.onMinutes);
  const offMinutes = number(row?.offMinutes);
  return { onMinutes: onMinutes !== null && onMinutes >= 0 ? round(onMinutes) : null,
    offMinutes: offMinutes !== null && offMinutes >= 0 ? round(offMinutes) : null,
    on: describeScoutContexts(row?.on), off: describeScoutContexts(row?.off),
    note: 'On/off context rows are descriptive same-game partitions. Different teammates, opponents, roles and situations can contribute; no causal player effect is inferred.' };
}

export function describeScoutTeamContexts(row) {
  return describeScoutContexts(row?.contexts).map(context => {
    const metric = row.contexts[context.key];
    const outcomes = Object.fromEntries(['offense', 'defense'].map(side => {
      const raw = metric?.possessionOutcomes?.[side];
      return [side, { possessions: count(raw?.totalPossessions),
        points: count(metric?.[side === 'offense' ? 'offensivePointsFor' : 'defensivePointsAllowed']),
        counts: Object.fromEntries(['empty', 'one', 'two', 'three', 'fourPlus'].map(key => [key, count(raw?.[key])])) }];
    }));
    return { ...context, outcomes };
  });
}

export function describeScoutPlayer(row, id) {
  const coverage = row.coverage || {};
  const box = row.boxScore || {};
  const shooting = row.shooting || {};
  const possessions = number(row.teamPossessionsWhileOnCourt);
  const recognized = count(coverage.recognizedStatisticRows);
  const exposureAvailable = recognized > 0 && possessions > 0 && number(row.minutes) > 0;
  const fieldGoalsComplete = coverage.unknownFieldGoalMadeStatus === 0
    && coverage.unclassifiedFieldGoalAttempts === 0 && coverage.unclassifiedFieldGoalMakes === 0;
  const freeThrowsComplete = coverage.unknownFreeThrowMadeStatus === 0;
  const metrics = [];
  const add = (key, label, family, unit, value, numerator, denominator, method, eligible = true) => {
    const valid = eligible && exposureAvailable && number(value) !== null && denominator > 0;
    metrics.push({ key, label, family, unit, value: valid ? value : null,
      numerator: count(numerator), denominator: number(denominator),
      status: valid ? 'observed' : 'unavailable', method });
  };
  add('threePointAccuracy', 'Three-point accuracy', 'Shooting', 'percent',
    fraction(box.threePointersMade, box.threePointAttempts), box.threePointersMade, box.threePointAttempts,
    'Made threes / three-point attempts. Accuracy is not spacing or gravity.', fieldGoalsComplete);
  add('threePointFrequency', 'Three-point frequency', 'Shooting', 'percent',
    fraction(box.threePointAttempts, box.fieldGoalAttempts), box.threePointAttempts, box.fieldGoalAttempts,
    'Three-point attempts / all field-goal attempts.', coverage.unclassifiedFieldGoalAttempts === 0);
  add('freeThrowAccuracy', 'Free-throw accuracy', 'Shooting', 'percent',
    fraction(box.freeThrowsMade, box.freeThrowAttempts), box.freeThrowsMade, box.freeThrowAttempts,
    'Made free throws / free-throw attempts.', freeThrowsComplete);
  for (const [key, label, family, eligible] of [
    ['points', 'Scoring production', 'Scoring', coverage.scoringComplete === true],
    ['assists', 'Recorded assists', 'Playmaking', true],
    ['turnovers', 'Recorded turnovers', 'Playmaking', true],
    ['rebounds', 'Recorded rebounds', 'Rebounding', coverage.reboundsComplete === true],
    ['steals', 'Recorded steals', 'Disruption', true],
    ['blocks', 'Recorded blocks', 'Disruption', true],
    ['foulsDrawn', 'Recorded fouls drawn', 'Rim pressure', true],
  ]) {
    const total = count(box[key]);
    add(key, label, family, 'per100', total === null ? null : ratio(total * 100, possessions), total, possessions,
      'Per 100 estimated team possessions while on court (half of both-side exposure). Descriptive, not a workload forecast.', eligible);
  }
  const fga = count(box.fieldGoalAttempts);
  const zones = [
    ['atRim', 'At rim (0–4 ft)'], ['shortMidRange', 'Short mid-range (5–14 ft)'],
    ['longMidRange', 'Long mid-range (15+ ft, twos only)'],
  ].map(([key, label]) => {
    const zone = shooting.shotZones?.[key];
    const attempts = count(zone?.attempts), makes = count(zone?.makes);
    return { key, label, attempts, makes,
      accuracy: exposureAvailable && zone?.unknownMadeStatus === 0 ? fraction(makes, attempts) : null,
      shareOfAllAttempts: exposureAvailable ? fraction(attempts, fga) : null };
  });
  const knownZoneAttempts = zones.every(zone => zone.attempts !== null)
    ? zones.reduce((sum, zone) => sum + zone.attempts, 0) : null;
  const twoPa = count(box.twoPointAttempts);
  const unlocatedTwoPointAttempts = knownZoneAttempts !== null && twoPa !== null && knownZoneAttempts <= twoPa
    ? twoPa - knownZoneAttempts : null;
  const labels = [];
  // Shot descriptions are optional provider labels, never inferred play calls.
  for (const [label, source] of Object.entries(shooting.providerShotDescriptionProfile || {})) {
    if (!/^[a-z0-9_ -]{1,64}$/i.test(label)) continue;
    const attempts = count(source?.attempts), makes = count(source?.makes);
    if (attempts === null || fga === null || attempts > fga) continue;
    labels.push({ label: label.replaceAll('_', ' '), attempts,
      shareOfAllAttempts: exposureAvailable ? fraction(attempts, fga) : null,
      accuracy: exposureAvailable && source?.unknownMadeStatus === 0 ? fraction(makes, attempts) : null });
  }
  labels.sort((a, b) => b.attempts - a.attempts || a.label.localeCompare(b.label));
  const reconciliation = row.boxScoreTotals?.officialSummaryReconciliation?.status;
  return {
    id, name: text(row.player), games: count(row.gamesAppeared), minutes: number(row.minutes),
    estimatedTeamPossessions: possessions,
    coverage: {
      statistics: ['complete', 'partial'].includes(coverage.status) ? coverage.status : 'unavailable',
      independentBoxScore: reconciliation === 'complete_and_reconciled' ? 'complete_and_reconciled' : 'not_fully_reconciled',
      note: 'Team-specific totals pooled across the full package window, including its eligible competition phases. Not a single-season or career total.',
    },
    metrics,
    tendencies: { fieldGoalAttempts: fga, zones, unlocatedTwoPointAttempts,
      threePointAttempts: count(box.threePointAttempts),
      unclassifiedAttempts: count(coverage.unclassifiedFieldGoalAttempts),
      missingShotDescriptions: count(coverage.missingProviderShotDescription), labels,
      note: 'Zone shares use all field-goal attempts. Unknown distance remains visible; optional shot labels do not establish pick-and-roll roles, defensive assignments or half-court actions.' },
    unavailableSkills: ['Off-ball gravity', 'Screen navigation', 'Switchability', 'Decision speed', 'Defender assignments'],
  };
}

// Compact, public-safe season profile used by the bounded Career view. The
// underlying evidence rows contain event-level fields and correction details;
// only observed production and explicit completeness signals cross this
// boundary.
export function describeScoutSeasonProfile(row) {
  const perGame = row?.perGame || {};
  const rates = row?.officialRates || {};
  const fieldEvidence = row?.fieldEvidence || {};
  const known = key => {
    const evidence = fieldEvidence[key];
    return evidence && Number.isFinite(evidence.effectiveKnownGames)
      ? evidence.effectiveKnownGames : null;
  };
  const metric = (value, evidenceKey) => Number.isFinite(value) && (evidenceKey ? known(evidenceKey) > 0 : true) ? round(value) : null;
  const evidence = key => {
    const item = fieldEvidence[key];
    if (!item || !Number.isFinite(item.effectiveKnownGames)) return null;
    return { knownGames: item.effectiveKnownGames,
      matchedGames: Number.isFinite(item.matchedGames) ? item.matchedGames : null,
      total: Number.isFinite(item.effectiveTotal) ? round(item.effectiveTotal) : null };
  };
  const ratio = (name, value, evidenceKey) => {
    const source = row?.ratios?.[name] || {};
    const numerator = Number.isSafeInteger(source.numerator) && source.numerator >= 0 ? source.numerator : null;
    const denominator = Number.isSafeInteger(source.denominator) && source.denominator >= 0 ? source.denominator : null;
    return { value: metric(value, evidenceKey), numerator, denominator,
      knownGames: known(evidenceKey), status: metric(value, evidenceKey) === null ? 'unavailable' : 'observed' };
  };
  const positions = Array.isArray(row?.listedPositions)
    ? row.listedPositions.filter(value => typeof value === 'string' && value.trim() && value.length <= 20).slice(0, 8)
    : [];
  const scope = row?.teamId === 'ALL_TEAMS' ? 'all-teams' : 'team';
  return {
    seasonStartYear: Number.isInteger(row?.seasonStartYear) ? row.seasonStartYear : null,
    season: Number.isInteger(row?.seasonStartYear) ? `${row.seasonStartYear}–${String(row.seasonStartYear + 1).slice(-2)}` : 'Unknown season',
    phase: text(row?.phase), scope, team: text(row?.team || row?.teamName) || (scope === 'all-teams' ? 'All teams' : null),
    positions,
    firstGameAt: text(row?.firstGameAt), lastGameAt: text(row?.lastGameAt),
    games: count(row?.games), minutes: number(row?.officialMinutes),
    perGame: {
      points: metric(perGame.points, 'points'), assists: metric(perGame.assists, 'assists'),
      rebounds: metric(perGame.rebounds, 'rebounds'), fieldGoalAttempts: metric(perGame.fieldGoalAttempts, 'fieldGoalAttempts'),
      turnovers: metric(perGame.turnovers, 'turnovers'), steals: metric(perGame.steals, 'steals'),
      blocks: metric(perGame.blocks, 'blocks'), personalFouls: metric(perGame.personalFouls, 'personalFouls'),
    },
    shooting: {
      fieldGoalPercentage: metric(rates.fieldGoalPercentage, 'fieldGoalsMade'),
      threePointPercentage: metric(rates.threePointPercentage, 'threePointersMade'),
      freeThrowPercentage: metric(rates.freeThrowPercentage, 'freeThrowsMade'),
      threePointAttemptShare: metric(rates.threePointAttemptShare, 'threePointAttempts'),
    },
    involvement: metric(rates.offensiveInvolvementPer36, 'fieldGoalAttempts'),
    components: {
      fieldGoalAccuracy: ratio('fieldGoalAccuracy', rates.fieldGoalPercentage, 'fieldGoalsMade'),
      threePointAccuracy: ratio('threePointAccuracy', rates.threePointPercentage, 'threePointersMade'),
      threePointFrequency: ratio('threePointAttemptShare', rates.threePointAttemptShare, 'threePointAttempts'),
      freeThrowAccuracy: ratio('freeThrowAccuracy', rates.freeThrowPercentage, 'freeThrowsMade'),
      points: { value: metric(perGame.points, 'points'), unit: 'perGame', ...evidence('points') },
      assists: { value: metric(perGame.assists, 'assists'), unit: 'perGame', ...evidence('assists') },
      turnovers: { value: metric(perGame.turnovers, 'turnovers'), unit: 'perGame', ...evidence('turnovers') },
      rebounds: { value: metric(perGame.rebounds, 'rebounds'), unit: 'perGame', ...evidence('rebounds') },
      steals: { value: metric(perGame.steals, 'steals'), unit: 'perGame', ...evidence('steals') },
      blocks: { value: metric(perGame.blocks, 'blocks'), unit: 'perGame', ...evidence('blocks') },
    },
    completeness: ['points', 'fieldGoalAttempts', 'fieldGoalsMade', 'assists', 'rebounds']
      .map(key => ({ field: key, knownGames: known(key) }))
      .filter(item => item.knownGames !== null),
    note: 'Observed season and phase production from reconciled source rows. This is descriptive history, not a forecast, career projection, or fitted usage response.',
  };
}

export function describeScoutSample(metrics) {
  const offensePossessions = count(metrics?.offensivePossessions);
  const defensePossessions = count(metrics?.defensivePossessions);
  const threshold = count(metrics?.reliability?.thresholds?.publishablePossessions);
  const publishable = metrics?.reliability?.publishable === true && offensePossessions > 0 && defensePossessions > 0
    && threshold > 0 && offensePossessions + defensePossessions >= threshold;
  const rawNet = number(metrics?.netRating);
  const ci = metrics?.confidence95?.netRating;
  const interval = publishable && rawNet !== null && number(ci?.lower) !== null && number(ci?.upper) !== null
    && ci.lower <= rawNet && rawNet <= ci.upper ? { lower: ci.lower, upper: ci.upper } : null;
  return {
    status: !metrics ? 'unavailable' : publishable ? 'observed' : 'insufficient_sample',
    games: count(metrics?.games), offensePossessions, defensePossessions,
    minimumCombinedPossessions: count(metrics?.reliability?.thresholds?.publishablePossessions),
    offensiveRating: publishable ? number(metrics.offensiveRating) : null,
    defensiveRating: publishable ? number(metrics.defensiveRating) : null,
    netRating: publishable ? rawNet : null, interval,
  };
}

export function describeScoutCombination(row) {
  return { kind: row?.size === 5 ? 'exact_five' : 'shared_floor',
    minutes: number(row?.minutes), sample: describeScoutSample(row?.contexts?.all),
    contexts: describeScoutContexts(row?.contexts),
    note: row?.size === 5
      ? 'The verified five at possession start. Descriptive results, not a forecast for a new lineup.'
      : 'Two to four players sharing the floor with other teammates. This is not an isolated unit or a causal chemistry effect.' };
}

export function describeScoutWowy(row) {
  return [
    ['a_on_b_on', 'Together'], ['a_on_b_off', 'First player only'],
    ['a_off_b_on', 'Second player only'], ['a_off_b_off', 'Neither player'],
  ].map(([key, label]) => ({ key, label, ...describeScoutSample(row?.cells?.[key]?.all) }));
}
