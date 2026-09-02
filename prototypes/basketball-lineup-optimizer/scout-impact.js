/**
 * Optional possession-level Scout layer.
 *
 * The live historical model remains independent from this contract. Verified
 * RAPM/on-off evidence can be added later without pretending that missing data
 * equals league average or silently changing the meaning of Plan Fit.
 */

export const SCOUT_IMPACT_MODEL_VERSION = "scout-impact-v1";
export const SCOUT_MODEL_MODES = Object.freeze(["historical", "hybrid", "scout"]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function playerEvidence(source, id) {
  if (source instanceof Map) return source.get(id) || source.get(String(id)) || null;
  return source?.[id] || source?.[String(id)] || null;
}

function impactValue(row, side) {
  const aliases = side === "offense"
    ? ["offensiveRapm", "offensive_rapm", "offense", "offensiveImpact"]
    : ["defensiveRapm", "defensive_rapm", "defense", "defensiveImpact"];
  for (const alias of aliases) {
    const value = finite(row?.[alias]);
    if (value !== null) return value;
  }
  return null;
}

/** Validate and shrink Scout inputs before any exact candidate is scored. */
export function buildScoutImpactModel(players, evidence, { mode = "historical" } = {}) {
  if (mode === "historical") {
    return {
      version: SCOUT_IMPACT_MODEL_VERSION,
      mode,
      available: false,
      applied: false,
      impactsById: new Map(),
      exactLineupResiduals: new Map(),
      missingPlayerIds: [],
      reason: "The historical model was selected; possession-level Scout evidence stayed separate.",
    };
  }
  const rows = evidence?.players;
  const impactsById = new Map();
  const missingPlayerIds = [];
  for (const player of players) {
    const row = playerEvidence(rows, player.id);
    const offense = impactValue(row, "offense");
    const defense = impactValue(row, "defense");
    if (offense === null || defense === null) {
      missingPlayerIds.push(player.id);
      continue;
    }
    const reliability = Math.max(0, Math.min(1, finite(row?.reliability) ?? 0));
    impactsById.set(player.id, {
      offense: offense * reliability,
      defense: defense * reliability,
      reliability,
      rawOffense: offense,
      rawDefense: defense,
    });
  }
  const exactLineupResiduals = new Map();
  for (const row of Array.isArray(evidence?.exactLineups) ? evidence.exactLineups : []) {
    const ids = Array.isArray(row?.playerIds) ? row.playerIds.map(String).sort() : [];
    const residual = finite(row?.residual ?? row?.lineupResidual);
    const reliability = Math.max(0, Math.min(1, finite(row?.reliability) ?? 0));
    if (ids.length === 5 && new Set(ids).size === 5 && residual !== null) {
      exactLineupResiduals.set(ids.join("\u0001"), residual * reliability);
    }
  }
  const available = missingPlayerIds.length === 0 && impactsById.size === players.length;
  return {
    version: SCOUT_IMPACT_MODEL_VERSION,
    mode,
    available,
    applied: available,
    impactsById,
    exactLineupResiduals,
    missingPlayerIds,
    reason: available
      ? "Reliability-shrunk possession impact is available for every eligible player."
      : "Scout mode requires comparable possession evidence for every eligible player; missing rows were not imputed as zero.",
  };
}

/** Score only complete, validated Scout evidence; missing data returns no adjustment. */
export function scoreScoutCandidate(players, model) {
  if (!model?.applied) {
    return { applied: false, adjustmentPoints: 0, impact: null, reason: model?.reason || "Scout evidence unavailable." };
  }
  const rows = players.map((player) => model.impactsById.get(player.id)).filter(Boolean);
  if (rows.length !== players.length) {
    return { applied: false, adjustmentPoints: 0, impact: null, reason: "One or more selected players lacked Scout evidence." };
  }
  let impact = rows.reduce((sum, row) => sum + row.offense + row.defense, 0) / rows.length;
  let exactLineupResidual = null;
  if (players.length === 5) {
    const key = players.map((player) => String(player.id)).sort().join("\u0001");
    if (model.exactLineupResiduals.has(key)) {
      exactLineupResidual = model.exactLineupResiduals.get(key);
      impact += exactLineupResidual;
    }
  }
  const scale = model.mode === "scout" ? 2.5 : 1.25;
  const limit = model.mode === "scout" ? 12 : 6;
  return {
    applied: true,
    impact,
    exactLineupResidual,
    adjustmentPoints: Math.max(-limit, Math.min(limit, impact * scale)),
    reason: exactLineupResidual === null
      ? "Reliability-shrunk individual possession impact was applied."
      : "Reliability-shrunk player impact and a verified exact-five residual were applied.",
  };
}

