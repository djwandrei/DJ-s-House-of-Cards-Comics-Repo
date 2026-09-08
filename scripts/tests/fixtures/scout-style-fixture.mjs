import { fixtureSource } from './scout-studio-fixture.mjs';

// Synthetic component variation for matching tests, never a production source.
export async function styleRoster(team = 't0') {
  const roster = await fixtureSource().roster(team);
  const increments = { threePointAccuracy: -1, threePointFrequency: 10, freeThrowAccuracy: -2,
    points: 40, assists: 15, turnovers: 4, rebounds: 20, steals: 3, blocks: 2, foulsDrawn: 5 };
  roster.players.forEach((player, index) => player.metrics.forEach(metric => {
    if (metric.key !== 'threePointAccuracy') metric.numerator += increments[metric.key] * index;
    metric.value = Math.round(metric.numerator / metric.denominator * (metric.unit === 'per100' ? 100 : 1) * 10000) / 10000;
  }));
  return roster;
}
