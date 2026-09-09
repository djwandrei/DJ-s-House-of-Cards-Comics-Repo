import { assertScoutDailyGamePublicBoard } from './scout-daily-game-client.js?v=20260908a';

// A tab-session learning record, not a leaderboard, saved answer key, or score
// authority. Only successfully revealed legal decisions can enter this ledger.
export function createDecisionHistory(board) {
  assertScoutDailyGamePublicBoard(board);
  const gameKind = board.gameKind;
  const groups = new Map();
  const definitions = gameKind === 'fix-the-five' ? board.challenges : [board.deck];
  for (const definition of definitions) {
    if (groups.has(definition.id)) throw new Error('Duplicate decision scope.');
    const rounds = gameKind === 'fix-the-five' ? [definition] : definition.rounds;
    if (rounds.some(round => round.candidates.some(player => ['id', 'name'].some(key => typeof player[key] !== 'string' || !player[key].trim() || player[key].length > 160)))) throw new Error('Decision identity is invalid.');
    groups.set(definition.id, { definition: structuredClone(definition), choices: new Map(), order: [], current: null });
  }
  return {
    record(id, selectionIds, outcome) {
      const group = groups.get(id), definition = group?.definition;
      if (!group || !Array.isArray(selectionIds) || new Set(selectionIds).size !== selectionIds.length) throw new Error('Decision scope is invalid.');
      const rounds = gameKind === 'fix-the-five' ? [definition] : definition.rounds;
      if (selectionIds.length !== rounds.length || selectionIds.some((value, index) => !rounds[index].candidates.some(player => player.id === value))) {
        throw new Error('History requires a legal selection from this board.');
      }
      const limit = gameKind === 'fix-the-five' ? 3 : definition.publishedPathCount;
      if (!Number.isInteger(outcome?.rank) || outcome.rank < 1 || !Number.isInteger(limit) || outcome.rank > limit
        || !Number.isInteger(outcome.roundScore) || outcome.roundScore < 0 || outcome.roundScore > 100
        || (gameKind === 'fix-the-five' ? outcome.candidateId !== selectionIds[0]
          : JSON.stringify(outcome.selectionIds) !== JSON.stringify(selectionIds))) throw new Error('History requires a matching validated reveal.');
      const key = JSON.stringify(selectionIds), previous = group.choices.get(key);
      if (previous && (previous.rank !== outcome.rank || previous.score !== outcome.roundScore)) throw new Error('This fixed-board result changed. Reload the board before comparing attempts.');
      if (!previous) {
        if (group.choices.size >= 243) throw new Error('Decision history reached its bounded session limit.');
        const entry = { number: group.choices.size + 1, selection: [...selectionIds],
          names: selectionIds.map((value, index) => rounds[index].candidates.find(player => player.id === value).name),
          rank: outcome.rank, score: outcome.roundScore };
        group.choices.set(key, entry); group.order.push(key);
      }
      group.current = key;
      return this.summary(id);
    },
    summary(id) {
      const group = groups.get(id);
      if (!group) throw new Error('Decision scope is invalid.');
      const entries = group.order.map(key => group.choices.get(key));
      const best = [...entries].sort((a, b) => a.rank - b.rank || a.number - b.number)[0] || null;
      const current = group.choices.get(group.current) || null, first = entries[0] || null;
      return structuredClone({ count: entries.length, first, best, current, recent: entries.slice(-8),
        rankChange: first && current ? first.rank - current.rank : null,
        note: 'First checked means the first revealed choice in this tab session, not an official first attempt. Retrying the same choice does not add a decision. Reloading clears this learning history; existing saved picks and personal-best records are separate.' });
    },
  };
}
