// Season-keyed donor recipes for Composite Forge. This module deliberately
// keeps season evidence separate from the pooled-window player blueprint.

export const SEASON_FORGE_BLOCKS = Object.freeze([
  { key: 'shooting', label: 'Shooting choices and accuracy', components: [
    ['fieldGoalAccuracy', 'Field-goal accuracy', 'percent'],
    ['threePointAccuracy', 'Three-point accuracy', 'percent'],
    ['threePointFrequency', 'Three-point frequency', 'percent'],
    ['freeThrowAccuracy', 'Free-throw accuracy', 'percent'],
  ] },
  { key: 'scoring', label: 'Scoring production', components: [['points', 'Points per game', 'perGame']] },
  { key: 'creation', label: 'Creation and ball security', components: [
    ['assists', 'Assists per game', 'perGame'], ['turnovers', 'Turnovers per game', 'perGame'],
  ] },
  { key: 'rebounding', label: 'Rebounding production', components: [['rebounds', 'Rebounds per game', 'perGame']] },
  { key: 'disruption', label: 'Recorded disruption', components: [
    ['steals', 'Steals per game', 'perGame'], ['blocks', 'Blocks per game', 'perGame'],
  ] },
].map(block => Object.freeze({ ...block, components: Object.freeze(block.components.map(([key, label, unit]) => Object.freeze({ key, label, unit }))) })));

const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() && value.length <= 320 ? value.trim() : null;
const round = value => finite(value) ? Math.round(value * 10000) / 10000 : null;
const profileKey = profile => text(profile?.key) || [profile?.playerId, profile?.seasonStartYear, profile?.phase, profile?.team, profile?.scope].join('|');

const FALLBACKS = Object.freeze({
  fieldGoalAccuracy: profile => profile?.shooting?.fieldGoalPercentage,
  threePointAccuracy: profile => profile?.shooting?.threePointPercentage,
  threePointFrequency: profile => profile?.shooting?.threePointAttemptShare,
  freeThrowAccuracy: profile => profile?.shooting?.freeThrowPercentage,
  points: profile => profile?.perGame?.points,
  assists: profile => profile?.perGame?.assists,
  turnovers: profile => profile?.perGame?.turnovers,
  rebounds: profile => profile?.perGame?.rebounds,
  steals: profile => profile?.perGame?.steals,
  blocks: profile => profile?.perGame?.blocks,
});

function validProfile(profile) {
  return object(profile) && integer(profile.seasonStartYear) && profile.seasonStartYear >= 1947
    && text(profile.phase) && ['team', 'all-teams'].includes(profile.scope)
    && text(profile.player || profile.playerName) && text(profile.team)
    && integer(profile.games) && profile.games >= 0;
}

export function validateSeasonDonorProfiles(profiles) {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 4000 || profiles.some(profile => !validProfile(profile))) {
    throw new Error('Load a bounded season donor catalog before building this recipe.');
  }
  const keys = profiles.map(profileKey);
  if (keys.some(key => !text(key)) || new Set(keys).size !== keys.length) throw new Error('Season donor catalog contains duplicate or invalid profile keys.');
  return profiles;
}

export function seasonComponentEvidence(profile, key, unit) {
  const source = object(profile?.components?.[key]) ? profile.components[key] : null;
  const raw = source?.value ?? FALLBACKS[key]?.(profile);
  const value = finite(raw) ? round(raw) : null;
  const knownGames = integer(source?.knownGames) ? source.knownGames : integer(profile?.games) ? profile.games : null;
  const denominator = integer(source?.denominator) && source.denominator >= 0 ? source.denominator
    : unit === 'perGame' ? profile?.games ?? null : null;
  const numerator = integer(source?.numerator) && source.numerator >= 0 ? source.numerator : null;
  const status = value === null || knownGames === null || knownGames < 1 ? 'unavailable'
    : knownGames < 5 ? 'limited_sample' : 'observed';
  return { key, unit, value, numerator, denominator, knownGames, status,
    reason: status === 'observed' ? 'Observed season component with a positive source denominator.'
      : status === 'limited_sample' ? 'Observed, but the season sample is small.' : 'This component is missing or failed its field gate.' };
}

export function createSeasonForgeRecipe(profiles, donors = {}) {
  validateSeasonDonorProfiles(profiles);
  if (!object(donors) || Object.keys(donors).some(key => !SEASON_FORGE_BLOCKS.some(block => block.key === key))) throw new Error('Unknown season composite block.');
  const available = new Set(profiles.map(profileKey));
  const selected = Object.fromEntries(SEASON_FORGE_BLOCKS.map(block => {
    const key = donors[block.key] ?? '';
    if (key && !available.has(key)) throw new Error('Season recipe references a profile outside the loaded catalog.');
    return [block.key, key];
  }));
  return { version: 1, scope: 'season-keyed-observed', donors: selected };
}

export function buildSeasonComposite(profiles, recipe, baselineKey = '') {
  validateSeasonDonorProfiles(profiles);
  if (recipe?.version !== 1 || recipe.scope !== 'season-keyed-observed') throw new Error('This season recipe has an unsupported version.');
  const clean = createSeasonForgeRecipe(profiles, recipe.donors);
  const byKey = new Map(profiles.map(profile => [profileKey(profile), profile]));
  const baseline = baselineKey ? byKey.get(baselineKey) : null;
  if (baselineKey && !baseline) throw new Error('The selected season baseline is not in this catalog.');
  const blocks = SEASON_FORGE_BLOCKS.map(block => {
    const donor = clean.donors[block.key] ? byKey.get(clean.donors[block.key]) : null;
    const components = block.components.map(spec => {
      const evidence = donor ? seasonComponentEvidence(donor, spec.key, spec.unit) : seasonComponentEvidence(null, spec.key, spec.unit);
      const reference = baseline ? seasonComponentEvidence(baseline, spec.key, spec.unit) : null;
      return { ...evidence, label: spec.label, baseline: reference?.value ?? null,
        difference: evidence.status === 'observed' && reference?.status === 'observed' ? round(evidence.value - reference.value) : null };
    });
    return { key: block.key, label: block.label,
      donor: donor ? { key: profileKey(donor), player: donor.player || donor.playerName, season: donor.season, phase: donor.phase, team: donor.team, scope: donor.scope } : null,
      components };
  });
  const assigned = blocks.filter(block => block.donor).length;
  const all = blocks.flatMap(block => block.components);
  return { recipe: clean, blocks, assigned, totalBlocks: SEASON_FORGE_BLOCKS.length,
    status: assigned < SEASON_FORGE_BLOCKS.length ? 'incomplete' : all.some(item => item.status !== 'observed') ? 'complete_with_caveats' : 'complete',
    note: 'Hypothetical season-keyed component recipe. Donor rows retain their own games and denominators; no combined player totals, RAPM, chemistry, physical feasibility or future performance is inferred.',
  };
}

export function seasonProfileLabel(profile) {
  if (!profile) return 'Unassigned';
  const player = profile.player || profile.playerName || 'Unnamed player';
  return `${player} · ${profile.season || profile.seasonStartYear} · ${profile.phase || 'unknown phase'} · ${profile.team || 'unknown team'}`;
}
