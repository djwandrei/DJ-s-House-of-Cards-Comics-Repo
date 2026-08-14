#!/usr/bin/env node
/**
 * Deterministic release guard for private negotiated offers. This check never
 * calls Supabase, Stripe, Resend, or a deployment endpoint.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const migration = read('supabase/migrations/20260814000000_negotiated_offers.sql');
const workflow = read('supabase/functions/offer-workflow/index.ts');
const checkout = read('supabase/functions/create-checkout-session/index.ts');
const webhook = read('supabase/functions/stripe-webhook/index.ts');
const payments = read('payments.js');
const offers = read('offers.js');
const inbox = read('inbox.js');
const inquiry = read('supabase/functions/collector-inquiry/index.ts');

assert(/create table if not exists public\.negotiated_offers/i.test(migration), 'Negotiated-offer table migration is missing.');
assert(/create table if not exists public\.negotiated_offer_events/i.test(migration), 'Negotiated-offer event history migration is missing.');
assert(/enable row level security/i.test(migration) && /revoke all on table public\.negotiated_offers from anon, authenticated/i.test(migration), 'Negotiated offers must remain service-role only.');
assert(/create or replace function public\.reserve_negotiated_offer_checkout/i.test(migration) && /grant execute on function public\.reserve_negotiated_offer_checkout/i.test(migration), 'Accepted offers need their own service-role-only inventory reservation path.');
assert(/offerAccessToken/.test(workflow) && /tokensMatch/.test(workflow), 'Offer capability-link validation is missing.');
assert(/case 'customer-accept'/.test(workflow) && /case 'customer-counter'/.test(workflow) && /case 'customer-reject'/.test(workflow), 'Customer offer response actions are incomplete.');
assert(/case 'admin-list-inbox'/.test(workflow) && /case 'admin-decide'/.test(workflow) && /case 'admin-update-inquiry'/.test(workflow), 'Admin Inbox actions are incomplete.');
assert(/sendOwnerOfferNotification/.test(workflow) && /sendBuyerOfferNotification/.test(workflow), 'Offer email notification paths are missing.');
assert(/validateNegotiatedOffer/.test(checkout) && /negotiated_offer_id/.test(checkout), 'Stripe checkout must validate and tag negotiated offers server-side.');
assert(/current_amount_cents/.test(checkout) && /allow_promotion_codes: negotiatedOffer \? false/i.test(checkout), 'Negotiated Stripe prices must be server-derived and must not stack promotion codes.');
assert(/reserve_negotiated_offer_checkout/.test(checkout) && /standardCheckoutExpiresAt/.test(checkout) && /offerExpiresAt/.test(checkout), 'Negotiated checkout must reserve stock privately and cannot outlive its accepted-offer deadline.');
assert(/markNegotiatedOfferPurchased/.test(webhook) && /clearNegotiatedOfferCheckoutSession/.test(webhook) && /negotiatedUnitAmount/.test(webhook), 'Stripe webhook reconciliation and negotiated order snapshots are incomplete.');
assert(/startNegotiatedOfferCheckout/.test(payments) && /skipCartSnapshot/.test(payments), 'Negotiated checkout must preserve an unrelated cart snapshot.');
assert(/data-negotiated-offer-checkout/.test(offers) && /customer-counter/.test(offers), 'Customer offer page actions are incomplete.');
assert(/actionInFlight/.test(offers), 'Customer offer responses must reject duplicate in-flight actions.');
assert(/admin-list-inbox/.test(inbox) && /admin-update-inquiry/.test(inbox), 'Admin Inbox client is incomplete.');
assert(/loadRequestId/.test(inbox) && /appendUniqueRecords/.test(inbox), 'Admin Inbox pagination must ignore stale responses and deduplicate appended records.');
assert(/Open the Admin Inbox/.test(inquiry), 'New collector-inquiry email notifications must link to the Admin Inbox.');

console.log('Negotiated offer workflow audit passed: private pricing, customer responses, inbox access, email notifications, and Stripe reconciliation are wired locally.');
