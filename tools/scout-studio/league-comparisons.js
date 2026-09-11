import { LEAGUE_POLICY, roundRobinSchedule } from './season-simulator.js?v=20260909m';
import { GAME_LAB_POLICY, createScenarioRandom } from './possession-simulator.js?v=20260909m';

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const change = (current, reference) => Math.round((current - reference) * 10000) / 10000;
const settingsLabels = Object.freeze({ cycles: 'Meetings per pair', playoffTeams: 'Playoff field', seriesLength: 'Series length',
  possessions: 'Possessions per team', attackWeight: 'Offense weight', trials: 'Repeated seasons', seed: 'Seed' });

// Keep one compact reference, not an entire simulation path or private source.
export function captureLeagueSummary(report) {
  const settings = report?.settings;
  if (report?.status !== 'complete' || report.modelVersion !== LEAGUE_POLICY.version || report.gameModelVersion !== GAME_LAB_POLICY.version
    || typeof report.snapshot !== 'string' || !/^s[a-f0-9]{24}$/.test(report.snapshot) || !GAME_LAB_POLICY.seasons.includes(report.season) || !settings
    || !integer(settings.trials, LEAGUE_POLICY.minTrials, LEAGUE_POLICY.maxTrials)
    || ![0, 2, 4, 8, 16].includes(settings.playoffTeams) || ![1, 3, 5, 7].includes(settings.seriesLength)
    || !integer(settings.possessions, 60, 140) || !finite(settings.attackWeight, 0, 1)) throw new Error('A complete, compatible league result is required.');
  createScenarioRandom(report.seed);
  const ids = report.teams?.map(row => row.team), schedule = roundRobinSchedule(ids, settings.cycles);
  if (settings.playoffTeams > ids.length || report.regularGamesPerExperiment !== schedule.length
    || (schedule.length + Math.max(0, settings.playoffTeams - 1) * settings.seriesLength) * settings.trials > LEAGUE_POLICY.maxGames) {
    throw new Error('League schedule and workload do not reconcile.');
  }
  const gamesPerTeam = (ids.length - 1) * settings.cycles, trials = settings.trials;
  const teams = report.teams.map(row => {
    if (!finite(row.averageWins, 0, gamesPerTeam) || Math.abs(row.averageWins * trials - Math.round(row.averageWins * trials)) > 1e-7
      || !integer(row.playoffAppearances, 0, trials)
      || (!settings.playoffTeams ? row.titles !== null || row.playoffAppearances !== 0 : !integer(row.titles, 0, row.playoffAppearances))
      || !Array.isArray(row.seeds) || row.seeds.length !== ids.length || row.seeds.some(count => !integer(count, 0, trials))
      || row.seeds.reduce((sum, count) => sum + count, 0) !== trials
      || row.seeds.slice(0, settings.playoffTeams).reduce((sum, count) => sum + count, 0) !== row.playoffAppearances) {
      throw new Error('League outcome counts do not reconcile.');
    }
    return { team: row.team, averageWins: row.averageWins, playoffAppearances: row.playoffAppearances, titles: row.titles, seeds: [...row.seeds] };
  }).sort((a, b) => a.team.localeCompare(b.team, 'en', { numeric: true }));
  if (teams.reduce((sum, row) => sum + row.averageWins, 0) > schedule.length + 1e-7
    || teams.some((_, index) => teams.reduce((sum, row) => sum + row.seeds[index], 0) !== trials)
    || (!settings.playoffTeams ? report.unresolvedTitles !== null : !integer(report.unresolvedTitles, 0, trials)
      || teams.reduce((sum, row) => sum + row.titles, 0) + report.unresolvedTitles !== trials)) throw new Error('League totals do not reconcile.');
  return { status: 'complete', modelVersion: report.modelVersion, gameModelVersion: report.gameModelVersion,
    snapshot: report.snapshot, season: report.season, seed: report.seed, regularGamesPerExperiment: schedule.length,
    settings: Object.fromEntries(Object.keys(settingsLabels).filter(key => key !== 'seed').map(key => [key, settings[key]])),
    teams, unresolvedTitles: report.unresolvedTitles };
}

export function compareLeagueScenarios(referenceReport, currentReport) {
  const reference = captureLeagueSummary(referenceReport), current = captureLeagueSummary(currentReport);
  if (reference.snapshot !== current.snapshot || reference.season !== current.season
    || reference.teams.some((row, index) => row.team !== current.teams[index]?.team) || reference.teams.length !== current.teams.length) {
    throw new Error('Compare the same franchises, season and Scout snapshot. Pin a new reference after changing that scope.');
  }
  const changes = Object.entries(settingsLabels).flatMap(([key, label]) => {
    const before = key === 'seed' ? reference.seed : reference.settings[key], after = key === 'seed' ? current.seed : current.settings[key];
    return before === after ? [] : [{ key, label, reference: before, current: after }];
  });
  if (!changes.length && (JSON.stringify(reference.teams) !== JSON.stringify(current.teams) || reference.unresolvedTitles !== current.unresolvedTitles)) {
    throw new Error('Identical league settings returned different results. Refresh the checkpoint instead of comparing inconsistent evidence.');
  }
  const referenceGames = (reference.teams.length - 1) * reference.settings.cycles, currentGames = (current.teams.length - 1) * current.settings.cycles;
  const frequency = (count, trials) => count === null ? null : 100 * count / trials;
  const outcome = (a, b) => ({ reference: a, current: b, difference: a === null || b === null ? null : change(b, a) });
  return { changes, identical: changes.length === 0, gamesPerTeam: { reference: referenceGames, current: currentGames },
    repetitionChanged: changes.some(row => ['seed', 'trials'].includes(row.key)),
    structureChanged: changes.some(row => ['cycles', 'playoffTeams', 'seriesLength'].includes(row.key)),
    teams: current.teams.map((row, index) => {
      const before = reference.teams[index];
      return { team: row.team, averageWins: { ...outcome(before.averageWins, row.averageWins),
        difference: referenceGames === currentGames ? change(row.averageWins, before.averageWins) : null },
        winShare: outcome(frequency(before.averageWins, referenceGames), frequency(row.averageWins, currentGames)),
        qualified: outcome(reference.settings.playoffTeams ? frequency(before.playoffAppearances, reference.settings.trials) : null,
          current.settings.playoffTeams ? frequency(row.playoffAppearances, current.settings.trials) : null),
        title: outcome(frequency(before.titles, reference.settings.trials), frequency(row.titles, current.settings.trials)) };
    }), note: 'Current minus pinned reference describes two experiments, not a causal effect or NBA forecast. The same seed is repeatable, but overtime and bracket paths can consume different random draws; this is not a paired statistical test. No confidence or significance claim is attached to a difference.' };
}
