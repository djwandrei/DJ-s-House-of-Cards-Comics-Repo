const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !serviceRoleKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this verifier.');
  process.exit(1);
}

const response = await fetch(`${supabaseUrl}/functions/v1/shopify-catalog-sync`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ action: 'verify-catalog' })
});

const text = await response.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = { error: text || `HTTP ${response.status}` };
}

console.log(JSON.stringify(payload, null, 2));
if (!response.ok || payload?.ok !== true || payload?.result?.safeForChannelOnboarding !== true) {
  process.exitCode = 1;
}
