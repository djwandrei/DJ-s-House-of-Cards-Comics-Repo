// Public, descriptive decision context only. Never ranks a pick or reads Scout inputs.
export const CONTEXT_STATS = Object.freeze([
  ['points', 'Points'], ['assists', 'Assists'], ['rebounds', 'Rebounds'], ['turnovers', 'Turnovers'],
].map(([key, label]) => Object.freeze({ key, label })));
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function publicStat(player, key) {
  const value = player?.stats?.[key];
  return CONTEXT_STATS.some(stat => stat.key === key) && finite(value) && value >= 0 ? value : null;
}
export function publicStatLine(player) {
  return CONTEXT_STATS.slice(0, 3).flatMap(({ key, label }) => {
    const value = publicStat(player, key);
    return value === null ? [] : [`${value.toFixed(1)} ${label.toLowerCase()}`];
  }).join(' · ') || 'Public source stats unavailable';
}
export function comparePublicPlayers(players, baseline = null) {
  return CONTEXT_STATS.map(({ key, label }) => ({ key, label, baseline: publicStat(baseline, key),
    values: players.map(player => publicStat(player, key)),
  }));
}
export function boardRules(board) {
  const minimums = board?.positionMinimums;
  if (!minimums || !['G', 'F', 'C'].every(key => Number.isInteger(minimums[key]) && minimums[key] >= 0)) return 'Use only the legal candidates shown on this board.';
  return `Role minimums: ${minimums.G} guards · ${minimums.F} forwards · ${minimums.C} centers. Only the listed candidates are legal.`;
}
export function draftNeeds(deck, selections = []) {
  const rounds = deck?.rounds;
  if (!Array.isArray(rounds) || rounds.length !== 5 || !Array.isArray(selections) || selections.length > 5
    || new Set(selections).size !== selections.length
    || selections.some((id, index) => !rounds[index]?.candidates?.some(player => player.id === id))) return null;
  // Slots are assigned by the fixed board, not inferred from box-score statistics.
  return { picked: selections.length, remaining: rounds.slice(selections.length).map(round => ({ title: round.title, slot: round.slot })),
    filled: rounds.slice(0, selections.length).map(round => ({ title: round.title, slot: round.slot })),
    note: 'These are board slots, not measured skills or chemistry. Each pick keeps the other rounds’ candidates unchanged.' };
}
export function validOnePickAlternatives(deck, selections, outcome) {
  if (!draftNeeds(deck, selections) || selections.length !== 5 || !finite(outcome?.roundScore)
    || !Array.isArray(outcome.selectionIds) || JSON.stringify(outcome.selectionIds) !== JSON.stringify(selections)) return [];
  return (Array.isArray(outcome.onePickAlternatives) ? outcome.onePickAlternatives : []).slice(0, 3).flatMap(alternative => {
    const index = deck.rounds.findIndex(round => round.id === alternative?.roundId);
    if (index < 0 || alternative.fromPlayerId !== selections[index] || alternative.toPlayerId === selections[index]) return [];
    const to = deck.rounds[index].candidates.find(player => player.id === alternative.toPlayerId);
    const from = deck.rounds[index].candidates.find(player => player.id === selections[index]);
    if (!to || !from || !Number.isInteger(alternative.rank) || alternative.rank < 1 || alternative.rank > deck.publishedPathCount
      || !finite(alternative.roundScore) || alternative.roundScore < 0 || alternative.roundScore > 100
      || !finite(alternative.scoreChange) || alternative.scoreChange <= 0
      || Math.abs(alternative.roundScore - outcome.roundScore - alternative.scoreChange) > 0.011) return [];
    return [{ index, title: deck.rounds[index].title, from, to, rank: alternative.rank, scoreChange: alternative.scoreChange }];
  });
}
