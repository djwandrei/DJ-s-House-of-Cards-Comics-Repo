/**
 * Convert exact player/position minute totals into a real 48-minute unit plan.
 *
 * The minute optimizer proves aggregate feasibility. This planner performs the
 * final simultaneity proof: every minute has five distinct players, two guard
 * roles, two forward roles, and one center role, while every player's exact
 * assigned minutes and exact role split are preserved.
 *
 * The construction is not a heuristic. We represent role assignments as a
 * bipartite multigraph, pad it to a 48-regular graph with dummy court slots,
 * and decompose it into 48 perfect matchings. Kőnig's line-coloring theorem
 * guarantees this decomposition for a bipartite multigraph. Dummy matches are
 * discarded; the five real role slots form one legal on-court unit per minute.
 */

export const ROTATION_UNIT_MODEL_VERSION = "exact-unit-decomposition-v1";

const FRAME_COUNT = 48;
const REAL_SLOTS = Object.freeze([
  Object.freeze({ id: "G1", role: "G" }),
  Object.freeze({ id: "G2", role: "G" }),
  Object.freeze({ id: "F1", role: "F" }),
  Object.freeze({ id: "F2", role: "F" }),
  Object.freeze({ id: "C1", role: "C" }),
]);

function integer(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function addEdge(adjacency, left, right, amount) {
  if (!(amount > 0)) return;
  if (!adjacency.has(left)) adjacency.set(left, new Map());
  const row = adjacency.get(left);
  row.set(right, (row.get(right) || 0) + amount);
}

function splitRoleAcrossSlots(rows, role, slots) {
  const capacities = new Map(slots.map((slot) => [slot, FRAME_COUNT]));
  const edges = [];
  // Larger demands are split first, always using the slot with the most room.
  // This keeps the multigraph sparse; any valid split remains exactly
  // decomposable because a player's total degree is already at most 48.
  const ordered = rows
    .map((row) => ({ id: row.id, minutes: row.roles[role] }))
    .filter((row) => row.minutes > 0)
    .sort((left, right) => right.minutes - left.minutes || left.id.localeCompare(right.id));
  for (const row of ordered) {
    let remaining = row.minutes;
    while (remaining > 0) {
      const slot = slots.slice().sort((left, right) =>
        capacities.get(right) - capacities.get(left) || left.localeCompare(right))[0];
      const amount = Math.min(remaining, capacities.get(slot));
      if (!(amount > 0)) return null;
      edges.push({ playerId: row.id, slot, amount });
      capacities.set(slot, capacities.get(slot) - amount);
      remaining -= amount;
    }
  }
  if ([...capacities.values()].some((remaining) => remaining !== 0)) return null;
  return edges;
}

function perfectMatching(leftIds, rightIds, adjacency) {
  const matchRight = new Map();
  const orderedLeft = leftIds.slice().sort((left, right) => {
    const leftDegree = [...(adjacency.get(left)?.values() || [])].filter((count) => count > 0).length;
    const rightDegree = [...(adjacency.get(right)?.values() || [])].filter((count) => count > 0).length;
    return leftDegree - rightDegree || left.localeCompare(right);
  });

  function augment(left, seenRight) {
    const neighbors = rightIds
      .filter((right) => (adjacency.get(left)?.get(right) || 0) > 0)
      .sort((first, second) => {
        // Preserve scarce real-role edges before dummy padding where possible.
        const firstReal = REAL_SLOTS.some((slot) => slot.id === first);
        const secondReal = REAL_SLOTS.some((slot) => slot.id === second);
        if (firstReal !== secondReal) return firstReal ? -1 : 1;
        return first.localeCompare(second);
      });
    for (const right of neighbors) {
      if (seenRight.has(right)) continue;
      seenRight.add(right);
      const priorLeft = matchRight.get(right);
      if (priorLeft === undefined || augment(priorLeft, seenRight)) {
        matchRight.set(right, left);
        return true;
      }
    }
    return false;
  }

  for (const left of orderedLeft) {
    if (!augment(left, new Set())) return null;
  }
  return new Map([...matchRight.entries()].map(([right, left]) => [left, right]));
}

function compressStints(frames) {
  const stints = [];
  for (const frame of frames) {
    const key = frame.playerIds.slice().sort().join("\u0001");
    const prior = stints.at(-1);
    if (prior?.key === key) {
      prior.endMinute = frame.minute;
      prior.duration += 1;
      continue;
    }
    stints.push({
      key,
      startMinute: frame.minute,
      endMinute: frame.minute,
      duration: 1,
      playerIds: frame.playerIds.slice(),
    });
  }
  return stints.map(({ key, ...stint }) => stint);
}

/** Plan exact one-minute units from an optimizer rotation result. */
export function planRotationUnits(players, rotation) {
  const roster = Array.isArray(players) ? players : [];
  const byPlayer = rotation?.positionMinutes?.byPlayer;
  if (!rotation?.positionMinutes?.enforced || !byPlayer) {
    return {
      ok: false,
      version: ROTATION_UNIT_MODEL_VERSION,
      reason: "Exact position-minute assignments were unavailable for this result.",
    };
  }

  const rows = [];
  const reasons = [];
  for (const player of roster) {
    const id = String(player.id);
    const total = integer(rotation?.byId?.[id]);
    const roles = Object.fromEntries(["G", "F", "C"].map((role) => [
      role,
      integer(byPlayer?.[id]?.[role]),
    ]));
    if (total === null || Object.values(roles).some((value) => value === null)) {
      reasons.push(`Player ${id} has a non-integer minute or role assignment.`);
      continue;
    }
    if (Object.values(roles).reduce((sum, value) => sum + value, 0) !== total) {
      reasons.push(`Player ${id}'s role minutes do not equal assigned minutes.`);
    }
    if (total > FRAME_COUNT) reasons.push(`Player ${id} exceeds 48 regulation minutes.`);
    rows.push({ id, total, roles });
  }
  if (reasons.length > 0) {
    return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: reasons.join(" ") };
  }
  const totals = Object.fromEntries(["G", "F", "C"].map((role) => [
    role,
    rows.reduce((sum, row) => sum + row.roles[role], 0),
  ]));
  if (totals.G !== 96 || totals.F !== 96 || totals.C !== 48) {
    return {
      ok: false,
      version: ROTATION_UNIT_MODEL_VERSION,
      reason: `Role minutes must equal 96 G, 96 F, and 48 C; received ${totals.G}/${totals.F}/${totals.C}.`,
    };
  }

  const roleEdges = [
    ...(splitRoleAcrossSlots(rows, "G", ["G1", "G2"]) || []),
    ...(splitRoleAcrossSlots(rows, "F", ["F1", "F2"]) || []),
    ...rows.filter((row) => row.roles.C > 0).map((row) => ({
      playerId: row.id,
      slot: "C1",
      amount: row.roles.C,
    })),
  ];
  if (roleEdges.reduce((sum, edge) => sum + edge.amount, 0) !== 240) {
    return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: "Role-slot splitting failed." };
  }

  const leftIds = rows.map((row) => row.id).sort();
  const rightIds = [
    ...REAL_SLOTS.map((slot) => slot.id),
    ...Array.from({ length: Math.max(0, leftIds.length - REAL_SLOTS.length) }, (_, index) => `D${index + 1}`),
  ];
  const adjacency = new Map(leftIds.map((id) => [id, new Map()]));
  for (const edge of roleEdges) addEdge(adjacency, edge.playerId, edge.slot, edge.amount);

  // Real court slots already have degree 48. Fill every player's idle minutes
  // against dummy slots so both sides become a square 48-regular multigraph.
  const leftDeficits = new Map(rows.map((row) => [row.id, FRAME_COUNT - row.total]));
  const rightDeficits = new Map(rightIds.map((right) => [
    right,
    REAL_SLOTS.some((slot) => slot.id === right) ? 0 : FRAME_COUNT,
  ]));
  for (const left of leftIds) {
    let remaining = leftDeficits.get(left);
    for (const right of rightIds.filter((id) => id.startsWith("D"))) {
      if (!(remaining > 0)) break;
      const amount = Math.min(remaining, rightDeficits.get(right));
      addEdge(adjacency, left, right, amount);
      remaining -= amount;
      rightDeficits.set(right, rightDeficits.get(right) - amount);
    }
    if (remaining !== 0) {
      return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: "Dummy-slot regularization failed." };
    }
  }
  if ([...rightDeficits.values()].some((value) => value !== 0)) {
    return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: "Dummy-slot capacity did not balance." };
  }

  const frames = [];
  for (let minute = 1; minute <= FRAME_COUNT; minute += 1) {
    const matching = perfectMatching(leftIds, rightIds, adjacency);
    if (!matching) {
      return {
        ok: false,
        version: ROTATION_UNIT_MODEL_VERSION,
        reason: `Exact unit decomposition failed at regulation minute ${minute}.`,
      };
    }
    const roles = { G: [], F: [], C: [] };
    for (const [left, right] of matching) {
      const count = adjacency.get(left).get(right) || 0;
      adjacency.get(left).set(right, count - 1);
      const slot = REAL_SLOTS.find((item) => item.id === right);
      if (slot) roles[slot.role].push(left);
    }
    for (const role of ["G", "F", "C"]) roles[role].sort();
    const playerIds = [...roles.G, ...roles.F, ...roles.C];
    if (roles.G.length !== 2 || roles.F.length !== 2 || roles.C.length !== 1 || new Set(playerIds).size !== 5) {
      return {
        ok: false,
        version: ROTATION_UNIT_MODEL_VERSION,
        reason: `Minute ${minute} did not produce five distinct legal court roles.`,
      };
    }
    frames.push({ minute, roles, playerIds });
  }

  const countedMinutes = Object.fromEntries(leftIds.map((id) => [id, 0]));
  for (const frame of frames) for (const id of frame.playerIds) countedMinutes[id] += 1;
  const minutesMatch = rows.every((row) => countedMinutes[row.id] === row.total);
  if (!minutesMatch) {
    return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: "Unit totals did not reconcile to the exact minute plan." };
  }
  const stints = compressStints(frames);
  return {
    ok: true,
    version: ROTATION_UNIT_MODEL_VERSION,
    exact: true,
    frameMinutes: 1,
    frames,
    stints,
    startingUnit: frames[0],
    closingUnit: frames.at(-1),
    validation: {
      frameCount: frames.length,
      fiveDistinctPlayersEveryMinute: true,
      playerMinutesMatch: true,
      roleMinutesMatch: true,
    },
  };
}

