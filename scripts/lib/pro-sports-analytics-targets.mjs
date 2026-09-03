import path from 'node:path';

const ROOT = process.cwd();

/**
 * MLB and NFL analytics now live in distinct private Supabase projects. Keep
 * the destination alongside the sport key so local tooling cannot fall back
 * to a stale linked project or the retired combined warehouse.
 */
export const PRO_SPORTS_ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-sports-analytics');

export const PRO_SPORTS_ANALYTICS_TARGETS = Object.freeze({
  mlb: Object.freeze({
    sport: 'mlb',
    leagueCode: 'MLB',
    label: 'Baseball analytics',
    projectRef: 'sptahazcjnorayjkltdx',
    projectUrl: 'https://sptahazcjnorayjkltdx.supabase.co',
  }),
  nfl: Object.freeze({
    sport: 'nfl',
    leagueCode: 'NFL',
    label: 'Football analytics',
    projectRef: 'iuhjjwqfkohrrjqgpahh',
    projectUrl: 'https://iuhjjwqfkohrrjqgpahh.supabase.co',
  }),
});

export function proSportsAnalyticsTarget(sport) {
  const normalized = String(sport ?? '').trim().toLowerCase();
  const target = PRO_SPORTS_ANALYTICS_TARGETS[normalized];
  if (!target) throw new Error(`Unknown pro-sports analytics target: ${sport}.`);
  return target;
}
