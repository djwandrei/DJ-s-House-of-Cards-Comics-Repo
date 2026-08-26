import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let assertions = 0;

function read(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    failures.push(`${relativePath}: required file is missing`);
    return '';
  }
  return readFileSync(fullPath, 'utf8');
}

function assert(relativePath, description, predicate) {
  assertions += 1;
  const content = read(relativePath);
  const passed = typeof predicate === 'function'
    ? predicate(content)
    : predicate.test(content);
  if (!passed) failures.push(`${relativePath}: ${description}`);
}

function containsAll(...needles) {
  return (content) => needles.every((needle) => content.includes(needle));
}

const requiredBaseMigrations = [
  '20260810000000_catalog_base.sql',
  '20260810010000_account_base.sql',
  '20260810020000_checkout_base.sql',
  '20260810030000_marketplace_base.sql',
  '20260815000000_backend_hardening.sql',
  '20260815010000_operational_resilience.sql',
  '20260825070000_public_catalog_projection.sql',
  '20260825071000_guest_checkout_reservation_hardening.sql'
];
const migrationDirectory = path.join(ROOT, 'supabase', 'migrations');
const migrations = existsSync(migrationDirectory)
  ? readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql')).sort()
  : [];
for (const migration of requiredBaseMigrations) {
  assertions += 1;
  if (!migrations.includes(migration)) failures.push(`supabase/migrations/${migration}: required migration is missing`);
}
assertions += 1;
if (migrations.indexOf('20260815000000_backend_hardening.sql') <= migrations.indexOf('20260810030000_marketplace_base.sql')) {
  failures.push('supabase/migrations: backend hardening must run after all canonical base migrations');
}
assertions += 1;
if (migrations.indexOf('20260815010000_operational_resilience.sql') <= migrations.indexOf('20260815000000_backend_hardening.sql')) {
  failures.push('supabase/migrations: operational resilience must run after backend hardening');
}
assertions += 1;
if (migrations.indexOf('20260825071000_guest_checkout_reservation_hardening.sql') <= migrations.indexOf('20260815000000_backend_hardening.sql')) {
  failures.push('supabase/migrations: guest checkout reservation hardening must run after backend hardening');
}

assert(
  'supabase/migrations/20260810010000_account_base.sql',
  'account bootstrap must define its trigger helper before use and must not reference later checkout tables',
  (content) => {
    const helperIndex = content.indexOf('create or replace function public.set_checkout_records_updated_at()');
    const triggerIndex = content.indexOf('create trigger customer_account_profiles_set_updated_at');
    return helperIndex >= 0
      && triggerIndex > helperIndex
      && !content.includes('from public.checkout_orders')
      && !content.includes('from public.checkout_order_items');
  }
);
assert(
  'supabase/migrations/20260810020000_checkout_base.sql',
  'purchased-product access policy must be created only after checkout tables exist',
  (content) => {
    const checkoutTableIndex = content.indexOf('create table if not exists public.checkout_orders');
    const policyIndex = content.indexOf('create policy "Customers can read purchased products"');
    return checkoutTableIndex >= 0
      && policyIndex > checkoutTableIndex
      && content.indexOf('from public.checkout_orders', policyIndex) > policyIndex
      && content.indexOf('from public.checkout_order_items', policyIndex) > policyIndex;
  }
);

