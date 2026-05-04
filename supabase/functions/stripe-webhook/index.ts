import Stripe from 'npm:stripe@22.1.0';
import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2026-02-25.clover' as any
});

const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false }
});

function isServerConfigured() {
  // The webhook has no browser auth token, so every trusted input must come from
  // Supabase secrets plus Stripe's verified signature.
  return Boolean(
    Deno.env.get('STRIPE_SECRET_KEY') &&
    webhookSecret &&
    supabaseUrl &&
    serviceRoleKey &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)
  );
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function compactSessionMetadata(session: Stripe.Checkout.Session) {
  return {
    stripe_session_id: session.id,
    payment_status: session.payment_status,
    checkout_status: session.status,
    customer_details: session.customer_details || null,
    shipping_details: session.shipping_details || null,
    total_details: session.total_details || null,
    metadata: session.metadata || {}
  };
}

function assertNoSupabaseError(error: unknown, step: string) {
  if (!error) return;
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  throw new Error(`Supabase ${step} failed: ${message}`);
}

async function updateReservation(session: Stripe.Checkout.Session, status: 'paid' | 'expired') {
  const reservationId = String(session.metadata?.reservation_id || '').trim();
  if (!reservationId) return;

  const { error } = await admin
    .from('product_checkout_reservations')
    .update({ status })
    .eq('id', reservationId);
  assertNoSupabaseError(error, 'reservation update');
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const productId = Number(session.metadata?.product_id || session.client_reference_id);
  const buyerUserId = String(session.metadata?.buyer_user_id || '') || null;
  if (!Number.isFinite(productId)) return;

  const { error: orderError } = await admin.from('checkout_orders').upsert({
    product_id: productId,
    buyer_user_id: buyerUserId,
    buyer_email: session.customer_details?.email || session.customer_email || '',
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : '',
    stripe_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : '',
    amount_total: session.amount_total,
    currency: session.currency || 'usd',
    status: session.payment_status || session.status || 'complete',
    metadata: compactSessionMetadata(session)
  }, {
    onConflict: 'stripe_session_id'
  });
  assertNoSupabaseError(orderError, 'order upsert');

  await updateReservation(session, session.payment_status === 'paid' ? 'paid' : 'expired');

  if (buyerUserId && typeof session.customer === 'string') {
    const { error: profileError } = await admin.from('customer_profiles').upsert({
      id: buyerUserId,
      email: session.customer_details?.email || session.customer_email || '',
      stripe_customer_id: session.customer
    }, {
      onConflict: 'id'
    });
    assertNoSupabaseError(profileError, 'customer profile upsert');
  }

  // Hide paid one-of-one listings from public catalog views. The original row is
  // preserved for admin/order review, but shoppers will not be able to buy it.
  if (session.payment_status === 'paid') {
    const { data: product, error: productError } = await admin
      .from('products')
      .select('metadata')
      .eq('id', productId)
      .single();
    assertNoSupabaseError(productError, 'product lookup');
    const existingMetadata = product?.metadata && typeof product.metadata === 'object' ? product.metadata : {};

    const { error: productUpdateError } = await admin
      .from('products')
      .update({
        is_deleted: true,
        metadata: {
          ...existingMetadata,
          sold_via: 'stripe_checkout',
          stripe_session_id: session.id,
          sold_at: new Date().toISOString()
        }
      })
      .eq('id', productId);
    assertNoSupabaseError(productUpdateError, 'product sold marker update');
  }
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  await updateReservation(session, 'expired');
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  if (!isServerConfigured()) {
    return jsonResponse({ error: 'Stripe webhook is not fully configured.' }, 503);
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return jsonResponse({ error: 'Missing Stripe signature.' }, 400);
  }

  const payload = await request.text();
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(payload, signature, webhookSecret);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid Stripe signature.' }, 400);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
    }

    if (event.type === 'checkout.session.expired') {
      await handleCheckoutExpired(event.data.object as Stripe.Checkout.Session);
    }
  } catch (error) {
    console.error('[stripe-webhook]', error);
    return jsonResponse({ error: 'Webhook processing failed.' }, 500);
  }

  return jsonResponse({ received: true });
});
