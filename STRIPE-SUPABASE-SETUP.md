# Stripe + Supabase Checkout Setup

This site now has browser code for customer accounts and Stripe Checkout, but
live payments only work after the Supabase server-side pieces are deployed.

## Security first

- Do not commit Stripe secret keys, restricted keys, webhook secrets, or account
  passwords to the site files.
- Because live key material was shown while setting this up, rotate any exposed
  live restricted or secret keys in the Stripe Dashboard before launch.
- Test the whole flow in Stripe test mode first, then switch Supabase secrets to
  live mode only after test purchases and webhooks work.

## Supabase SQL

Run `supabase-schema.sql` in the Supabase SQL Editor first if the project does
not already have the current `products` table and `product-images` storage
bucket. It creates the storefront catalog table, public read policy for visible
listings, admin-only write policies, and the product image bucket policies.

Then run `supabase/stripe-schema.sql` in the Supabase SQL Editor. It creates:

- `customer_profiles`
- `checkout_orders`
- `product_checkout_reservations`
- RLS policies for customers and the admin email

It also drops the browser-side customer profile update policy. Customer profile
writes, including Stripe customer IDs, should only happen from the service-role
Edge Functions.

Finally, run `supabase/account-schema.sql`. It adds owner-only buyer profiles
and wishlists that sync across signed-in devices.

The reservations table prevents two customers from checking out with the same
one-of-one listing at the same time. Expired sessions are released by the
checkout function and the Stripe webhook. The checkout function sets Stripe
Checkout Sessions to expire after about 31 minutes by default so abandoned carts
do not hold inventory all day.

## Supabase function secrets

Use the Supabase Dashboard secret editor, or copy
`supabase/functions/.env.example` to a secret file outside this repository and
load it with the Supabase CLI. Do not put secret values directly in a command,
where they can remain in shell history.

```powershell
supabase secrets set --env-file "$HOME/.config/djshouseofcards/supabase-functions.env"
```

Supabase normally provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to
Edge Functions. If your project does not, set those as secrets too.

The example file documents the required and optional names, including the
free-shipping and promotion-code switches.

Promotion codes are off by default so an active Stripe coupon cannot
accidentally discount one-of-one inventory.

Do not set live secrets until the same flow has been tested successfully with
Stripe test keys.

## Deploy functions

The Edge Functions pin their Stripe and Supabase SDK imports to exact versions
so payment behavior does not change because of a future package release.

```bash
supabase functions deploy create-checkout-session
supabase functions deploy stripe-webhook
```

After deploy, a missing function response such as `Requested function was not
found` means the storefront checkout buttons are wired but the Supabase project
has not received the Edge Functions yet, or they were deployed to a different
project ref.

`supabase/config.toml` keeps JWT verification on for customer-created checkout
sessions and disables it only for the Stripe webhook, because Stripe signs the
webhook with `STRIPE_WEBHOOK_SECRET` instead of a Supabase user token.

The storefront calls `create-checkout-session` when a signed-in customer clicks
Buy Now on a fixed-price listing. Listings with price ranges charge the high
end of the range in Stripe while keeping the original range visible as guide
information in the item details. Listings marked "contact for price" still
open the inquiry email instead of taking payment. Multi-copy listings also use
the inquiry flow until quantity-aware checkout inventory is implemented.

## Stripe webhook

Create a webhook endpoint in Stripe:

```text
https://gkqdymnmczabcggvigce.supabase.co/functions/v1/stripe-webhook
```

Listen for:

```text
checkout.session.completed
checkout.session.expired
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
```

After payment, the webhook writes an order row and hides the purchased listing
from the public catalog by setting `products.is_deleted = true`.

Delayed payment methods remain reserved after `checkout.session.completed`
until Stripe sends either `checkout.session.async_payment_succeeded` or
`checkout.session.async_payment_failed`.

Do not fulfill from the browser redirect alone. The success page only confirms
that Stripe returned the shopper to the site; the webhook is the source of truth
for paid orders.

## Customer accounts

Customer accounts use Supabase Auth. If you want customers to confirm email
before checkout, keep email confirmation enabled in Supabase Auth settings. If
you want instant checkout after account creation, disable confirmation or use a
trusted email flow.
