import { GAME_LAB_POLICY, createScenarioRandom, createGameSampler, teamGameEvidence } from './possession-simulator.js?v=20260908a';

export const LEAGUE_POLICY = Object.freeze({ version: 'scout-round-robin-v1', maxTeams: 30, maxGames: 100000, minTrials: 50, maxTrials: 500 });
const publicTeam = id => typeof id === 'string' && /^t(?:[0-9]|[12][0-9])$/.test(id);
const orderedIds = ids => [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
function teamIds(ids) {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > LEAGUE_POLICY.maxTeams || ids.some(id => !publicTeam(id))
    || new Set(ids).size !== ids.length) throw new Error('Choose 2–30 distinct Scout teams.');
  return orderedIds(ids);
}

export function roundRobinSchedule(ids, cycles = 2) {
  const sorted = teamIds(ids);
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 4) throw new Error('Use one through four round-robin cycles.');
  const schedule = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    let ring = sorted.length % 2 ? [...sorted, null] : [...sorted];
    for (let round = 0; round < ring.length - 1; round++) {
      for (let pair = 0; pair < ring.length / 2; pair++) {
        const left = ring[pair], right = ring[ring.length - 1 - pair];
        if (left === null || right === null) continue;
        const reverse = (round + pair + cycle) % 2 === 1;
        schedule.push({ id: `g${schedule.length + 1}`, round: cycle * (ring.length - 1) + round + 1,
          home: reverse ? right : left, away: reverse ? left : right });
      }
      ring = [ring[0], ring.at(-1), ...ring.slice(1, -1)];
    }
  }
  return schedule;
}

export function rankLeagueTable(rows, random) {
  teamIds(rows?.map(row => row.team));
  if (typeof random !== 'function' || rows.some(row => ['wins', 'losses', 'ties', 'pointsFor', 'pointsAgainst']
    .some(key => !Number.isSafeInteger(row[key]) || row[key] < 0))) throw new Error('Invalid standings evidence.');
  const table = [...rows].sort((a, b) => a.team.localeCompare(b.team, 'en', { numeric: true })).map(row => ({ ...row,
    played: row.wins + row.losses + row.ties, tablePoints: row.wins + 0.5 * row.ties, differential: row.pointsFor - row.pointsAgainst }));
  table.sort((a, b) => b.tablePoints - a.tablePoints || b.differential - a.differential);
  for (let start = 0; start < table.length;) {
    let end = start + 1;
    while (end < table.length && table[end].tablePoints === table[start].tablePoints && table[end].differential === table[start].differential) end++;
    // An explicit seeded lottery is fairer than silently promoting a team by
    // its opaque handle. These are custom rules, not official NBA tiebreakers.
    for (let index = end - 1; index > start; index--) {
      const value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid random stream.');
      const swap = start + Math.floor(value * (index - start + 1));
      [table[index], table[swap]] = [table[swap], table[index]];
    }
    for (let index = start; index < end; index++) table[index].seedLottery = end - start > 1;
    start = end;
  }
  return table.map((row, index) => ({ ...row, seed: index + 1 }));
}

export function playoffSeedOrder(size) {
  if (![2, 4, 8, 16].includes(size)) throw new Error('Use a 2-, 4-, 8- or 16-team bracket.');
  let seeds = [1, 2];
  while (seeds.length < size) seeds = seeds.flatMap(seed => [seed, seeds.length * 2 + 1 - seed]);
  return seeds;
}
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([10, 50, 90].map(percent => [percent, sorted[Math.max(0, Math.ceil(sorted.length * percent / 100) - 1)]]));
};

