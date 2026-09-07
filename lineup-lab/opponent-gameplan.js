import {
  DEFAULT_FAMILY_PRESETS,
  weightsFromSkillFamilies,
} from "./optimizer-config.js?v=20260907f";

/**
 * Version the historical opponent model separately from the exact optimizer.
 *
 * A lineup recommendation remains reproducible when the player pool, visible
 * priority weights, and this model version are known. The value intentionally
 * says "historical": this module has no schedule, injury, tracking, or
 * possession-by-possession matchup data.
 */
export const OPPONENT_GAME_PLAN_MODEL_VERSION = "historical-opponent-gameplan-v2";

const FAMILY_KEYS = Object.freeze(Object.keys(DEFAULT_FAMILY_PRESETS.balanced));
const COUNTING_TOTAL_KEYS = Object.freeze([
  "points",
  "totalRebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "fieldGoalsMade",
  "fieldGoalsAttempted",
  "threePointFieldGoalsMade",
  "threePointFieldGoalsAttempted",
  "freeThrowsAttempted",
  "offensiveRebounds",
]);
const POSSESSION_INPUT_KEYS = Object.freeze([
  "fieldGoalsAttempted",
  "freeThrowsAttempted",
  "offensiveRebounds",
  "turnovers",
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function positiveNumber(value) {
  const number = nonNegativeNumber(value);
  return number !== null && number > 0 ? number : null;
}

function round(value, places = 3) {
  const number = finiteNumber(value);
  if (number === null) return null;
  const multiplier = 10 ** places;
  return Math.round(number * multiplier) / multiplier;
}

function percent(value, places = 1) {
  const number = finiteNumber(value);
  return number === null ? null : round(number * 100, places);
}

function safeDivide(numerator, denominator) {
  const top = finiteNumber(numerator);
  const bottom = positiveNumber(denominator);
  return top === null || bottom === null ? null : top / bottom;
}

function compareText(left, right) {
  return String(left?.name || left?.id || "").localeCompare(String(right?.name || right?.id || ""))
    || String(left?.id || "").localeCompare(String(right?.id || ""));
}

/**
 * Convert a six-slider plan into an exact, whole-number 100-point display.
 *
 * The exact solver only cares about the ratios between the six families. This
 * largest-remainder method makes the preview truthful (it always sums to 100)
 * without accidentally giving the last family a rounding advantage.
 */
export function normalizeOpponentGamePlanFamilies(rawFamilies = {}) {
  const raw = FAMILY_KEYS.map((family, order) => ({
    family,
    order,
    value: Math.max(0, Number(rawFamilies?.[family]) || 0),
  }));
  const total = raw.reduce((sum, item) => sum + item.value, 0);
  if (!(total > 0)) return { ...DEFAULT_FAMILY_PRESETS.balanced };

  const rounded = raw.map((item) => {
    const exact = (item.value / total) * 100;
    const floor = Math.floor(exact);
    return {
      ...item,
      exact,
      rounded: floor,
      remainder: exact - floor,
    };
  });
  let pointsRemaining = 100 - rounded.reduce((sum, item) => sum + item.rounded, 0);
  rounded
    .slice()
    .sort((left, right) => right.remainder - left.remainder || left.order - right.order)
    .slice(0, pointsRemaining)
    .forEach((item) => {
      item.rounded += 1;
      pointsRemaining -= 1;
    });
  return Object.fromEntries(rounded.map((item) => [item.family, item.rounded]));
}

function aggregateRecordedTotals(players) {
  const totals = Object.fromEntries(COUNTING_TOTAL_KEYS.map((key) => [key, 0]));
  const availableByKey = Object.fromEntries(COUNTING_TOTAL_KEYS.map((key) => [key, 0]));
  const usablePlayers = [];

  for (const player of Array.isArray(players) ? players : []) {
    const recorded = player?.analytics?.totals;
    if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) continue;
    const values = {};
    let hasAnyRecordedTotal = false;
    for (const key of COUNTING_TOTAL_KEYS) {
      const value = nonNegativeNumber(recorded[key]);
      values[key] = value;
      if (value !== null) {
        totals[key] += value;
        availableByKey[key] += 1;
        hasAnyRecordedTotal = true;
      }
    }
    if (hasAnyRecordedTotal) {
      usablePlayers.push({
        id: String(player?.id || ""),
        name: String(player?.name || "Unknown player"),
        positions: Array.isArray(player?.positions) ? [...player.positions] : [],
        values,
      });
    }
  }

  return {
    totals,
    availableByKey,
    players: usablePlayers,
  };
}

function perGameAverages(source, totals) {
  const supplied = source?.teamAverages;
  const games = positiveNumber(source?.teamGames);
  const fromRecordedTotals = (key) => safeDivide(totals[key], games);
  const suppliedValue = (key) => finiteNumber(supplied?.[key]);
  return {
    points: fromRecordedTotals("points") ?? suppliedValue("points"),
    rebounds: fromRecordedTotals("totalRebounds") ?? suppliedValue("rebounds"),
    assists: fromRecordedTotals("assists") ?? suppliedValue("assists"),
    steals: fromRecordedTotals("steals") ?? suppliedValue("steals"),
    blocks: fromRecordedTotals("blocks") ?? suppliedValue("blocks"),
    stocks: (() => {
      const steals = fromRecordedTotals("steals") ?? suppliedValue("steals");
      const blocks = fromRecordedTotals("blocks") ?? suppliedValue("blocks");
      return steals === null || blocks === null ? null : steals + blocks;
    })(),
    turnovers: fromRecordedTotals("turnovers") ?? suppliedValue("turnovers"),
    efgPct: safeDivide(
      totals.fieldGoalsMade + (0.5 * totals.threePointFieldGoalsMade),
      totals.fieldGoalsAttempted,
    ) ?? suppliedValue("efgPct"),
    threePct: safeDivide(totals.threePointFieldGoalsMade, totals.threePointFieldGoalsAttempted)
      ?? suppliedValue("threePct"),
    threePointAttemptRate: safeDivide(totals.threePointFieldGoalsAttempted, totals.fieldGoalsAttempted),
    freeThrowRate: safeDivide(totals.freeThrowsAttempted, totals.fieldGoalsAttempted),
  };
}

/**
 * Build the team facts that the game-plan model is allowed to use.
 *
 * The public Basketball Reference import is player-team-season data, not a
 * dedicated team-total feed. Summing the selected team's player totals gives
 * a transparent team estimate. When all four possession inputs exist, rates
 * are normalized to 100 *estimated offensive possessions* using the familiar
 * FGA + 0.44×FTA − OREB + TOV formula. Otherwise the model falls back to
 * clearly labeled per-game comparisons instead of inventing a denominator.
 */
export function summarizeHistoricalTeamProfile(dataset = {}) {
  const source = dataset?.source || {};
  const aggregate = aggregateRecordedTotals(dataset?.players);
  const { totals, availableByKey } = aggregate;
  const playerCount = aggregate.players.length;
  const possessionInputsComplete = playerCount > 0
    && POSSESSION_INPUT_KEYS.every((key) => availableByKey[key] === playerCount);
  const estimatedPossessions = possessionInputsComplete
    ? totals.fieldGoalsAttempted
      + (0.44 * totals.freeThrowsAttempted)
      - totals.offensiveRebounds
      + totals.turnovers
    : null;
  const possessionRateAvailable = positiveNumber(estimatedPossessions) !== null;
  const teamGames = positiveNumber(source.teamGames);
  const perGame = perGameAverages(source, totals);
  const per100 = possessionRateAvailable ? {
    points: safeDivide(totals.points * 100, estimatedPossessions),
    rebounds: safeDivide(totals.totalRebounds * 100, estimatedPossessions),
    assists: safeDivide(totals.assists * 100, estimatedPossessions),
    steals: safeDivide(totals.steals * 100, estimatedPossessions),
    blocks: safeDivide(totals.blocks * 100, estimatedPossessions),
    turnovers: safeDivide(totals.turnovers * 100, estimatedPossessions),
    stocks: safeDivide((totals.steals + totals.blocks) * 100, estimatedPossessions),
    efgPct: perGame.efgPct,
    threePct: perGame.threePct,
    threePointAttemptRate: perGame.threePointAttemptRate,
    freeThrowRate: perGame.freeThrowRate,
  } : null;

  return {
    team: String(source.team || ""),
    teamName: String(source.teamName || source.team || "NBA team"),
    season: String(source.season || ""),
    seasonPhase: String(source.seasonPhase || "regular"),
    teamGames,
    playerCount,
    recordedTotals: { ...totals },
    recordedPlayers: aggregate.players,
    perGame,
    per100,
    // The UI can call this a pace-adjusted comparison only when both teams
    // satisfy this condition. It is an estimate, never a claimed possession
    // count supplied by the league.
    possessionRateAvailable,
    estimatedPossessions: possessionRateAvailable ? round(estimatedPossessions, 1) : null,
    possessionInputsComplete,
    rateMethod: possessionRateAvailable
      ? "estimated-offensive-possessions"
      : "per-game-fallback",
  };
}

function comparableRates(ownProfile, opponentProfile) {
  if (ownProfile?.per100 && opponentProfile?.per100) {
    return {
      basis: "per100",
      basisLabel: "per 100 estimated possessions",
      own: ownProfile.per100,
      opponent: opponentProfile.per100,
    };
  }
  return {
    basis: "perGame",
    basisLabel: "per game",
    own: ownProfile?.perGame || {},
    opponent: opponentProfile?.perGame || {},
  };
}

function rateNumber(rates, side, metric) {
  return finiteNumber(rates?.[side]?.[metric]);
}

function pointsDifference(rates, metric) {
  const own = rateNumber(rates, "own", metric);
  const opponent = rateNumber(rates, "opponent", metric);
  return own === null || opponent === null ? null : opponent - own;
}

function ratioDifference(rates, metric) {
  const own = rateNumber(rates, "own", metric);
  const opponent = rateNumber(rates, "opponent", metric);
  if (own === null || opponent === null || own <= 0) return null;
  return opponent / own;
}

function formatRate(value, { percentValue = false, places = 1 } = {}) {
  const number = finiteNumber(value);
  if (number === null) return "not available";
  return percentValue ? `${percent(number, places)}%` : String(round(number, places));
}

function topContributor(profile, metric) {
  const totalKey = {
    scoring: "points",
    creation: "assists",
    shooting: "threePointFieldGoalsAttempted",
    rebounding: "totalRebounds",
    disruption: "stocks",
  }[metric];
  if (!totalKey) return null;
  const total = totalKey === "stocks"
    ? profile.recordedTotals.steals + profile.recordedTotals.blocks
    : profile.recordedTotals[totalKey];
  if (!(total > 0)) return null;
  const candidates = profile.recordedPlayers
    .map((player) => {
      const value = totalKey === "stocks"
        ? (player.values.steals || 0) + (player.values.blocks || 0)
        : player.values[totalKey];
      return { ...player, value: Number(value) || 0 };
    })
    .filter((player) => player.value > 0)
    .sort((left, right) => right.value - left.value || compareText(left, right));
  const player = candidates[0];
  if (!player) return null;
  return {
    playerId: player.id,
    playerName: player.name,
    positions: player.positions,
    value: player.value,
    share: safeDivide(player.value, total),
  };
}

function threatCards(profile) {
  const definitions = [
    {
      id: "scoring",
      label: "Largest scoring share",
      noun: "recorded points",
    },
    {
      id: "creation",
      label: "Largest assist share",
      noun: "recorded assists",
    },
    {
      id: "shooting",
      label: "Most 3-point volume",
      noun: "recorded 3-point attempts",
    },
    {
      id: "rebounding",
      label: "Largest rebounding share",
      noun: "recorded rebounds",
    },
    {
      id: "disruption",
      label: "Most stocks",
      noun: "recorded steals + blocks",
    },
  ];
  return definitions.map((definition) => {
    const leader = topContributor(profile, definition.id);
    if (!leader) return null;
    return {
      ...definition,
      ...leader,
      description: `${leader.playerName} supplied ${formatRate(leader.share, { percentValue: true })} of the team's ${definition.noun}.`,
    };
  }).filter(Boolean);
}

function priority(id, label, evidence, familyBoosts) {
  return { id, label, evidence, familyBoosts: { ...familyBoosts } };
}

function applyBoosts(families, boosts) {
  for (const [family, amount] of Object.entries(boosts || {})) {
    if (!FAMILY_KEYS.includes(family)) continue;
    families[family] = Math.max(0, Number(families[family] || 0) + (Number(amount) || 0));
  }
}

/**
 * Create a visible-only historical response plan for two same-season teams.
 *
 * Design guardrails:
 * - No player is locked, excluded, or assigned a minute by this function.
 * - The function never reads player games, a team-stint length, or a historic
 *   minute share as a desired rotation amount.
 * - Opponent scoring does not masquerade as knowledge of defensive weaknesses.
 *   The offensive response is limited to a cautious "protect possessions"
 *   signal from steals/blocks, which is explicitly labeled as a proxy.
 * - The caller must show the six resulting weights and require an explicit
 *   Apply action before the exact optimizer receives them.
 */
export function buildOpponentGamePlan({
  ownDataset,
  opponentDataset,
  baselineFamilyWeights = DEFAULT_FAMILY_PRESETS.balanced,
} = {}) {
  const ownProfile = summarizeHistoricalTeamProfile(ownDataset);
  const opponentProfile = summarizeHistoricalTeamProfile(opponentDataset);
  const rates = comparableRates(ownProfile, opponentProfile);
  const families = { ...normalizeOpponentGamePlanFamilies(baselineFamilyWeights) };
  const defendTheirStrengths = [];
  const protectYourOffense = [];
  const caveats = [
    "Historical team-season plan only: it is not a live injury report, schedule-aware forecast, or exact player-to-player matchup assignment.",
    "Applying it changes only the six visible Lineup Lab priorities. It does not change your player pool, position rules, minimums, exclusions, or minute plan.",
  ];

  if (rates.basis !== "per100") {
    caveats.push("A complete possession estimate was unavailable for at least one team, so comparisons use per-game totals instead of pace-adjusted rates.");
  } else {
    caveats.push("Pace-adjusted counting rates use an estimated offensive-possession formula from the imported box-score totals; shooting percentages remain attempt-weighted percentages.");
  }

  const threePointAttemptGap = pointsDifference(rates, "threePointAttemptRate");
  const threePointAccuracyGap = pointsDifference(rates, "threePct");
  const opponentThreePointRate = rateNumber(rates, "opponent", "threePointAttemptRate");
  const ownAssist = rateNumber(rates, "own", "assists");
  const opponentAssist = rateNumber(rates, "opponent", "assists");
  const assistGap = pointsDifference(rates, "assists");
  const efgGap = pointsDifference(rates, "efgPct");
  const reboundRatio = ratioDifference(rates, "rebounds");
  const stocksGap = pointsDifference(rates, "stocks");
  const blockGap = pointsDifference(rates, "blocks");
  const scorer = topContributor(opponentProfile, "scoring");
  const creator = topContributor(opponentProfile, "creation");

  // A team that takes materially more threes than the current team presents a
  // clearer perimeter-containment problem than raw 3P% alone. The high-volume
  // fallback keeps the plan useful when the current team has no valid 3PA rate.
  if (
    (threePointAttemptGap !== null && threePointAttemptGap >= 0.04)
    || (opponentThreePointRate !== null && opponentThreePointRate >= 0.38)
  ) {
    const evidence = threePointAttemptGap !== null
      ? `${opponentProfile.teamName} used ${formatRate(rates.opponent.threePointAttemptRate, { percentValue: true })} of field-goal attempts from three versus ${formatRate(rates.own.threePointAttemptRate, { percentValue: true })} for ${ownProfile.teamName}.`
      : `${opponentProfile.teamName} used ${formatRate(opponentThreePointRate, { percentValue: true })} of field-goal attempts from three.`;
    const item = priority("three-point-volume", "Contain 3-point volume", evidence, { perimeterDefense: 12 });
    defendTheirStrengths.push(item);
    applyBoosts(families, item.familyBoosts);
  }

  if (threePointAccuracyGap !== null && threePointAccuracyGap >= 0.012) {
    const item = priority(
      "three-point-accuracy",
      "Limit clean perimeter looks",
      `${opponentProfile.teamName} shot ${formatRate(rates.opponent.threePct, { percentValue: true })} from three versus ${formatRate(rates.own.threePct, { percentValue: true })} for ${ownProfile.teamName}.`,
      { perimeterDefense: 6 },
    );
    defendTheirStrengths.push(item);
    applyBoosts(families, item.familyBoosts);
  }

  // A creation edge is useful without claiming who set which screen or drew a
  // specific assignment. It asks the optimizer for more ball-pressure signals
  // (steals/DBPM), not a fabricated individual defensive matchup.
  const assistThreshold = rates.basis === "per100" ? 2 : 0.8;
  if (assistGap !== null && assistGap >= assistThreshold) {
    const leaderNote = creator?.share !== null && creator?.share !== undefined
      ? ` ${creator.playerName} supplied ${formatRate(creator.share, { percentValue: true })} of their recorded assists.`
      : "";
    const item = priority(
      "ball-movement",
      "Disrupt ball movement",
      `${opponentProfile.teamName} recorded ${formatRate(opponentAssist)} assists ${rates.basisLabel}, compared with ${formatRate(ownAssist)} for ${ownProfile.teamName}.${leaderNote}`,
      { perimeterDefense: 8 },
    );
    defendTheirStrengths.push(item);
    applyBoosts(families, item.familyBoosts);
  }

  // eFG% describes the outcome, not the location or type of a shot. Balance
  // point-of-attack and interior signals rather than pretending box scores know
  // how many rim, pull-up, or catch-and-shoot attempts were allowed.
  if (efgGap !== null && efgGap >= 0.01) {
    const item = priority(
      "shot-efficiency",
      "Make efficient shots harder",
      `${opponentProfile.teamName} posted a ${formatRate(rates.opponent.efgPct, { percentValue: true })} eFG% versus ${formatRate(rates.own.efgPct, { percentValue: true })} for ${ownProfile.teamName}. Shot-location tracking is not included.`,
      { perimeterDefense: 5, interiorDefense: 5 },
    );
    defendTheirStrengths.push(item);
    applyBoosts(families, item.familyBoosts);
  }

  if (reboundRatio !== null && reboundRatio >= 1.04) {
    const item = priority(
      "rebounding",
      "Finish possessions on the glass",
      `${opponentProfile.teamName} recorded ${formatRate(rates.opponent.rebounds)} rebounds ${rates.basisLabel}, ${formatRate((reboundRatio - 1), { percentValue: true })} above ${ownProfile.teamName}'s rate.`,
      { rebounding: 11, interiorDefense: 3 },
    );
    defendTheirStrengths.push(item);
    applyBoosts(families, item.familyBoosts);
  }

  // Steals and blocks are observable, but they are not a complete defensive
  // rating. Treat a large stocks edge as a conservative ball-security signal;
  // never say it proves the opponent has a weak or strong defense overall.
  const stocksThreshold = rates.basis === "per100" ? 1.5 : 0.55;
  if (stocksGap !== null && stocksGap >= stocksThreshold) {
    const blockText = blockGap !== null && blockGap >= (rates.basis === "per100" ? 0.8 : 0.28)
      ? " with a notable block-rate edge"
      : "";
    const item = priority(
      "protect-possessions",
      "Protect possessions",
      `${opponentProfile.teamName} recorded ${formatRate(rates.opponent.stocks)} steals + blocks ${rates.basisLabel}, compared with ${formatRate(rates.own.stocks)} for ${ownProfile.teamName}${blockText}. This is a disruption proxy, not a defensive-efficiency measure.`,
      { creation: 8, spacing: 3 },
    );
    protectYourOffense.push(item);
    applyBoosts(families, item.familyBoosts);
  }

  if (defendTheirStrengths.length === 0) {
    defendTheirStrengths.push(priority(
      "balanced-defense",
      "Keep a balanced defensive mix",
      "No large, supported team-style gap crossed this model's transparent thresholds.",
      {},
    ));
  }
  if (protectYourOffense.length === 0) {
    protectYourOffense.push(priority(
      "preserve-offense",
      "Keep your normal offensive balance",
      "The imported team totals do not show a large enough steals + blocks signal to change offensive priorities automatically.",
      {},
    ));
  }

  // A concentrated scorer is useful context for a fan's game plan, but this
  // does not alter weight families on its own: player-share data cannot tell us
  // whether that player was defended by a guard, wing, big, switch, or double.
  if (scorer && scorer.share !== null && scorer.share >= 0.27) {
    caveats.push(`${scorer.playerName} supplied ${formatRate(scorer.share, { percentValue: true })} of ${opponentProfile.teamName}'s recorded points. Use that as context, not as proof of a required individual matchup.`);
  }

  const familyWeights = normalizeOpponentGamePlanFamilies(families);
  return {
    modelVersion: OPPONENT_GAME_PLAN_MODEL_VERSION,
    mode: "historical-opponent-team-response",
    // A balanced baseline gives the preview a single clear meaning. It does
    // not blend hidden changes into the visitor's current custom slider setup;
    // the UI displays the resulting difference and asks before applying it.
    baseline: "balanced-visible-family-weights",
    comparison: {
      rateBasis: rates.basis,
      rateBasisLabel: rates.basisLabel,
      own: ownProfile,
      opponent: opponentProfile,
    },
    defendTheirStrengths,
    protectYourOffense,
    threats: threatCards(opponentProfile),
    familyWeights,
    weights: weightsFromSkillFamilies(familyWeights),
    caveats,
    constraints: {
      changesOnlyVisibleWeights: true,
      changesMinutePlan: false,
      changesPositionRules: false,
      changesPlayerPool: false,
      makesMatchupAssignments: false,
    },
  };
}
