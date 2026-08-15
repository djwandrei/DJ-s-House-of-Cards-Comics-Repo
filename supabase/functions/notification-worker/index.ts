import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { processNotificationOutbox } from '../_shared/notification-outbox.ts';
import { timingSafeEqualText } from '../_shared/constant-time.ts';

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const workerSecret = String(Deno.env.get('NOTIFICATION_WORKER_SECRET') || '').trim();
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function authorized(request: Request) {
  if (!workerSecret) return false;
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const header = String(request.headers.get('x-djhc-worker-secret') || '').trim();
  return timingSafeEqualText(bearer, workerSecret) || timingSafeEqualText(header, workerSecret);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!supabaseUrl || !serviceRoleKey || !workerSecret) {
    return jsonResponse({ error: 'Notification worker is not fully configured.' }, 503);
  }
  if (!authorized(request)) return jsonResponse({ error: 'Unauthorized notification worker request.' }, 401);

  try {
    const result = await processNotificationOutbox(admin, 50);
    const { data: pruned, error: pruneError } = await admin.rpc('prune_operational_history', {
      p_processed_days: 90
    });
    if (pruneError) console.error('[notification-worker] History pruning failed', pruneError.message);
    return jsonResponse({ processed: result, pruned: pruneError ? null : pruned });
  } catch (error) {
    console.error('[notification-worker]', error);
    return jsonResponse({ error: 'Notification processing failed.' }, 500);
  }
});
