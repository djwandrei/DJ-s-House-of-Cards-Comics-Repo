-- Forward-only expansion of the compact derived lineup-projection contract.
--
-- The original function is deliberately replaced rather than loosening a
-- table policy or adding a generic JSON blob. The same recursive scalar-only
-- restrictions, raw/archive-shaped key blocklist, RLS, and service-role-only
-- RPC boundary remain in force. These additional keys describe a derived
-- lineup projection; they never permit possession events, provider payloads,
-- Storage locations, or arbitrary nested diagnostics.
create or replace function public.nba_scout_compact_jsonb_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive walk(value, key, depth) as (
    select p_value, null::text, 0
    union all
    select child.value, child.key, walk.depth + 1
    from walk
    cross join lateral (
      select member.value, member.key
      from pg_catalog.jsonb_each(
        case when pg_catalog.jsonb_typeof(walk.value) = 'object'
          then walk.value else '{}'::jsonb end
      ) as member(key, value)
      union all
      select member.value, null::text
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(walk.value) = 'array'
          then walk.value else '[]'::jsonb end
      ) as member(value)
    ) as child
    where walk.depth < 6
  )
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from walk
      where pg_catalog.jsonb_typeof(value) = 'array'
         or depth > 5
         or (key is not null and key <> all (array[
           'games', 'gameResults', 'pointsFor', 'pointsAgainst', 'offensivePointsFor', 'defensivePointsAllowed',
           'offensivePossessions', 'defensivePossessions', 'totalPossessions', 'offensiveRating', 'defensiveRating',
           'netRating', 'plusMinusPer100', 'wins', 'losses', 'ties', 'unclassified', 'decisions', 'winPercentage',
           'reliability', 'possessions', 'grade', 'publishable', 'reliabilityScore', 'method', 'confidence95',
           'estimate', 'standardError', 'lower', 'upper', 'fourFactors', 'offense', 'defense',
           'effectiveFieldGoalPercentage', 'turnoverRate', 'offensiveReboundPercentage', 'freeThrowAttemptRate',
           'coverage', 'status', 'relevantEventCount', 'resolvedEventCount', 'unresolvedEventCount',
           'resolvedRelevantEventShare', 'shootingProfile', 'fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts',
           'twoPointMakes', 'threePointAttempts', 'threePointersMade', 'freeThrowAttempts', 'freeThrowsMade',
           'twoPointPercentage', 'threePointPercentage', 'freeThrowPercentage', 'threePointAttemptRate',
           'trueShootingPercentage', 'averageFieldGoalDistance', 'fieldGoalDistanceObserved', 'offensivePlaymaking',
           'assists', 'foulsDrawn', 'assistsPer100Possessions', 'foulsDrawnPer100Possessions',
           'assistedFieldGoalRate', 'assistToTurnoverRatio', 'possessionExtensions', 'secondChancePossessions',
           'secondChancePoints', 'secondChancePossessionRate', 'secondChancePointsPer100Possessions',
           'pointsPerSecondChancePossession', 'pointsOffTurnoverPossessions', 'pointsOffTurnovers',
           'pointsOffTurnoverPossessionRate', 'pointsOffTurnoverPer100Possessions', 'pointsPerPossessionAfterTurnover',
           'defensiveDisruption', 'steals', 'blocks', 'personalFouls', 'stealsPer100DefensivePossessions',
           'blocksPer100DefensivePossessions', 'personalFoulsPer100DefensivePossessions', 'blockRate',
           'stealForcedTurnoverRate', 'possessionOutcomes', 'empty', 'one', 'two', 'three', 'fourPlus',
           'accountedPossessions', 'scoringPossessions', 'scoringPossessionRate', 'pointsPerPossession', 'definition',
           'semantics', 'teamPossessions', 'minutes', 'possessionsPerGame', 'teamPossessionsPerGame',
           'minutesPerGame', 'pacePer48Minutes', 'on', 'off', 'gamesUsed', 'teamPossessionShare',
           'teamMinuteShare', 'exactLineupStartingGames', 'exactLineupClosingGames', 'exactLineupStartRate',
           'exactLineupCloseRate', 'offensiveRatingDifference', 'defensiveRatingDifference',
           'netRatingDifference', 'onOffNetRating', 'plusMinusPer100Difference', 'convention', 'starterGames',
           'closerGames', 'starterGameRate', 'closerGameRate', 'teamPossessionsWhileOnCourt',
           'structuredStatisticRows', 'recognizedStatisticRows', 'unknownFieldGoalMadeStatus',
           'unclassifiedFieldGoalAttempts', 'unclassifiedFieldGoalMakes', 'unknownFreeThrowMadeStatus',
           'unclassifiedRebounds', 'fieldGoalMadeStatusShare', 'fieldGoalValueClassifiedShare',
           'freeThrowMadeStatusShare', 'missingProviderShotType', 'missingProviderShotDescription',
           'providerShotTypeShare', 'providerShotDescriptionShare', 'scoringComplete', 'reboundsComplete',
           'boxScore', 'shooting', 'per36', 'per100Possessions', 'points', 'rebounds', 'shotAttemptsBlocked',
           'turnovers', 'technicalFouls', 'nonUnsportsmanlikeTechnicalFouls', 'totalTechnicalFouls', 'flagrantFouls', 'ejections',
           'offensiveRebounds', 'defensiveRebounds', 'fieldGoalPercentage', 'blockedAttemptRate', 'possessionEndingInvolvementProxy',
           'expectedMinutes', 'expectedNetRating', 'aOffBOn', 'aOffBOff', 'aOnBOff', 'aOnBOn', 'modelVersion',
           'seasonEndYear', 'seasonPhase', 'lambda', 'observationCount', 'directionalObservationCount',
           'pairedStintObservationCount', 'gameCount', 'totalPairedPossessions', 'totalOffensivePossessions',
           'excludedStintCount', 'skippedDirectionalObservationCount', 'inputSha256', 'interceptPer100',
           'baselineOffensiveRatingPer100', 'homeCourtEffectPer100', 'homeCourtSignConvention',
           'homeCourtNetRatingEffectPer100', 'formulation', 'defensiveSignConvention', 'contextSemantics',
           'sourceMode', 'sourceExactLineupPossessions', 'converged', 'iterationCount', 'residualNorm',
           'targetResidualNorm', 'solver', 'averageTeammateNetRapmPer100', 'averageOpponentNetRapmPer100',
           'teammateRapmContextPer100', 'opponentRapmContextPer100', 'displayMinimumPairedPossessions',
           'sampleSizeTier', 'ridgeReliabilityProxy', 'exposureShareOfAvailablePossessions',
           'offensiveObservationCount', 'defensiveObservationCount', 'offensiveRidgeReliabilityProxy',
           'defensiveRidgeReliabilityProxy',
           'model', 'playerCount', 'rapmSumPer100', 'averageOpponentLineupRapmPer100',
           'homeCourtExposureAdjustmentPer100', 'expectedObservedNetRatingPer100',
           'contextAdjustmentStatus', 'observedNetRating', 'observedPossessions',
           'rawObservedSynergyPer100', 'synergyPriorPossessions', 'synergyWeight',
           'shrunkSynergyPer100', 'projectedNetRatingPer100',
           'projectedObservedContextNetRatingPer100', 'caveat'
         ]::text[]))
         or (pg_catalog.jsonb_typeof(value) = 'string' and pg_catalog.length(value #>> '{}') > 500)
         or pg_catalog.jsonb_typeof(value) not in ('object', 'number', 'boolean', 'string', 'null')
    );
$$;
