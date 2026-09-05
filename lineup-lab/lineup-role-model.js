import { readPlayerUsage } from "./player-projection.js?v=20260905a";

/**
 * Soft lineup-composition model.
 *
 * Hard G/F/C rules prove that a group can take the floor. They do not prove
 * that it has a creator, shooting, rim protection, or connective passing. This
 * module adds a deliberately small, auditable role-complementarity adjustment
 * after the user's direct statistical priorities. Duplicate skills have
 * diminishing value; no role is a new hard constraint.
 */

export const LINEUP_ROLE_MODEL_VERSION = "role-complementarity-v1";
// Direct API callers retain the historical no-composition default for backward
// compatibility. The Lineup Lab UI deliberately sends `recommended`, making
// the small complementarity preference visible and shareable rather than a
// hidden change to an older integration's objective.
export const DEFAULT_ROLE_BALANCE = "off";
export const ROLE_BALANCE_LEVELS = Object.freeze({
  off: Object.freeze({ key: "off", label: "Off", maximumAdjustmentPoints: 0 }),
  recommended: Object.freeze({
    key: "recommended",
    label: "Recommended",
    maximumAdjustmentPoints: 5,
  }),
  emphasized: Object.freeze({
    key: "emphasized",
    label: "Emphasized",
    maximumAdjustmentPoints: 8,
  }),
});
export const ROLE_BALANCE_KEYS = Object.freeze(Object.keys(ROLE_BALANCE_LEVELS));

export const ROLE_DEFINITIONS = Object.freeze({
  primaryCreator: Object.freeze({ label: "Primary creator", side: "offense" }),
  floorSpacer: Object.freeze({ label: "Floor spacer", side: "offense" }),
  connector: Object.freeze({ label: "Connector", side: "offense" }),
  efficientFinisher: Object.freeze({ label: "Efficient finisher", side: "offense" }),
  pointOfAttack: Object.freeze({ label: "Point-of-attack defender", side: "defense" }),
  rimProtector: Object.freeze({ label: "Rim protector", side: "defense" }),
  rebounder: Object.freeze({ label: "Rebounder", side: "defense" }),
});

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function per36(player, field) {
  const minutes = number(player?.minutes);
  return minutes > 0 ? (number(player?.[field]) / minutes) * 36 : 0;
}

function impact(player, aliases) {
  for (const source of [player?.analytics?.seasonAdvanced, player?.analytics?.advanced]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const alias of aliases) {
      const value = Number(source[alias]);
      if (Number.isFinite(value)) return value;
    }
  }
  return 0;
}

function percentiles(entries, lowerIsBetter = false) {
  const sorted = entries.slice().sort((left, right) => left.value - right.value ||
    String(left.id).localeCompare(String(right.id)));
  const result = new Map();
  if (sorted.length === 1) return new Map([[sorted[0].id, 1]]);
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1].value === sorted[index].value) end += 1;
    const rank = (index + end) / 2;
    const value = sorted.length > 1 ? rank / (sorted.length - 1) : 1;
    for (let cursor = index; cursor <= end; cursor += 1) {
      result.set(sorted[cursor].id, lowerIsBetter ? 1 - value : value);
    }
    index = end + 1;
  }
  return result;
}

function weighted(...pairs) {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  return total > 0
    ? pairs.reduce((sum, [value, weight]) => sum + (number(value) * weight), 0) / total
    : 0;
}

