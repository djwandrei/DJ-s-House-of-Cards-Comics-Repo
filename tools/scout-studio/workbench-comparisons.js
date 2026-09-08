import { validateAnalysisRoster, analyzeChemistry, sampleEvidence, buildComposite, createForgeRecipe } from './studio-analysis.js?v=20260906a';
import { analyzeGroupContextLens } from './context-lens.js?v=20260907d';

export const BLUEPRINT_QUESTIONS = Object.freeze({
  all: { keys: null, note: 'Review the full observable profile. None of these components is a latent talent grade or a forecast.' },
  shooting: { keys: ['threePointAccuracy', 'threePointFrequency', 'freeThrowAccuracy'], note: 'How often did this player take threes, and how accurately? Frequency describes choices; accuracy describes observed outcomes on its own attempt sample.' },
  creation: { keys: ['assists', 'turnovers', 'points', 'foulsDrawn'], note: 'What production accompanied creation responsibilities? Assists and turnovers do not measure decision speed, passing vision or ball dominance.' },
  rebounding: { keys: ['rebounds'], note: 'How much rebounding production was recorded? This rate is not adjusted for available rebound chances or defensive assignments.' },
  disruption: { keys: ['steals', 'blocks'], note: 'Which defensive events were recorded? Steals and blocks do not measure overall defense, containment, positioning or screen navigation.' },
});

const delta = (current, baseline) => Number.isFinite(current) && Number.isFinite(baseline) ? Math.round((current - baseline) * 10000) / 10000 : null;
const selectedNames = (roster, selection) => selection.map(id => roster.players.find(player => player.id === id).name);
function validateSelection(roster, view) {
  validateAnalysisRoster(roster);
  if (view?.snapshot !== roster.snapshot || view?.team !== roster.team || !Array.isArray(view.selection)
    || view.selection.length < 2 || view.selection.length > 5 || new Set(view.selection).size !== view.selection.length
    || view.selection.some(id => !roster.players.some(player => player.id === id))) throw new Error('Comparison reference belongs to another roster or selection.');
}
export function captureChemistry(roster, result, selection) {
  const report = analyzeChemistry(roster, result, selection);
  return { snapshot: roster.snapshot, team: roster.team, selection: [...selection], sample: report.sample,
    contexts: analyzeGroupContextLens(result.combination?.contexts || []).rows };
}
export function compareChemistry(roster, baseline, current) {
  validateSelection(roster, baseline); validateSelection(roster, current);
  if (baseline.selection.length !== current.selection.length) throw new Error('Compare groups of the same size; pairs and exact fives answer different questions.');
  const referenceSample = sampleEvidence(baseline.sample), currentSample = sampleEvidence(current.sample);
  const referenceRows = analyzeGroupContextLens(baseline.contexts).rows, currentRows = analyzeGroupContextLens(current.contexts).rows;
  const difference = (a, b) => Object.fromEntries(['offensiveRating', 'defensiveRating', 'netRating'].map(key => [key,
    a?.status === 'observed' && b?.status === 'observed' ? delta(a[key], b[key]) : null]));
  const keys = [...new Set([...referenceRows.map(row => row.key), ...currentRows.map(row => row.key)])];
  if (keys.length > 64) throw new Error('Comparison context scope is too large.');
  return { reference: { names: selectedNames(roster, baseline.selection), sample: referenceSample },
    current: { names: selectedNames(roster, current.selection), sample: currentSample },
    kept: selectedNames(roster, current.selection.filter(id => baseline.selection.includes(id))),
    removed: selectedNames(roster, baseline.selection.filter(id => !current.selection.includes(id))),
    added: selectedNames(roster, current.selection.filter(id => !baseline.selection.includes(id))),
    difference: difference(currentSample, referenceSample),
    contexts: keys.map(key => { const a = currentRows.find(row => row.key === key), b = referenceRows.find(row => row.key === key);
      return { key, label: (a || b).label, current: a ? sampleEvidence(a) : sampleEvidence(null),
        reference: b ? sampleEvidence(b) : sampleEvidence(null), difference: difference(a, b) }; }),
    note: 'Current minus reference uses separate observed groups, not a controlled substitution. Teammates, opponents, minutes and situations can differ; overlapping samples do not justify a difference confidence interval. A missing group or context stays unknown. Lower defensive rating means fewer points allowed.' };
}

export function compareForgeRecipes(roster, reference, current) {
  const a = buildComposite(roster, reference), b = buildComposite(roster, current);
  return { changedBlocks: b.blocks.filter((block, index) => block.donor?.id !== a.blocks[index].donor?.id).length,
    rows: b.blocks.flatMap((block, index) => block.components.map((metric, metricIndex) => {
      const earlier = a.blocks[index].components[metricIndex];
      return { key: metric.key, label: metric.label, unit: metric.unit, block: block.label,
        referenceDonor: a.blocks[index].donor?.name || 'Unassigned', currentDonor: block.donor?.name || 'Unassigned',
        reference: earlier.value, current: metric.value, referenceStatus: earlier.status, currentStatus: metric.status,
        difference: earlier.status === 'reviewable' && metric.status === 'reviewable' ? delta(metric.value, earlier.value) : null };
    })), note: 'Two hypothetical recipes, not two feasible players or projections. Differences require supported samples on both donors. Blocks retain their original denominators; there is no summed score or predicted synergy.' };
}
export function inspectForgeDependencies(roster, recipe) {
  const clean = createForgeRecipe(roster, recipe.donors);
  if (clean.snapshot !== recipe.snapshot || clean.team !== recipe.team || recipe.version !== 1) throw new Error('Recipe scope changed.');
  return [
    ['shooting', 'scoring', 'Copied shooting does not recalculate scoring production. A joint shot/usage model is still required.'],
    ['creation', 'scoring', 'Creation and scoring retain different donors’ roles. A shared usage/efficiency response is not fitted.'],
    ['rebounding', 'disruption', 'Defensive opportunities and assignments may differ. These copied rates do not establish overall defensive ability.'],
  ].filter(([a, b]) => clean.donors[a] && clean.donors[b] && clean.donors[a] !== clean.donors[b])
    .map(([a, b, reason]) => ({ blocks: [a, b], reason }));
}
