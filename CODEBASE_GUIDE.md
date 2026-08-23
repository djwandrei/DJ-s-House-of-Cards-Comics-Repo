# Codebase Guide

This site is a static storefront with Supabase-backed catalog administration and Stripe Checkout.

## Runtime Flow

1. Each HTML page loads shared styles and the small page modules it needs.
2. `core.js` provides shared browser helpers such as safe asset URLs, theme state, wishlist/cart state, image fallbacks, and accessibility utilities.
3. `supabase-client.js` is the only browser module that talks directly to Supabase. It maps database rows to storefront products and centralizes authentication, caching, uploads, and saves. Permanent deletion is delegated to the protected Shopify catalog-sync Edge Function.
4. `catalog.js` loads Supabase first, falls back to static catalog files, normalizes products, and renders all storefront product views.
5. `backend-admin.js` powers the only listing editor. Signed-in changes update Supabase immediately.
6. `payments.js` bridges buyer authentication and quantity-aware, multi-item Stripe Checkout through Supabase Edge Functions. Checkout success removes only the saved checkout snapshot after the server confirms that the returned session is paid.

## Sources Of Truth

- Non-legacy listings: the `Listings` sheet in
  `C:\Users\djwan\Downloads\Ebay Bulk Upload - 08-22-2026.xlsx`.
  The workbook's other sheets are review/staging material, not catalog inputs.
- Live catalog: Supabase `products`.
- Deployable static fallback: `products.json` and generated category catalog files.
- Product display media: local files under `assets/`.

The static catalog and Supabase should always contain the same product IDs and media paths after a release.

The historical `fix_nonlegacy_product_attributes.py` and
`improve_ebay_bulk_upload.py` helpers write older workbooks from site data.
Do not repoint either helper at the authoritative workbook; reconciliation must
flow from its `Listings` sheet into reviewed local catalog outputs.

Listings are never intentionally hidden as a substitute for deletion. Use
`scripts/hard-delete-supabase-products-not-in-catalog.mjs` to audit and,
after explicit review, permanently remove Supabase rows that are absent from
`products.json`. Apply mode creates a full remote backup, preserves remote
sale/reservation metadata during content reconciliation, and routes each
deletion through the audited Shopify/Supabase Edge workflow.

## Backend Safety Boundaries

- `supabase/migrations/` is the canonical ordered database history. A fresh
  local Supabase start in CI must replay every migration successfully.
- `public.site_admins` and `public.is_site_admin()` are the central admin
  authorization source. Browser product-delete policies are intentionally
  absent.
- Public checkout, offer, and inquiry endpoints use rate limits and bounded
  request sizes. Checkout inventory is held transactionally and only an
  unexpired hold can be finalized by a paid Stripe event.
- Offer access links carry random capabilities in URL fragments. Only hashes
  are stored, and capabilities expire or are revoked when the workflow ends.
- Sale, offer, and inquiry email/webhook work is recorded in
  `notification_outbox`. `notification-worker` retries each channel
  independently and requires `NOTIFICATION_WORKER_SECRET`.
- Schedule `notification-worker` from the hosting environment at a regular
  interval and pass `x-djhc-worker-secret`. Immediate delivery attempts
  reduce latency, but the schedule is what guarantees recovery after a provider
  or function interruption.
- Shopify OAuth tokens are encrypted before database storage. The encryption
  key and worker secret belong only in Edge Function secrets, never browser
  configuration or this repository.

## Main Files

- `core.js`: shared utilities and page initialization.
- `nav.js`: desktop/mobile navigation behavior.
- `catalog.js`: catalog loading, filtering, product cards, wishlist/cart actions, cart page, and product modal.
- `supabase-client.js`: Supabase adapter and row mapping.
- `backend-admin.js`: live catalog administration.
- `payments.js`: buyer auth and single-item/cart checkout.
- `account.js`: buyer account workspace and remote multi-item order display.
- `contact.js`: validated email handoff.
- `seo.js`: structured data and product metadata.
- `styles.css`: shared and desktop styling.
- `styles-mobile-overrides.css`: final narrow-screen overrides.

## Generated Catalog Files

Do not manually edit `products-data-*.js`, `products-bootstrap-*.json`, or category product JSON files. Regenerate them from `products.json` with:

```powershell
node scripts/build-public-catalog.mjs --optimize-segments
```

## Release Checks

Run these before deployment:

```powershell
node scripts/site-integrity-check.mjs
node scripts/audit-backend-hardening.mjs
node scripts/run-correctness-regression-tests.mjs
node scripts/audit-structured-data.mjs
powershell -ExecutionPolicy Bypass -File scripts/audit-secrets.ps1
git diff --check
```

Use `scripts/deploy-cpanel-ftps.ps1` with a reviewed path list and `-SkipDelete`. Product removals belong in Supabase; asset files should not be removed during routine releases.

Use `scripts/sync-supabase-image-paths.mjs` only for media-path audits and
repairs. It deliberately cannot add, hide, or delete listings.

## Commenting Style

Comments explain module boundaries, data flow, security constraints, and non-obvious decisions. Straightforward assignments and markup are intentionally left uncommented so important explanations remain easy to find.
