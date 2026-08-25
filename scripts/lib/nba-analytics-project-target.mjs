function normalizedSupabaseOrigin(value, label) {
  const candidate = String(value ?? '').trim();
  if (!candidate) throw new Error(`${label} is required.`);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${label} must be an HTTPS Supabase project URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${label} must be an HTTPS project origin without a path, query, or credential.`);
  }
  return parsed.origin;
}

/**
 * Require every analytics-only remote operation to name the intended project
 * separately from the generic process SUPABASE_URL. This prevents a stale
 * terminal environment from writing PBP/RAPM data to the commerce project.
 */
export function assertAnalyticsProjectTarget({ projectUrl, expectedProjectUrl } = {}) {
  const actual = normalizedSupabaseOrigin(projectUrl, 'SUPABASE_URL');
  const expected = normalizedSupabaseOrigin(expectedProjectUrl, 'NBA_ANALYTICS_SUPABASE_URL');
  if (actual !== expected) {
    throw new Error('SUPABASE_URL must exactly match NBA_ANALYTICS_SUPABASE_URL before an analytics operation can run.');
  }
  return actual;
}
