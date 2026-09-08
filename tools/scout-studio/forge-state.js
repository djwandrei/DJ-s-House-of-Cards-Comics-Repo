import { createForgeRecipe, FORGE_BLOCKS, validateAnalysisRoster } from './studio-analysis.js?v=20260906a';
import { workshopStorageKey, loadWorkshopDraft, saveWorkshopDraft, clearWorkshopDraft } from '../workshop/workshop-state.js?v=20260906a';

// Reuse local-only draft helpers. Handles belong to one exact snapshot + team;
// never remap a saved donor by name or by their position in a newer roster.
function definition(roster) {
  validateAnalysisRoster(roster);
  return { id: `composite-forge-${roster.snapshot}-${roster.team}`,
    fields: FORGE_BLOCKS.map(block => ({ id: block.key, defaultValue: '',
      options: ['', ...roster.players.map(player => player.id)].map(value => ({ value })) })) };
}
export function saveForgeDraft(storage, roster, recipe) {
  if (recipe?.version !== 1 || recipe.snapshot !== roster.snapshot || recipe.team !== roster.team) throw new Error('Recipe scope changed; reload the workbench.');
  const clean = createForgeRecipe(roster, recipe.donors);
  saveWorkshopDraft(storage, definition(roster), clean.donors);
  return clean;
}
export function loadForgeDraft(storage, roster) {
  const target = definition(roster);
  try {
    const text = storage?.getItem(workshopStorageKey(target.id));
    if (!text) return { status: 'empty', recipe: null };
    if (text.length > 4096) return { status: 'invalid', recipe: null };
    const parsed = JSON.parse(text);
    // Validate before the generic helper can normalize bad options to defaults.
    if (!parsed?.values || Object.keys(parsed.values).length !== FORGE_BLOCKS.length) return { status: 'invalid', recipe: null };
    const clean = createForgeRecipe(roster, parsed.values);
    const draft = loadWorkshopDraft({ getItem: () => text }, target);
    return draft ? { status: 'loaded', recipe: clean } : { status: 'invalid', recipe: null };
  } catch { return { status: 'unavailable', recipe: null }; }
}
export function clearForgeDraft(storage, roster) {
  if (!storage?.removeItem) throw new Error('Browser storage is unavailable.');
  clearWorkshopDraft(storage, definition(roster));
}
