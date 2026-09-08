import { METRIC_SPECS, FORGE_BLOCKS, metricEvidence, validateAnalysisRoster, buildComposite } from './studio-analysis.js?v=20260906a';

// Descriptive proximity, not a learned archetype, talent grade, or fit model.
export const STYLE_POLICY = Object.freeze({ minComponents: 6, minBlocks: 3, minCandidates: 3, limit: 3 });
const blockFor = key => FORGE_BLOCKS.find(block => block.metrics.includes(key));
const rounded = value => Number(value.toFixed(8));
const byHandle = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));

function compareTarget(roster, target) {
  const base = { snapshot: roster.snapshot, team: roster.team, kind: target.kind,
    policy: STYLE_POLICY, candidates: roster.players.length - (target.id ? 1 : 0), eligible: 0,
    components: [], omitted: [], matches: [],
    note: 'Only this team’s pooled-window profiles are compared, not the league or individual seasons. This is an observed component-proximity heuristic, not a learned archetype, talent ranking, fit score, forecast, or match probability.',
    method: 'Every eligible candidate must support the same target components. Absolute component gaps are divided by the eligible cohort’s component range, averaged within each donor block, then averaged equally across blocks. Constant components do not rank candidates. Missing values are never imputed. Distances depend on this roster and its ranges, including outliers. Distances tied at eight decimal places use player handles only to order the three displayed results.' };
  const usable = target.components.filter(component => component.status === 'reviewable');
  base.omitted = target.components.filter(component => component.status !== 'reviewable').map(({ key, label, status }) => ({ key, label, reason: status }));
  const blocked = (status, reason) => ({ ...base, status, reason });
  if (usable.length < STYLE_POLICY.minComponents) return blocked('insufficient_components', 'At least six sample-reviewed components are required. Missing or low-exposure components stay unavailable.');
  // One fixed basis for every candidate prevents sparse profiles from winning
  // by being compared on fewer, easier components.
  const candidates = roster.players.filter(player => player.id !== target.id).map(player => ({
    id: player.id, name: player.name, components: usable.map(component => metricEvidence(player, component.key)),
  })).filter(player => player.components.every(component => component.status === 'reviewable'));
  base.eligible = candidates.length;
  if (candidates.length < STYLE_POLICY.minCandidates) return blocked('insufficient_cohort', 'At least three other eligible profiles must support the same component basis. Broader or partially missing profiles are not substituted.');
  const informative = usable.flatMap((component, index) => {
    const values = candidates.map(player => player.components[index].value);
    const minimum = Math.min(...values), maximum = Math.max(...values), range = maximum - minimum;
    if (range === 0) {
      base.omitted.push({ key: component.key, label: component.label, reason: 'no_peer_variation' });
      return [];
    }
    return [{ ...component, index, minimum, maximum, range, block: blockFor(component.key).key }];
  });
  const blocks = FORGE_BLOCKS.filter(block => informative.some(component => component.block === block.key));
  base.components = informative.map(({ key, label, unit, minimum, maximum, range, block }) => ({ key, label, unit, minimum, maximum, range, block }));
  if (informative.length < STYLE_POLICY.minComponents || blocks.length < STYLE_POLICY.minBlocks) {
    return blocked('insufficient_variation', 'At least six varying components across three blocks are required to distinguish profiles. A mostly constant cohort cannot support a useful ordering.');
  }
  const compared = candidates.map(player => {
    const gaps = informative.map(component => {
      const candidate = player.components[component.index];
      const difference = component.value - candidate.value;
      return { key: component.key, label: component.label, unit: component.unit, block: component.block,
        target: component.value, candidate: candidate.value, difference,
        normalizedGap: Math.abs(difference) / component.range,
        targetDenominator: component.denominator, candidateDenominator: candidate.denominator,
        targetReconciled: component.reconciled, candidateReconciled: candidate.reconciled };
    });
    const contributions = blocks.map(block => {
      const values = gaps.filter(gap => gap.block === block.key).map(gap => gap.normalizedGap);
      return { block: block.key, label: block.label, distance: values.reduce((sum, value) => sum + value, 0) / values.length };
    });
    const distance = contributions.reduce((sum, block) => sum + block.distance, 0) / contributions.length;
    return { id: player.id, name: player.name, distance, contributions, gaps,
      donorBlocks: target.donors.filter(donor => donor.id === player.id).map(donor => donor.label),
      unreconciledComponents: gaps.filter(gap => !gap.targetReconciled || !gap.candidateReconciled).length };
  });
  if (compared.some(player => !Number.isFinite(player.distance))) return blocked('unavailable_scale', 'The supplied component ranges cannot support a finite comparison. No ranking is shown.');
  compared.sort((a, b) => rounded(a.distance) - rounded(b.distance) || byHandle(a, b));
  let rank = 0, previous = null;
  base.matches = compared.slice(0, STYLE_POLICY.limit).map(player => {
    const distance = rounded(player.distance);
    if (distance !== previous) rank++;
    previous = distance;
    return { ...player, distance, rank, contributions: player.contributions.map(block => ({ ...block, distance: rounded(block.distance) })) };
  });
  return { ...base, status: 'ready', reason: 'Nearest profiles on one fixed observed-component basis.',
    outsideCohortRange: informative.filter(component => component.value < component.minimum || component.value > component.maximum).map(component => component.label) };
}

export function findPlayerStyleMatches(roster, id) {
  validateAnalysisRoster(roster);
  const player = roster.players.find(player => player.id === id);
  if (!player) throw new Error('Choose a player from this team and snapshot.');
  return compareTarget(roster, { kind: 'observed_player', id,
    components: METRIC_SPECS.map(spec => metricEvidence(player, spec.key)), donors: [] });
}

export function findCompositeStyleMatches(roster, recipe) {
  const composite = buildComposite(roster, recipe);
  if (composite.assigned !== composite.totalBlocks) return { snapshot: roster.snapshot, team: roster.team,
    kind: 'hypothetical_recipe', status: 'incomplete_recipe', matches: [], components: [], omitted: [],
    reason: 'Choose all five donor blocks before finding nearby observed profiles.' };
  return compareTarget(roster, { kind: 'hypothetical_recipe',
    components: composite.blocks.flatMap(block => block.components),
    donors: composite.blocks.map(block => ({ id: block.donor.id, label: block.label })) });
}
