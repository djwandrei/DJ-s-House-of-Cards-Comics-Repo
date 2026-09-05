/**
 * Convert exact player/position minute totals into a real 48-minute unit plan.
 *
 * The minute optimizer proves aggregate feasibility. This planner performs the
 * final simultaneity proof: every minute has five distinct players while every
 * player's exact assigned minutes and exact G/F/C role split are preserved.
 * The number of each role may vary by minute, which is required for supported
 * small and big profiles such as 120 G / 96 F / 24 C.
 *
 * The construction is not a heuristic. We represent role assignments as a
 * bipartite multigraph, pad it to a 48-regular graph with dummy court slots,
 * and decompose it into 48 perfect matchings. Kőnig's line-coloring theorem
 * guarantees this decomposition for a bipartite multigraph. Dummy matches are
 * discarded; the five real role slots form one legal on-court unit per minute.
 */

export const ROTATION_UNIT_MODEL_VERSION = "exact-units-load-balance-v2";

const FRAME_COUNT = 48;
const COURT_SLOTS = Object.freeze(["S1", "S2", "S3", "S4", "S5"]);
const ROLE_KEYS = Object.freeze(["G", "F", "C"]);

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

function addRoleInventory(inventory, left, right, role, amount) {
  if (!(amount > 0)) return;
  if (!inventory.has(left)) inventory.set(left, new Map());
  if (!inventory.get(left).has(right)) {
    inventory.get(left).set(right, { G: 0, F: 0, C: 0 });
  }
  inventory.get(left).get(right)[role] += amount;
}

/**
 * Place all 240 labelled player-role minutes into five anonymous court slots.
 * Each slot receives exactly 48 edges. The later edge decomposition decides
 * when those edges occur; role labels travel with the edges, so custom role
 * totals remain exact without forcing the same formation in every minute.
 */