/** Build role signals once over the full eligible pool so candidates share one scale. */
export function buildLineupRoleModel(players = []) {
  const roster = Array.isArray(players) ? players : [];
  const measurements = {
    points: roster.map((player) => ({ id: player.id, value: per36(player, "points") })),
    rebounds: roster.map((player) => ({ id: player.id, value: per36(player, "rebounds") })),
    assists: roster.map((player) => ({ id: player.id, value: per36(player, "assists") })),
    steals: roster.map((player) => ({ id: player.id, value: per36(player, "steals") })),
    blocks: roster.map((player) => ({ id: player.id, value: per36(player, "blocks") })),
    turnovers: roster.map((player) => ({ id: player.id, value: per36(player, "turnovers") })),
    efgPct: roster.map((player) => ({ id: player.id, value: number(player?.efgPct) })),
    threePct: roster.map((player) => ({ id: player.id, value: number(player?.threePct) })),
    usage: roster.map((player) => ({ id: player.id, value: readPlayerUsage(player) ?? 0.2 })),
    offensiveImpact: roster.map((player) => ({
      id: player.id,
      value: impact(player, ["offensive_box_plus_minus", "offensiveBoxPlusMinus", "obpm"]),
    })),
    defensiveImpact: roster.map((player) => ({
      id: player.id,
      value: impact(player, ["defensive_box_plus_minus", "defensiveBoxPlusMinus", "dbpm"]),
    })),
  };
  const pct = Object.fromEntries(Object.entries(measurements).map(([key, entries]) => [
    key,
    percentiles(entries, key === "turnovers"),
  ]));
  const signalsById = new Map();
  for (const player of roster) {
    const id = player.id;
    signalsById.set(id, {
      primaryCreator: weighted(
        [pct.assists.get(id), 0.42],
        [pct.usage.get(id), 0.3],
        [pct.points.get(id), 0.18],
        [pct.offensiveImpact.get(id), 0.1],
      ),
      floorSpacer: weighted(
        [pct.threePct.get(id), 0.55],
        [pct.efgPct.get(id), 0.25],
        [pct.points.get(id), 0.1],
        [pct.offensiveImpact.get(id), 0.1],
      ),
      connector: weighted(
        [pct.assists.get(id), 0.5],
        [pct.turnovers.get(id), 0.35],
        [pct.offensiveImpact.get(id), 0.15],
      ),
      efficientFinisher: weighted(
        [pct.efgPct.get(id), 0.55],
        [pct.points.get(id), 0.3],
        [pct.offensiveImpact.get(id), 0.15],
      ),
      pointOfAttack: weighted(
        [pct.steals.get(id), 0.6],
        [pct.defensiveImpact.get(id), 0.4],
      ),
      rimProtector: weighted(
        [pct.blocks.get(id), 0.6],
        [pct.rebounds.get(id), 0.25],
        [pct.defensiveImpact.get(id), 0.15],
      ),
      rebounder: weighted(
        [pct.rebounds.get(id), 0.8],
        [pct.defensiveImpact.get(id), 0.2],
      ),
    });
  }
  return {
    version: LINEUP_ROLE_MODEL_VERSION,
    eligiblePlayerCount: roster.length,
    signalsById,
  };
}

function rolePriorityWeights(objectiveWeights = {}) {
  const value = (key) => Math.max(0, number(objectiveWeights[key]));
  const weights = {
    primaryCreator: 0.35 + value("assists") + value("offensiveImpact") * 0.5,
    floorSpacer: 0.35 + value("threePct") + value("efgPct") * 0.35,
    connector: 0.3 + value("assists") * 0.5 + value("ballSecurity") * 0.8,
    efficientFinisher: 0.35 + value("points") * 0.65 + value("efgPct") * 0.7,
    pointOfAttack: 0.35 + value("steals") + value("defensiveImpact") * 0.5,
    rimProtector: 0.35 + value("blocks") + value("defensiveImpact") * 0.4,
    rebounder: 0.35 + value("rebounds"),
  };
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(Object.entries(weights).map(([role, weight]) => [
    role,
    total > 0 ? weight / total : 1 / Object.keys(weights).length,
  ]));
}

/**
 * Coverage uses the two strongest players for each role. The first receives
 * most of the credit; the second supplies redundancy at a diminishing return.
 */
export function scoreLineupRoleFit(
  players,
  roleModel,
  { objectiveWeights = {}, balance = DEFAULT_ROLE_BALANCE } = {},
) {
  const level = ROLE_BALANCE_LEVELS[balance] || ROLE_BALANCE_LEVELS[DEFAULT_ROLE_BALANCE];
  const priorities = rolePriorityWeights(objectiveWeights);
  const coverage = {};
  for (const role of Object.keys(ROLE_DEFINITIONS)) {
    const signals = players
      .map((player) => number(roleModel?.signalsById?.get(player.id)?.[role]))
      .sort((left, right) => right - left);
    coverage[role] = Math.min(1, (signals[0] || 0) * 0.78 + (signals[1] || 0) * 0.22);
  }
  const fitIndex = Object.entries(coverage).reduce(
    (sum, [role, value]) => sum + value * priorities[role] * 100,
    0,
  );
  // Sixty represents adequate broad coverage. The adjustment remains small
  // enough that a merely tidy roster cannot defeat a materially better match
  // to the user's direct priorities.
  const centered = Math.max(-1, Math.min(1, (fitIndex - 60) / 40));
  // Multiplying a negative centered score by zero produces JavaScript's
  // surprising `-0`. Return a literal zero when the model is explanation-only
  // so diagnostics, JSON, and strict tests all report one unambiguous value.
  const adjustmentPoints = level.maximumAdjustmentPoints > 0
    ? centered * level.maximumAdjustmentPoints
    : 0;
  const ordered = Object.entries(coverage)
    .map(([role, value]) => ({ role, label: ROLE_DEFINITIONS[role].label, coverage: value }))
    .sort((left, right) => right.coverage - left.coverage);
  return {
    version: LINEUP_ROLE_MODEL_VERSION,
    balance: level.key,
    applied: level.maximumAdjustmentPoints > 0,
    fitIndex,
    adjustmentPoints,
    coverage,
    strengths: ordered.slice(0, 3),
    needs: ordered.slice().sort((left, right) => left.coverage - right.coverage).slice(0, 3),
    reason: level.maximumAdjustmentPoints > 0
      ? "A small diminishing-return bonus rewards complementary roles without adding a new hard constraint."
      : "Role balance was left as explanation only and did not affect ranking.",
  };
}
