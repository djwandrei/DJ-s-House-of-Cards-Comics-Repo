import {
  checkChronologicalRapmCalibration,
  checkOffenseDefenseRapmCalibration,
} from '../validate-local-scout-analytics.mjs';

// This is a Lineup Lab integration preflight, NOT another archive validator.
// Reuse the package owner's calibration checks so their metric definitions do
// not drift. The completed package validator remains responsible for replay,
// shard hashes, row reconciliation, player identity, and source provenance.
export const LINEUP_SCOUT_READINESS_VERSION = 'lineup_scout_readiness_v1';
const SOURCE_VALIDATOR = 'sportradar-nba-local-archive-validator-v4';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function sameSeasons(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every(Number.isSafeInteger)
    && [...actual].sort((a, b) => a - b).every((year, index) => year === expected[index]);
}

function checkChronologicalExposure(calibration, label, errors, warnings) {
  // Aggregate metadata cannot prove game-ID disjointness. It can still catch
  // missing/empty test samples, mismatched comparison denominators, and time
  // ranges that contradict the advertised train -> tune -> test ordering.
  const intervals = [];
  for (const name of ['priorSeasonsTraining', 'latestSeasonTraining', 'latestSeasonTuning', 'latestSeasonTest']) {
    const block = calibration?.split?.[name];
    const first = typeof block?.firstScheduledAt === 'string' ? Date.parse(block.firstScheduledAt) : NaN;
    const last = typeof block?.lastScheduledAt === 'string' ? Date.parse(block.lastScheduledAt) : NaN;
    if (!positiveInteger(block?.gameCount) || !Number.isFinite(first) || !Number.isFinite(last) || first > last) {
      errors.push(`${label}: ${name} needs a nonempty, dated game sample.`);
    }
    intervals.push({ first, last });
  }
  for (let index = 1; index < intervals.length; index++) {
    if (intervals[index - 1].last > intervals[index].first) {
      errors.push(`${label}: training, tuning, and test time ranges are out of order.`);
    } else if (intervals[index - 1].last === intervals[index].first) {
      warnings.push(`${label}: a split shares a scheduled timestamp; confirm disjoint game IDs during integration review.`);
    }
  }
  const full = calibration?.test?.fullModel;
  const baseline = calibration?.test?.fixedEffectsBaseline;
  if (!positive(full?.heldOutPossessions) || !positiveInteger(full?.directionalObservationCount)
    || full.heldOutPossessions !== baseline?.heldOutPossessions
    || full.directionalObservationCount !== baseline?.directionalObservationCount) {
    errors.push(`${label}: the test model and baseline need the same nonzero possession/observation sample.`);
  }
}

/**
 * Inspect compact, already-produced metadata without fitting anything or
 * loading the multi-gigabyte team shards. Hashes must be computed from the
 * actual input bytes by the caller, not copied out of a manifest/report.
 *
 * A source archive PASS is not a derived package PASS. A package PASS is not
 * proof of predictive value. Even all three gates passing only permits the
 * next integration review: it does not authorize publishing or silently
 * treating every player's partial box-score evidence as complete.
 */