function distributeRoleEdges(rows) {
  const capacities = new Map(COURT_SLOTS.map((slot) => [slot, FRAME_COUNT]));
  const edges = [];
  const inventory = new Map();
  const ordered = rows.slice().sort((left, right) =>
    right.total - left.total || left.id.localeCompare(right.id));
  for (const row of ordered) {
    for (const role of ROLE_KEYS) {
      let remaining = row.roles[role];
      while (remaining > 0) {
        const slot = COURT_SLOTS.slice().sort((left, right) =>
          capacities.get(right) - capacities.get(left) || left.localeCompare(right))[0];
        const amount = Math.min(remaining, capacities.get(slot));
        if (!(amount > 0)) return null;
        edges.push({ playerId: row.id, slot, role, amount });
        addRoleInventory(inventory, row.id, slot, role, amount);
        capacities.set(slot, capacities.get(slot) - amount);
        remaining -= amount;
      }
    }
  }
  if ([...capacities.values()].some((remaining) => remaining !== 0)) return null;
  return { edges, inventory };
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
        const firstReal = COURT_SLOTS.includes(first);
        const secondReal = COURT_SLOTS.includes(second);
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
export function planRotationUnits(players, rotation, { usageById = null } = {}) {
  const roster = Array.isArray(players) ? players : [];
  if (new Set(roster.map(player => String(player.id))).size !== roster.length) {
    return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: "Duplicate player identity in unit plan." };
  }
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
  const totals = Object.fromEntries(ROLE_KEYS.map((role) => [
    role,
    rows.reduce((sum, row) => sum + row.roles[role], 0),
  ]));
  if (Object.values(totals).reduce((sum, value) => sum + value, 0) !== 240) {
    return {
      ok: false,
      version: ROTATION_UNIT_MODEL_VERSION,
      reason: `Role minutes must total 240; received ${totals.G}/${totals.F}/${totals.C}.`,
    };
  }

  const distributed = distributeRoleEdges(rows);
  const roleEdges = distributed?.edges || [];
  const roleInventory = distributed?.inventory || new Map();
  if (!distributed || roleEdges.reduce((sum, edge) => sum + edge.amount, 0) !== 240) {
    return { ok: false, version: ROTATION_UNIT_MODEL_VERSION, reason: "Role-slot splitting failed." };
  }

  const leftIds = rows.map((row) => row.id).sort();
  const rightIds = [
    ...COURT_SLOTS,
    ...Array.from({ length: Math.max(0, leftIds.length - COURT_SLOTS.length) }, (_, index) => `D${index + 1}`),
  ];
  const adjacency = new Map(leftIds.map((id) => [id, new Map()]));
  for (const edge of roleEdges) addEdge(adjacency, edge.playerId, edge.slot, edge.amount);

  // Real court slots already have degree 48. Fill every player's idle minutes
  // against dummy slots so both sides become a square 48-regular multigraph.
  const leftDeficits = new Map(rows.map((row) => [row.id, FRAME_COUNT - row.total]));
  const rightDeficits = new Map(rightIds.map((right) => [
    right,
    COURT_SLOTS.includes(right) ? 0 : FRAME_COUNT,
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
      if (COURT_SLOTS.includes(right)) {
        const availableRoles = roleInventory.get(left)?.get(right);
        const role = ROLE_KEYS.find((key) => Number(availableRoles?.[key]) > 0);
        if (!role) {
          return {
            ok: false,
            version: ROTATION_UNIT_MODEL_VERSION,
            reason: `Minute ${minute} lost the role label for ${left}.`,
          };
        }
        availableRoles[role] -= 1;
        roles[role].push(left);
      }
    }
    for (const role of ["G", "F", "C"]) roles[role].sort();
    const playerIds = [...roles.G, ...roles.F, ...roles.C];
    if (playerIds.length !== 5 || new Set(playerIds).size !== 5) {
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
  const sharingOptimization = improveUnitResponsibility(frames, usageById);
  const stints = compressStints(frames);
  return {
    ok: true,
    version: ROTATION_UNIT_MODEL_VERSION,
    exact: true,
    // `exact` above certifies minute/role feasibility ONLY. Co-court selection
    // is explicitly a local secondary optimization, not a global synergy fit.
    sharingOptimization,
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

/**
 * Stagger offensive responsibility instead of displaying arbitrary matchings.
 * With fixed player minutes, total observed usage is constant. Minimizing the
 * sum of squared five-player load gaps therefore spreads creators across
 * units. This is a scheduling preference, NOT evidence that two players have
 * a learned positive/negative chemistry effect or a better win probability.
 *
 * Swap only identical court roles and only between units that do not already
 * contain the incoming player. Every swap preserves all 240 player/role
 * minutes and five distinct players per minute. Strict descent terminates on
 * the finite schedule space; there is no candidate shortlist/iteration cap.
 */
export function improveUnitResponsibility(frames, usageById) {
  const ids = [...new Set(frames.flatMap(frame => frame.playerIds))];
  const share = id => usageById instanceof Map ? usageById.get(id) : usageById?.[id];
  if (!usageById || ids.some(id => typeof share(id) !== "number" || !Number.isFinite(share(id)) || share(id) < 0 || share(id) > 1)) {
    return { applied: false, reason: "Comparable usage evidence is required for every selected player; no missing usage was imputed." };
  }
  const loads = frames.map(frame => frame.playerIds.reduce((sum, id) => sum + share(id), 0));
  const loss = values => values.reduce((sum, value) => sum + (value - 1) ** 2, 0);
  const before = loss(loads);
  let exchanges = 0;
  while (true) {
    let best = null;
    for (let first = 0; first < frames.length; first++) for (let second = first + 1; second < frames.length; second++) {
      for (const role of ROLE_KEYS) for (const a of frames[first].roles[role]) for (const b of frames[second].roles[role]) {
        if (a === b || frames[first].playerIds.includes(b) || frames[second].playerIds.includes(a)) continue;
        const delta = share(b) - share(a);
        const gain = (loads[first] - 1) ** 2 + (loads[second] - 1) ** 2
          - (loads[first] + delta - 1) ** 2 - (loads[second] - delta - 1) ** 2;
        if (gain > 1e-12 && (!best || gain > best.gain + 1e-12)) best = { first, second, role, a, b, delta, gain };
      }
    }
    if (!best) break;
    const { first, second, role, a, b, delta } = best;
    for (const [index, outgoing, incoming] of [[first, a, b], [second, b, a]]) {
      frames[index].roles[role] = frames[index].roles[role].map(id => id === outgoing ? incoming : id).sort();
      frames[index].playerIds = ROLE_KEYS.flatMap(key => frames[index].roles[key]);
    }
    loads[first] += delta; loads[second] -= delta; exchanges++;
  }
  const meanLoad = loads.reduce((sum, value) => sum + value, 0) / frames.length;
  const after = loss(loads);
  // Jensen gives a valid relaxed lower bound, even when exact role splits make
  // perfectly equal usage unattainable. Report the gap; never claim optimality
  // just because no two-frame exchange improves the schedule.
  const lowerBound = frames.length * (meanLoad - 1) ** 2;
  return { applied: true, objective: "squared-unit-offensive-load-gap", exchanges,
    before, after, relaxedLowerBound: lowerBound, boundGap: Math.max(0, after - lowerBound),
    optimality: after <= lowerBound + 1e-10 ? "relaxed-bound-attained" : "pair-exchange-local-optimum",
    unitUsageShares: loads, playerMinuteTotalsChanged: false,
    reason: "Creators are staggered while exact player and role minutes are preserved. This balances offensive responsibility; it is not a fitted chemistry or matchup effect." };
}