assert(
  'supabase/migrations/20260815000000_backend_hardening.sql',
  'hardening migration is missing central admin authorization, durable queues, atomic claims, audited deletion, or checkout protections',
  containsAll(
    'create or replace function public.is_site_admin()',
    'create table if not exists public.notification_outbox',
    'create or replace function public.claim_notification_outbox(',
    'create or replace function public.claim_stripe_webhook_event(',
    'create or replace function public.claim_marketplace_webhook_event(',
    'create or replace function public.prepare_product_deletion(',
    'create or replace function public.delete_product_with_audit(',
    'encrypted_access_token text not null',
    'access_token_hash text',
    'submission_key uuid',
    'request_fingerprint text',
    'p_max_active_reservations integer default 5',
    'last_shopify_source_updated_at timestamptz',
    'create or replace function public.prune_operational_history('
  )
);
assert(
  'supabase/migrations/20260815010000_operational_resilience.sql',
  'operational tables need time-first indexes and bounded retention under the protected maintenance function',
  containsAll(
    'site_analytics_events_created_idx',
    'public_submission_rate_limits_window_idx',
    'grant execute on function public.take_public_submission_slot(text, text, integer, integer) to service_role',
    'delete from public.site_analytics_events',
    'delete from public.public_submission_rate_limits',
    "interval '2 days'",
    "'analytics', analytics_count",
    "'rateLimits', rate_limit_count",
    'revoke all on function public.prune_operational_history(integer) from public',
    'grant execute on function public.prune_operational_history(integer) to service_role'
  )
);
assert(
  'supabase/migrations/20260815000000_backend_hardening.sql',
  'browser product deletion must not be granted by an authenticated RLS policy',
  (content) => !/create\s+policy[\s\S]{0,180}on\s+public\.products[\s\S]{0,100}for\s+delete\s+to\s+authenticated/i.test(content)
);
assert(
  'supabase/migrations/20260815000000_backend_hardening.sql',
  'deletion guards must expire stale offers and block only unexpired reservations or negotiations',
  (content) => {
    const prepareDeletion = content.match(/create or replace function public\.prepare_product_deletion\([\s\S]+?\n\$\$;/i)?.[0] || '';
    const finalizeDeletion = content.match(/create or replace function public\.delete_product_with_audit\([\s\S]+?\n\$\$;/i)?.[0] || '';
    return [prepareDeletion, finalizeDeletion].every((body) => body.includes("set status = 'expired'")
      && body.includes('and expires_at <= now()')
      && body.includes("status in ('creating', 'pending')")
      && body.includes("status in ('pending', 'countered', 'accepted')")
      && body.match(/and expires_at > now\(\)/g)?.length >= 2);
  }
);
assert(
  'supabase/migrations/20260815000000_backend_hardening.sql',
  'checkout finalization must reject late events after the inventory hold expires',
  (content) => {
    const finalizeCheckout = content.match(/create or replace function public\.finalize_checkout_inventory\([\s\S]+?\n\$\$;/i)?.[0] || '';
    return finalizeCheckout.includes("status in ('creating', 'pending')")
      && finalizeCheckout.match(/and expires_at > now\(\)/g)?.length >= 2
      && finalizeCheckout.includes('has no active inventory reservations');
  }
);
assert(
  'supabase-schema.sql',
  'root schema must use the central site-admin registry and must not expose direct product deletion',
  (content) => content.includes('public.is_site_admin()')
    && content.includes('for update to authenticated')
    && !/on\s+public\.products\s+for\s+delete\s+to\s+authenticated/i.test(content)
);

for (const adminFunction of [
  'supabase/functions/analytics-report/index.ts',
  'supabase/functions/shopify-catalog-sync/index.ts'
]) {
  assert(
    adminFunction,
    'admin endpoint must authorize against the site-admin registry',
    containsAll("from '../_shared/admin-auth.ts'", 'requireSiteAdmin')
  );
}

const edgeFunctionFiles = [];
const functionsRoot = path.join(ROOT, 'supabase', 'functions');
function collectTypeScript(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTypeScript(fullPath);
    else if (entry.name.endsWith('.ts')) edgeFunctionFiles.push(fullPath);
  }
}
if (existsSync(functionsRoot)) collectTypeScript(functionsRoot);
assertions += 1;
const hardCodedAdminIdentity = edgeFunctionFiles.find((file) => /\b(?:ADMIN_EMAIL|adminEmail)\b/.test(readFileSync(file, 'utf8')));
if (hardCodedAdminIdentity) {
  failures.push(`${path.relative(ROOT, hardCodedAdminIdentity)}: hard-coded admin identity is not allowed in Edge Functions`);
}
const rawJsonReaders = edgeFunctionFiles.filter((file) => readFileSync(file, 'utf8').includes('request.json('));
assertions += 1;
if (rawJsonReaders.length) {
  failures.push(`Edge Functions must use bounded readJsonBody instead of raw request.json(): ${
    rawJsonReaders.map((file) => path.relative(ROOT, file)).join(', ')
  }`);
}
const rawTextReaders = edgeFunctionFiles.filter((file) => readFileSync(file, 'utf8').includes('request.text('));
assertions += 1;
if (rawTextReaders.length) {
  failures.push(`Edge Functions must use bounded readTextBody instead of raw request.text(): ${
    rawTextReaders.map((file) => path.relative(ROOT, file)).join(', ')
  }`);
}

assert(
  'supabase/functions/_shared/http.ts',
  'shared HTTP helper must provide bounded JSON and signature-preserving text parsing',
  containsAll(
    'export async function readJsonBody',
    'export async function readTextBody',
    'export class RequestBodyTooLargeError',
    "request.headers.get('content-length')",
    'request.body.getReader()',
    'Request body is too large'
  )
);
assert(
  'supabase/functions/_shared/constant-time.ts',
  'shared secret comparison must operate on encoded bytes without an early content mismatch exit',
  containsAll('export function timingSafeEqualText', 'TextEncoder', 'mismatch |=', 'return mismatch === 0')
);

assert(
  'supabase/functions/_shared/notification-outbox.ts',
  'notification delivery must enqueue idempotently, claim with a lease, and persist success or retry state',
  containsAll(
    "onConflict: 'event_key,channel'",
    "admin.rpc('claim_notification_outbox'",
    "admin.rpc('complete_notification_outbox'",
    "admin.rpc('fail_notification_outbox'",
    'completed !== true',
    'failureRecorded !== true',
    'fetchWithTimeout',
    "'Idempotency-Key'"
  )
);
assert(
  'supabase/functions/notification-worker/index.ts',
  'notification retry worker must require its secret and process the durable outbox',
  containsAll('NOTIFICATION_WORKER_SECRET', 'timingSafeEqualText', 'processNotificationOutbox', "admin.rpc('prune_operational_history'")
);
assert(
  'supabase/functions/sale-notification/index.ts',
  'inbound notification secrets must use the shared timing-safe comparison',
  (content) => content.includes('timingSafeEqualText')
    && !content.includes('bearer === inboundSecret')
    && !content.includes('headerSecret === inboundSecret')
);
for (const producer of [
  'supabase/functions/stripe-webhook/index.ts',
  'supabase/functions/shopify-webhook/index.ts',
  'supabase/functions/collector-inquiry/index.ts',
  'supabase/functions/offer-workflow/index.ts'
]) {
  assert(
    producer,
    'notification producer must queue or process durable notifications',
    (content) => content.includes('queueSaleNotification')
      || content.includes('queueEmailNotification')
      || content.includes('processNotificationOutbox')
  );
}

assert(
  'supabase/functions/stripe-webhook/index.ts',
  'Stripe webhook must atomically claim events and use checkout-session idempotency for sale side effects',
  containsAll("admin.rpc('claim_stripe_webhook_event'", 'idempotencyKey: session.id', 'eventId: session.id')
);
for (const webhook of [
  'supabase/functions/stripe-webhook/index.ts',
  'supabase/functions/shopify-webhook/index.ts'
]) {
  assert(
    webhook,
    'public webhook bodies must be bounded before signature verification',
    containsAll('readTextBody', 'RequestBodyTooLargeError', '413')
  );
}
for (const stripeFunction of [
  'supabase/functions/create-checkout-session/index.ts',
  'supabase/functions/offer-workflow/index.ts',
  'supabase/functions/stripe-webhook/index.ts'
]) {
  assert(
    stripeFunction,
    'Stripe clients must not crash the Edge worker when the function is intentionally unconfigured',
    (content) => content.includes('stripeSecretKey ? new Stripe(stripeSecretKey')
      && !/new Stripe\([^\n]*\|\|\s*['"]{2}/.test(content)
  );
}
assert(
  'supabase/functions/shopify-webhook/index.ts',
  'Shopify webhook JSON must be an object before event-specific processing',
  containsAll("typeof parsed !== 'object'", 'Array.isArray(parsed)', 'Invalid Shopify webhook JSON.')
);
assert(
  'supabase/functions/stripe-webhook/index.ts',
  'Stripe sale notification must be persisted before external Shopify sync work can fail',
  (content) => {
    const finalizePaidCheckout = content.match(/async function finalizePaidCheckout\([\s\S]+?\n}/)?.[0] || '';
    const notification = finalizePaidCheckout.indexOf('await queueSaleNotification(admin, saleNotification)');
    const shopifySync = finalizePaidCheckout.indexOf('await syncCheckoutInventoryToShopify(session, reservations)');
    return notification !== -1 && shopifySync !== -1 && notification < shopifySync;
  }
);
assert(
  'supabase/functions/shopify-webhook/index.ts',
  'Shopify webhook must atomically claim events and pass source ordering timestamps',
  containsAll(
    "admin.rpc('claim_marketplace_webhook_event'",
    'p_source_updated_at: payload.updated_at || null',
    'result?.processed === true',
    'const notificationEventId = orderId || eventId',
    'eventId: notificationEventId'
  )
);

assert(
  'supabase/functions/_shared/shopify.ts',
  'Shopify access must support encrypted OAuth storage and bounded network requests',
  containsAll(
    "from('shopify_oauth_credentials')",
    'decryptSecret(',
    "Deno.env.get('SHOPIFY_REQUEST_TIMEOUT_MS')",
    'fetchWithTimeout(',
    'idempotencyKey'
  )
);
assert(
  'supabase/functions/shopify-oauth-callback/index.ts',
  'OAuth callback must encrypt and persist the returned access token',
  containsAll('encryptSecret(accessToken', "from('shopify_oauth_credentials').upsert")
);

assert(
  'supabase/functions/offer-workflow/index.ts',
  'offer capabilities must be random, hashed, expiring, revocable, and submission-idempotent',
  containsAll(
    'crypto.getRandomValues(new Uint8Array(32))',
    'hashOfferAccessToken(token)',
    'access_token_expires_at',
    'access_token_revoked_at',
    'submission_key',
    '`offer-submission:${offer.id}:owner`',
    '`offer-submission:${refreshedOffer.id}:owner`',
    'enforcePublicRateLimits'
  )
);
assert(
  'supabase/functions/offer-workflow/index.ts',
  'buyer capability links must use URL fragments rather than query parameters',
  (content) => content.includes('#token=${encodeURIComponent(token)}') && !content.includes("searchParams.set('token'")
);
assert(
  'offer.html',
  'offer page must suppress capability-token referrers',
  /<meta\s+name=["']referrer["']\s+content=["']no-referrer["']/i
);
assert(
  'offers.js',
  'offer client must read fragment capabilities and remove legacy query tokens from browser history',
  containsAll('window.location.hash', "params.delete('token')", 'window.history.replaceState')
);

assert(
  'supabase/functions/checkout-session-status/index.ts',
  'checkout status endpoint must validate session IDs and return a constrained status',
  containsAll('SESSION_ID_PATTERN', ".from('checkout_orders')", ".eq('stripe_session_id', sessionId)", "const status = orderStatus === 'paid'")
);
assert(
  'core.js',
  'success-page cart reconciliation must be gated on verified paid status',
  containsAll('confirmCheckoutSuccessAndReconcile', "verification.status !== 'paid'", 'reconcileCartAfterCheckoutSuccess(sessionId)')
);
assert(
  'checkout-success.html',
  'checkout-success page must load the backend adapter before shared reconciliation',
  (content) => content.indexOf('backend-config.js') >= 0
    && content.indexOf('supabase-client.js') > content.indexOf('backend-config.js')
    && content.indexOf('core.js') > content.indexOf('supabase-client.js')
);
assert(
  'supabase/functions/create-checkout-session/index.ts',
  'checkout must preserve signed-in and guest flows while binding guest holds to a server-derived IP fingerprint',
  (content) => containsAll(
    "const allowGuestCheckout = Deno.env.get('STRIPE_ALLOW_GUEST_CHECKOUT') === 'true';",
    'const maxActiveReservationsPerGuest =',
    'admin.auth.getUser(jwt)',
    'let buyerUserId: string | null = null;',
    'const hasValidGuestEmail = allowGuestCheckout && emailPattern.test(email)',
    "if (!buyerUserId && !allowGuestCheckout)",
    "if (!buyerUserId && !hasValidGuestEmail)",
    'const activeReservationLimit = buyerUserId ? maxActiveReservationsPerUser : maxActiveReservationsPerGuest;',
    'checkoutFingerprint = buyerUserId ? rateLimit.requestFingerprint : rateLimit.ipFingerprint;',
    'p_request_fingerprint: checkoutFingerprint',
    "admin.rpc('reserve_checkout_items'",
    "admin.rpc('reserve_negotiated_offer_checkout'"
  )(content) && !content.includes('checkoutFingerprint = rateLimit.requestFingerprint')
);
assert(
  'supabase/config.toml',
  'checkout gateway JWT verification must permit the Edge Function to authenticate signed-in and guest requests itself',
  /\[functions\.create-checkout-session\]\s*verify_jwt\s*=\s*false/i
);
assert(
  'backend-config.js',
  'browser guest checkout must be explicitly enabled with server-side reservation controls documented',
  (content) => /stripeGuestCheckoutEnabled\s*:\s*true/.test(content)
    && content.includes('server-side IP fingerprint, email limit, and global')
);
assert(
  'payments.js',
  'shopper guest checkout must be explicit, email-validated, configuration-gated, and omit guest data for signed-in checkout',
  containsAll(
    'config.stripeGuestCheckoutEnabled === true',
    'async function continueAsGuestFromModal()',
    'EMAIL_PATTERN.test(email)',
    'guestCheckout: true',
    'const canUseGuestCheckout = config.stripeGuestCheckoutEnabled === true',
    'canUseGuestCheckout && !state.session?.user ? { guestEmail: requestedGuestEmail } : {}',
    "DJ.trackEvent?.('guest_checkout'"
  )
);
assert(
  'supabase/migrations/20260825071000_guest_checkout_reservation_hardening.sql',
  'guest reservation controls must atomically enforce IP, normalized-email, and global active-hold limits for direct and negotiated checkout',
  (content) => containsAll(
    'product_checkout_reservations_guest_email_active_idx',
    'product_checkout_reservations_guest_expires_active_idx',
    'create or replace function public.reserve_checkout_items(',
    'create or replace function public.reserve_negotiated_offer_checkout(',
    'Anonymous checkout fingerprint is required',
    "p_expires_at > now() + interval '25 hours'",
    "pg_advisory_xact_lock(hashtext('checkout-reservations:guest-global'))",
    "identity_key := 'guest-ip:' || trim(p_request_fingerprint);",
    'lower(trim(buyer_email)) = normalized_guest_email',
    'greatest(active_guest_ip_count, active_guest_email_count)',
    'guest_global_reservation_limit constant integer := 20',
    'grant execute on function public.reserve_checkout_items(uuid, text, text, jsonb, timestamptz, integer) to service_role',
    'grant execute on function public.reserve_negotiated_offer_checkout(uuid, uuid, text, text, timestamptz, integer) to service_role'
  )(content)
    && (content.match(/checkout-reservations:guest-global/g) || []).length === 2
    && (content.match(/guest_global_reservation_limit constant integer := 20/g) || []).length === 2
    && (content.match(/greatest\(active_guest_ip_count, active_guest_email_count\)/g) || []).length === 2
    && (content.match(/p_expires_at > now\(\) \+ interval '25 hours'/g) || []).length === 2
);
assert(
  'supabase/functions/.env.example',
  'checkout environment must document the enabled guest flow and bounded signed-in and guest reservation limits',
  (content) => /^STRIPE_MAX_ACTIVE_RESERVATIONS_PER_USER=20$/m.test(content)
    && /^STRIPE_ALLOW_GUEST_CHECKOUT=true$/m.test(content)
    && /^STRIPE_MAX_ACTIVE_RESERVATIONS_PER_GUEST=5$/m.test(content)
);
assert(
  'supabase/functions/create-checkout-session/index.ts',
  'checkout must enforce browser origin and prove every reservation was attached before returning a Stripe URL',
  containsAll(
    'allowedOrigin(request)',
    'This request origin is not allowed.',
    ".eq('status', 'creating')",
    ".select('id')",
    'updatedReservationIds',
    'pendingReservations?.length === reservationIds.length',
    'expireCheckoutSession(checkoutSession.id',
    'const checkoutUrl = checkoutSession.url'
  )
);

assert(
  'supabase-client.js',
  'bulk catalog conversion must omit live operational state unless explicitly requested',
  containsAll(
    'const includeOperationalState = options.includeOperationalState === true',
    "if (includeOperationalState && (hasOwn('quantityAvailable')",
    "if (includeOperationalState && hasOwn('saleStatus')",
    'toRemoteProduct(product, { includeOperationalState: true })',
    'mergeRemoteMetadata(item, currentMetadata.get(Number(item.id)))'
  )
);
assert(
  'supabase/migrations/20260825070000_public_catalog_projection.sql',
  'public catalog migration must revoke anonymous base-table reads and expose a strict view',
  (content) => containsAll(
    'revoke select on table public.products from anon',
    'create view public.storefront_products',
    'with (security_barrier = true)',
    "p.sale_status not in ('hidden', 'archived', 'sold')",
    'grant select on table public.storefront_products to anon, authenticated'
  )(content) && !/\bp\.(?:item_photo_url|item_photo_urls|html_full_link|html_image_urls|sold_at|hidden_reason|archived_at)\b/.test(content)
);
assert(
  'supabase-client.js',
  'storefront and admin catalog reads must use separate public and privileged relations',
  (content) => {
    const publicColumns = content.match(/const PUBLIC_REMOTE_LIST_SELECT_COLUMNS = \[([\s\S]*?)\]\.join/)?.[1] || '';
    return content.includes('.from(config.storefrontProductsTable)')
      && content.includes('async function listAdminProducts()')
      && content.includes('.from(config.productsTable)')
      && !/(?:item_photo_url|item_photo_urls|html_full_link|html_image_urls|sold_at|hidden_reason|archived_at)/.test(publicColumns);
  }
);
assert(
  'supabase-client.js',
  'Supabase browser SDK must load only the pinned same-origin vendor bundle',
  (content) => content.includes("const SUPABASE_LIBRARY_VERSION = '2.49.4'")
    && content.includes('vendor/supabase.min.js?v=${SUPABASE_LIBRARY_VERSION}')
    && !content.includes('cdn.jsdelivr.net')
    && !content.includes('unpkg.com')
);
assert(
  '.htaccess',
  'CSP and routing must block the rich catalog and remote SDK fallbacks',
  (content) => content.includes('RewriteRule ^products\\.json$ - [F,L,NC]')
    && !content.includes('cdn.jsdelivr.net')
    && !content.includes('unpkg.com')
);
assert(
  'scripts/import-products-to-supabase.ps1',
  'catalog importer must default to audit-only/content-only and verify field-level parity when applied',
  (content) => content.includes('[switch]$Apply')
    && content.includes('[switch]$IncludeOperationalState')
    && content.includes('Audit only: no Supabase authentication or writes were performed')
    && content.includes('Assert-RemoteRowsMatch')
    && content.includes('Merge-RemoteOperationalMetadata')
    && !/\[switch\]\$DryRun/.test(content)
);
assert(
  'scripts/sync_legacy_matches_to_supabase.py',
  'legacy maintenance sync must require environment credentials and explicit apply mode',
  containsAll('SUPABASE_ADMIN_EMAIL', 'SUPABASE_ADMIN_PASSWORD', 'args.apply', 'Audit only: no Supabase rows were changed')
);
assert(
  'scripts/sync_legacy_matches_to_supabase.py',
  'legacy maintenance sync must not accept credentials on the command line or mirror sold state',
  (content) => !content.includes('ADMIN_EMAIL =')
    && !content.includes('"copy_count":')
    && !content.includes('is_deleted": bool(')
    && !/add_argument\([^\n]*(?:password|email)/i.test(content)
);
assert(
  'scripts/normalize-range-checkout-prices.mjs',
  'normalizer must require explicit --apply and rebuild every catalog fallback through the canonical builder',
  containsAll(
    "const apply = process.argv.includes('--apply')",
    'Audit only',
    'build-public-catalog.mjs',
    '--optimize-segments'
  )
);
assert(
  'scripts/materialize-external-product-images.mjs',
  'applied image materialization must regenerate every deployable catalog fallback through the canonical builder',
  (content) => content.includes('build-public-catalog.mjs')
    && content.includes('--optimize-segments')
    && !content.includes('const SEGMENTS =')
);
for (const catalogMaintenanceScript of [
  'scripts/normalize-missing-images.mjs',
  'scripts/remove-confirmed-legacy-duplicates.mjs'
]) {
  assert(
    catalogMaintenanceScript,
    'catalog maintenance must require explicit apply mode and regenerate all fallbacks through the canonical builder',
    (content) => content.includes("process.argv.includes('--apply')")
      && content.includes('build-public-catalog.mjs')
      && content.includes('--optimize-segments')
      && !content.includes('const SEGMENTS =')
  );
}
assert(
  'scripts/reconcile-authoritative-listings.py',
  'authoritative reconciliation must retain its apply gate and rebuild all generated fallbacks canonically',
  containsAll('args.apply', 'build-public-catalog.mjs', '--optimize-segments', 'subprocess.run(')
);
assert(
  'sw.js',
  'private/admin shells and only genuine Supabase hosts must bypass caches',
  containsAll("'/metrics.html'", 'const SUPABASE_HOST_PATTERN = /(^|\\.)supabase\\.co$/i')
);

assert(
  'supabase/functions/shopify-catalog-sync/index.ts',
  'product deletion must require explicit confirmation and use the audited two-phase workflow',
  containsAll(
    "case 'delete-product'",
    'Number(payload.confirmProductId) !== productId',
    "admin.rpc('prepare_product_deletion'",
    'productDelete(input:',
    "admin.rpc('delete_product_with_audit'",
    "select('*').eq('id', productId)",
    'originalProductSnapshot: product'
  )
);
assert(
  'supabase/migrations/20260815000000_backend_hardening.sql',
  'deletion audit must preserve the original pre-hide product snapshot',
  containsAll(
    "jsonb_typeof(coalesce(p_metadata, '{}'::jsonb) -> 'originalProductSnapshot') = 'object'",
    "product_snapshot := p_metadata -> 'originalProductSnapshot'",
    "coalesce(p_metadata, '{}'::jsonb) - 'originalProductSnapshot'"
  )
);
assert(
  'supabase-client.js',
  'browser deletion must call the protected Edge workflow rather than deleting products directly',
  (content) => content.includes("action: 'delete-product'")
    && !/\.from\(['"]products['"]\)\s*\.delete\(\)/.test(content)
);
assert(
  'scripts/hard-delete-supabase-products-not-in-catalog.mjs',
  'catalog reconciliation deletion must create a backup and route deletion through the audited Edge workflow',
  containsAll(
    'await fs.writeFile(',
    'JSON.stringify(beforeRows',
    'mergedCatalogMetadata(product.metadata, remoteRow?.metadata)',
    "action: 'delete-product'",
    'confirmProductId: productId'
  )
);

assert(
  'scripts/deploy-cpanel-ftps.ps1',
  'cPanel transport failures must stop the release and batch mode must not issue unconditional delete commands',
  (content) => content.includes('throw "FTPS curl exited with code $LASTEXITCODE."') && !content.includes('*DELE')
);
assert(
  'supabase/config.toml',
  'all public or worker Edge endpoints must have explicit JWT contracts',
  containsAll(
    '[functions.notification-worker]',
    '[functions.checkout-session-status]',
    '[functions.offer-workflow]',
    '[functions.collector-inquiry]',
    '[functions.stripe-webhook]',
    '[functions.shopify-webhook]'
  )
);
assert(
  'supabase/functions/.env.example',
  'new encrypted-token, notification-worker, CORS, and timeout settings must be documented',
  containsAll(
    'SHOPIFY_TOKEN_ENCRYPTION_KEY=',
    'NOTIFICATION_WORKER_SECRET=',
    'PUBLIC_CORS_ALLOWED_ORIGINS=',
    'SHOPIFY_REQUEST_TIMEOUT_MS='
  )
);

if (failures.length) {
  console.error(JSON.stringify({ ok: false, assertions, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, assertions, migrations: migrations.length, edgeTypeScriptFiles: edgeFunctionFiles.length }, null, 2));