export function assessLineupScoutReadiness({
  manifest, manifestSha256, packageValidation,
  sourceValidation, sourceValidationSha256, expectedSeasonStartYears,
}) {
  if (!Array.isArray(expectedSeasonStartYears) || expectedSeasonStartYears.length < 2
    || expectedSeasonStartYears.some(year => !Number.isSafeInteger(year) || year < 1947)
    || new Set(expectedSeasonStartYears).size !== expectedSeasonStartYears.length) {
    throw new TypeError('Specify at least two distinct NBA season start years for this multiseason preflight.');
  }
  const seasons = [...expectedSeasonStartYears].sort((a, b) => a - b);
  const latest = seasons.at(-1);
  const errors = [], warnings = [], pending = [];
  for (const [name, value] of Object.entries({ manifest, packageValidation, sourceValidation })) {
    if (value === null || value === undefined) pending.push(`${name} has not been supplied or written yet.`);
    else if (!object(value)) errors.push(`${name} must be a JSON object.`);
  }

  if (object(manifest)) {
    if (manifest.schemaVersion !== 4 || manifest.metricsVersion !== 'nba-scout-metrics-v4') {
      errors.push('Unsupported Scout package schema/metric version; review its contract before adoption.');
    }
    const scope = manifest.scope;
    if (!sameSeasons(scope?.seasonStartYears, seasons) || scope?.seasonStartYear !== seasons[0]
      || scope?.latestSeasonStartYear !== latest || scope?.seasonEndYear !== latest + 1) {
      errors.push('Package scope does not match the requested seasons; an older package is not a substitute.');
    }
    if (manifest.storage?.writeMode !== 'bounded_memory_atomic_team_stream_v1') {
      errors.push('Package does not declare the supported completed, atomic team-shard output format.');
    }
    if (manifest.provenance?.sourceArchiveValidationPassed !== true
      || manifest.provenance?.sourceValidatorVersion !== SOURCE_VALIDATOR) {
      errors.push('Package does not carry the required passed source-archive validation.');
    }
    for (const name of ['net', 'offenseDefense']) {
      const model = manifest.rapm?.[name];
      if (!object(model)) {
        errors.push(`${name}: fitted RAPM model is missing.`);
        continue;
      }
      if (model.seasonEndYear !== latest + 1 || model.solver?.converged !== true) {
        errors.push(`${name}: fitted season or solver convergence is not confirmed.`);
      }
      checkChronologicalRapmCalibration(model.chronologicalCalibration, model, name, latest, errors, { required: true });
      checkChronologicalExposure(model.chronologicalCalibration, name, errors, warnings);
    }
    const od = manifest.rapm?.offenseDefense;
    if (object(od)) {
      // The chronological test measures the whole O/D model versus a baseline.
      // Separate game-fold ablations check the offense and defense components;
      // do not claim those ablations are themselves chronological tests.
      if (od.calibration?.status !== 'validated' || od.calibration?.allComponentsImproved !== true) {
        errors.push('Offense/defense component validation is missing or has not passed.');
      }
      checkOffenseDefenseRapmCalibration(od.calibration, od, errors, warnings);
    }
  }

  if (object(packageValidation)) {
    if (packageValidation.schemaVersion !== 3 || packageValidation.passed !== true
      || !Array.isArray(packageValidation.errors) || packageValidation.errors.length !== 0) {
      errors.push('The completed derived-package validation report has not passed without errors.');
    }
    if (packageValidation.checks?.teams !== 30 || !positiveInteger(packageValidation.checks?.playerProfiles)) {
      errors.push('Package validation does not confirm 30 teams and nonempty player profiles.');
    }
    if (object(manifest) && (!hash(manifestSha256) || !hash(packageValidation.inputSha256)
      || packageValidation.inputSha256.toLowerCase() !== manifestSha256.toLowerCase())) {
      errors.push('Derived-package validation is not bound to these exact manifest bytes.');
    }
    if (Array.isArray(packageValidation.warnings) && packageValidation.warnings.length) {
      warnings.push(`The package validation report has ${packageValidation.warnings.length} warning(s) to review.`);
    }
  }

  if (object(sourceValidation)) {
    if (sourceValidation.validatorVersion !== SOURCE_VALIDATOR || sourceValidation.passed !== true
      || !Array.isArray(sourceValidation.errors) || sourceValidation.errors.length !== 0) {
      errors.push('The supplied source-archive validation report has not passed without errors.');
    }
    if (!sameSeasons(sourceValidation.archiveScope?.seasons, seasons)) {
      errors.push('Source validation does not cover exactly the requested seasons.');
    }
    if (object(manifest) && (!hash(sourceValidationSha256)
      || !hash(manifest.provenance?.sourceValidationReportSha256)
      || manifest.provenance.sourceValidationReportSha256.toLowerCase() !== sourceValidationSha256.toLowerCase())) {
      errors.push('Package provenance is not bound to these exact source-validation report bytes.');
    }
    if (Array.isArray(sourceValidation.warnings) && sourceValidation.warnings.length) {
      warnings.push(`The source validation report has ${sourceValidation.warnings.length} warning(s); source PASS is not universal stat completeness.`);
    }
  }

  const status = errors.length ? 'blocked' : pending.length ? 'pending' : 'ready_for_integration_review';
  return {
    version: LINEUP_SCOUT_READINESS_VERSION,
    status,
    readyForIntegrationReview: status === 'ready_for_integration_review',
    livePromotionApproved: false,
    expectedSeasonStartYears: seasons,
    errors: [...new Set(errors)], pending, warnings: [...new Set(warnings)],
    limitations: [
      'Metadata preflight only: relies on the supplied package validator for shard integrity; does not reread shards or prove game-ID disjointness.',
      'Player joins, independent box-score completeness, workload regressions, and private integration review are still required before promotion.',
    ],
  };
}