export async function simulateLeague({ teams, season, seed, trials = 100, cycles = 2, playoffTeams = 4, seriesLength = 3,
  possessions = 100, attackWeight = 0.5 }, { signal, onProgress = () => {}, yieldEveryBatch = async () => {} } = {}) {
  const ids = teamIds(teams?.map(team => team?.team)), schedule = roundRobinSchedule(ids, cycles);
  if (!Number.isInteger(trials) || trials < LEAGUE_POLICY.minTrials || trials > LEAGUE_POLICY.maxTrials
    || ![0, 2, 4, 8, 16].includes(playoffTeams) || playoffTeams > ids.length || ![1, 3, 5, 7].includes(seriesLength)) {
    throw new Error('Use 50–500 experiments, a supported bracket no larger than the league, and an odd 1–7 game series.');
  }
  if ((schedule.length + Math.max(0, playoffTeams - 1) * seriesLength) * trials > LEAGUE_POLICY.maxGames) throw new Error('This setup exceeds the 100,000-game work limit. Reduce cycles, trials or bracket size.');
  const snapshot = teams[0].snapshot;
  if (teams.some(team => team.snapshot !== snapshot)) throw new Error('Every league team must use one Scout snapshot.');
  const evidence = teams.map(team => teamGameEvidence(team, season));
  if (evidence.some(team => team.status !== 'ready')) throw new Error('Every league team needs validated, observed season samples.');
  const random = createScenarioRandom(seed), byId = new Map(teams.map(team => [team.team, team])), samplers = new Map();
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    samplers.set(`${ids[a]}|${ids[b]}`, createGameSampler({ a: byId.get(ids[a]), b: byId.get(ids[b]), season, possessions, attackWeight }));
  }
  let gamesPlayed = 0, unresolvedTitles = 0, example = null;
  const totals = new Map(ids.map(team => [team, { team, wins: [], playoffAppearances: 0, titles: 0, seedLottery: 0, seeds: Array(ids.length).fill(0) }]));
  const cancelled = () => { if (signal?.aborted) throw new DOMException('League cancelled.', 'AbortError'); };
  async function play(a, b) {
    cancelled();
    const ordered = orderedIds([a, b]), result = samplers.get(ordered.join('|')).play(random);
    const forward = ordered[0] === a;
    const game = { a, b, scoreA: forward ? result.a : result.b, scoreB: forward ? result.b : result.a,
      winner: result.winner === 'unresolved' ? null : ordered[result.winner === 'a' ? 0 : 1], overtimes: result.overtimes };
    gamesPlayed++;
    if (gamesPlayed % 50 === 0) { await yieldEveryBatch(); cancelled(); }
    return game;
  }
  for (let trial = 0; trial < trials; trial++) {
    cancelled();
    const table = new Map(ids.map(team => [team, { team, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 }]));
    const firstGames = [], bracket = [];
    for (const scheduled of schedule) {
      const game = await play(scheduled.home, scheduled.away);
      const a = table.get(game.a), b = table.get(game.b);
      a.pointsFor += game.scoreA; a.pointsAgainst += game.scoreB; b.pointsFor += game.scoreB; b.pointsAgainst += game.scoreA;
      if (game.winner === null) { a.ties++; b.ties++; }
      else { table.get(game.winner).wins++; table.get(game.winner === game.a ? game.b : game.a).losses++; }
      if (!trial) firstGames.push({ ...scheduled, ...game });
    }
    const ranked = rankLeagueTable([...table.values()], random);
    for (const row of ranked) {
      const total = totals.get(row.team); total.wins.push(row.wins); total.seeds[row.seed - 1]++;
      if (row.seed <= playoffTeams) total.playoffAppearances++;
      if (row.seedLottery) total.seedLottery++;
    }
    let champion = null;
    if (playoffTeams) {
      let field = playoffSeedOrder(playoffTeams).map(seed => ranked[seed - 1].team), round = 1;
      while (field.length > 1) {
        const next = [];
        for (let index = 0; index < field.length; index += 2) {
          const a = field[index], b = field[index + 1], series = { a, b, winsA: 0, winsB: 0, winner: null, games: [] };
          if (a && b) for (let gameIndex = 0; gameIndex < seriesLength; gameIndex++) {
            const game = await play(a, b);
            if (!trial) series.games.push(game);
            if (!game.winner) break;
            if (game.winner === a) series.winsA++; else series.winsB++;
            if (Math.max(series.winsA, series.winsB) > seriesLength / 2) { series.winner = game.winner; break; }
          }
          next.push(series.winner);
          if (!trial) bracket.push({ round, ...series });
        }
        field = next; round++;
      }
      champion = field[0];
      if (champion) totals.get(champion).titles++; else unresolvedTitles++;
    }
    if (!trial) example = { table: ranked, schedule: firstGames, bracket, champion };
    onProgress((trial + 1) / trials);
  }
  cancelled();
  return { status: 'complete', modelVersion: LEAGUE_POLICY.version, gameModelVersion: GAME_LAB_POLICY.version, snapshot, season, seed,
    settings: { trials, cycles, playoffTeams, seriesLength, possessions, attackWeight }, gamesPlayed,
    regularGamesPerExperiment: schedule.length, unresolvedTitles: playoffTeams ? unresolvedTitles : null, example,
    teams: [...totals.values()].map(row => ({ team: row.team, averageWins: row.wins.reduce((sum, value) => sum + value, 0) / trials,
      winQuantiles: quantiles(row.wins), seeds: row.seeds, playoffAppearances: row.playoffAppearances,
      titles: playoffTeams ? row.titles : null, seedLottery: row.seedLottery })),
    note: 'Custom round-robin scenarios, not NBA season forecasts. Table points are wins plus half a point per unresolved tie; then point differential and a disclosed seeded lottery break ties. Home/away labels balance the schedule but carry no fitted advantage. Pace and team-season distributions stay fixed; injuries, rotations, rest and travel are not modeled.' };
}
