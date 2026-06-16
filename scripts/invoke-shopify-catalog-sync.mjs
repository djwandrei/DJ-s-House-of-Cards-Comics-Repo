const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const action = String(process.argv[2] || '').trim();
const payloadArg = String(process.env.SHOPIFY_SYNC_PAYLOAD_JSON || process.argv[3] || '{}').trim();

if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !serviceRoleKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running Shopify catalog actions.');
  process.exit(1);
}

if (!action) {
  console.error('Usage: node .\\scripts\\invoke-shopify-catalog-sync.mjs <action> [jsonPayload]');
  console.error('PowerShell users can set SHOPIFY_SYNC_PAYLOAD_JSON to avoid native argv quote parsing.');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(payloadArg || '{}');
} catch (error) {
  console.error(`Invalid JSON payload: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const response = await fetch(`${supabaseUrl}/functions/v1/shopify-catalog-sync`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${serviceRoleKey}`,
    apikey: serviceRoleKey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ ...payload, action })
});

const text = await response.text();
let result;
try {
  result = JSON.parse(text);
} catch {
  result = { error: text || `HTTP ${response.status}` };
}

console.log(JSON.stringify(result, null, 2));
if (!response.ok || result?.ok !== true) process.exitCode = 1;
