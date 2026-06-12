# Codebase Guide

This site is a static storefront with Supabase-backed catalog administration and Stripe Checkout.

## Runtime Flow

1. Each HTML page loads shared styles and the small page modules it needs.
2. `core.js` provides shared browser helpers such as safe asset URLs, theme state, wishlist state, image fallbacks, and accessibility utilities.
3. `supabase-client.js` is the only module that talks directly to Supabase. It maps database rows to storefront products and centralizes authentication, caching, uploads, saves, and permanent deletes.
4. `catalog.js` loads Supabase first, falls back to static catalog files, normalizes products, and renders all storefront product views.
5. `backend-admin.js` powers the only listing editor. Signed-in changes update Supabase immediately.
6. `payments.js` bridges buyer authentication and Stripe Checkout through Supabase Edge Functions.

## Sources Of Truth

- Non-legacy listings: the authoritative workbook `Listings` sheet.
- Live catalog: Supabase `products`.
- Deployable static fallback: `products.json` and generated category catalog files.
- Product display media: local files under `assets/`.

The static catalog and Supabase should always contain the same product IDs and media paths after a release.

Listings are never intentionally hidden as a substitute for deletion. Use
`scripts/hard-delete-supabase-products-not-in-catalog.mjs` to audit and
permanently remove Supabase rows that are absent from `products.json`.

## Main Files

- `core.js`: shared utilities and page initialization.
- `nav.js`: desktop/mobile navigation behavior.
- `catalog.js`: catalog loading, filtering, product cards, wishlist actions, and product modal.
- `supabase-client.js`: Supabase adapter and row mapping.
- `backend-admin.js`: live catalog administration.
- `payments.js`: buyer auth and checkout.
- `account.js`: local buyer profile and remote order display.
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
node scripts/audit-structured-data.mjs
powershell -ExecutionPolicy Bypass -File scripts/audit-secrets.ps1
git diff --check
```

Use `scripts/deploy-cpanel-ftps.ps1` with a reviewed path list and `-SkipDelete`. Product removals belong in Supabase; asset files should not be removed during routine releases.

Use `scripts/sync-supabase-image-paths.mjs` only for media-path audits and
repairs. It deliberately cannot add, hide, or delete listings.

## Commenting Style

Comments explain module boundaries, data flow, security constraints, and non-obvious decisions. Straightforward assignments and markup are intentionally left uncommented so important explanations remain easy to find.
