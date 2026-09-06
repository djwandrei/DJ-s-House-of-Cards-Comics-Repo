export function formatStudioValue(value, unit = 'number') {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Unavailable';
  if (unit === 'percent') return `${(value * 100).toFixed(1)}%`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

export function compareBlueprints(first, second) {
  if (!first || !second || first.id === second.id) return [];
  const secondMetrics = new Map(second.metrics.map(metric => [metric.key, metric]));
  return first.metrics.map(metric => {
    const other = secondMetrics.get(metric.key);
    const comparable = metric.status === 'observed' && other?.status === 'observed'
      && metric.unit === other.unit && Number.isFinite(metric.value) && Number.isFinite(other.value);
    return { label: metric.label, unit: metric.unit, first: metric.value, second: other?.value ?? null,
      difference: comparable ? metric.value - other.value : null,
      method: 'First minus second within this team and pooled package window. Not an ability or impact ranking.' };
  });
}

export function toggleStudioPlayer(current, id) {
  if (current.includes(id)) return current.filter(value => value !== id);
  return current.length < 5 ? [...current, id] : current;
}

export function validRoster(payload, snapshot, team) {
  return payload?.snapshot === snapshot && payload?.team === team && Array.isArray(payload.players)
    && payload.players.length > 0 && payload.players.length <= 1000
    && new Set(payload.players.map(player => player.id)).size === payload.players.length
    && payload.players.every(player => /^p\d+$/.test(player.id) && typeof player.name === 'string'
      && Array.isArray(player.metrics) && player.tendencies && player.coverage);
}
