import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { requireSiteAdmin, SiteAdminError } from '../../supabase/functions/_shared/admin-auth.ts';
import { readJsonBody } from '../../supabase/functions/_shared/http.ts';

// Execute the actual Edge handler with isolated service clients. This tests
// authorization order and bounded requests, not just strings in its source.
const source = fs.readFileSync(new URL('../../supabase/functions/lineup-scout-preview/index.ts', import.meta.url), 'utf8');
function handler({ authenticated = true, enabled = true, target = 'https://fbbmuqbdpgsmvnezowwn.supabase.co' } = {}) {
  let handle, calls = 0;
  const admin = { auth: { getUser: async () => authenticated ? { data: { user: { id: 'test-user', email: 'test@example.invalid', user_metadata: { admin: true } } } } : { error: 'expired' } },
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: enabled ? { id: 'test-user' } : null }) }) };
  const nba = { rpc: async (name, args) => { calls++; assert.equal(name, 'get_nba_lineup_scout_preview'); assert.deepEqual(Object.keys(args).sort(), ['p_player_ids', 'p_season_end_year', 'p_team_code']); return { data: { contractVersion: 1 } }; } };
  const env = { SUPABASE_URL: 'https://commerce.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-only', ANALYTICS_SUPABASE_URL: target, ANALYTICS_SUPABASE_SERVICE_ROLE_KEY: 'test-only' };
  new Function('Deno', 'createClient', 'requireSiteAdmin', 'SiteAdminError', 'readJsonBody', stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm, '')))(
    { env: { get: key => env[key] }, serve: fn => { handle = fn; } }, url => url === env.SUPABASE_URL ? admin : nba, requireSiteAdmin, SiteAdminError, readJsonBody,
  );
  return { run: handle, calls: () => calls };
}
const body = { seasonEndYear: 2026, team: 'MIN', playerIds: ['00000000-0000-0000-0000-000000000001'] };
const request = (payload = body, headers = {}) => new Request('https://commerce.invalid/functions/v1/lineup-scout-preview', {
  method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload),
});
test('only a validated site administrator can query Scout', async () => {
  for (const options of [{ authenticated: false }, { enabled: false }]) {
    const h = handler(options); const response = await h.run(request());
    assert.equal(response.status, options.authenticated === false ? 401 : 403);
    assert.equal(h.calls(), 0);
  }
  const h = handler();
  assert.equal((await h.run(request(body, { Authorization: '' }))).status, 401);
  assert.equal(h.calls(), 0);
});
test('authorized output is no-store and uses only the dedicated NBA target', async () => {
  const h = handler(); const response = await h.run(request());
  assert.equal(response.status, 200); assert.equal(h.calls(), 1);
  assert.match(response.headers.get('cache-control'), /private, no-store/);
  assert.deepEqual(await response.json(), { contractVersion: 1 });
  const wrong = handler({ target: 'https://wrong.invalid' });
  assert.equal((await wrong.run(request())).status, 503); assert.equal(wrong.calls(), 0);
});
test('origin, malformed UUIDs, oversized payloads and unsupported methods fail closed', async () => {
  const h = handler();
  assert.equal((await h.run(request(body, { Origin: 'https://untrusted.invalid' }))).status, 403);
  assert.equal((await h.run(request({ ...body, playerIds: ['name-is-not-an-id'] }))).status, 400);
  assert.equal((await h.run(request({ ...body, junk: 'x'.repeat(50 * 1024) }))).status, 400);
  assert.equal((await h.run(new Request('https://commerce.invalid/'))).status, 405);
  assert.equal(h.calls(), 0);
});
