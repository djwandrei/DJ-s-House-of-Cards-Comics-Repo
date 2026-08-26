const LINEUP_CACHE_FAMILY_PREFIX = "djhc-lineup-lab-bref-supabase-";
const DEFAULT_MAX_ENTRIES = 24;

function cacheKeys(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === "string" && key.startsWith(LINEUP_CACHE_FAMILY_PREFIX)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Bound device-local team-season snapshots without touching unrelated site
 * storage. Obsolete schema prefixes and malformed entries are removed first;
 * the newest entries for the active prefix are retained.
 */
export function pruneLineupLabDatasetCache(storage, options = {}) {
  const activePrefix = String(options.activePrefix || "");
  const preserveKey = String(options.preserveKey || "");
  const requestedLimit = Number(options.maxEntries);
  const maxEntries = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : DEFAULT_MAX_ENTRIES;
  const summary = { ok: false, kept: 0, removed: 0 };

  if (!storage || !activePrefix.startsWith(LINEUP_CACHE_FAMILY_PREFIX)) return summary;

  try {
    const currentEntries = [];
    const removals = new Set();
    for (const key of cacheKeys(storage)) {
      if (!key.startsWith(activePrefix)) {
        removals.add(key);
        continue;
      }
      try {
        const entry = JSON.parse(storage.getItem(key) || "null");
        if (!entry || !Number.isFinite(Number(entry.cachedAt))) {
          removals.add(key);
          continue;
        }
        currentEntries.push({ key, cachedAt: Number(entry.cachedAt) });
      } catch {
        removals.add(key);
      }
    }

    currentEntries.sort((left, right) => (
      right.cachedAt - left.cachedAt || left.key.localeCompare(right.key)
    ));
    const keep = new Set();
    const preserved = currentEntries.find((entry) => entry.key === preserveKey);
    if (preserved) keep.add(preserved.key);
    for (const entry of currentEntries) {
      if (keep.size >= maxEntries) break;
      keep.add(entry.key);
    }
    for (const entry of currentEntries) {
      if (!keep.has(entry.key)) removals.add(entry.key);
    }
    for (const key of removals) storage.removeItem(key);

    return {
      ok: true,
      kept: keep.size,
      removed: removals.size,
    };
  } catch {
    // Storage can be blocked or become unavailable between calls. Caching is an
    // optional optimization, so the page must continue without surfacing an
    // error or touching any other local data.
    return summary;
  }
}
