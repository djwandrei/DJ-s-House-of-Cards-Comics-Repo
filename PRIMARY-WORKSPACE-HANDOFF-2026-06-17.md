# DJ's House of Cards & Comics: Primary Workspace Handoff

Last consolidated: 2026-06-17 Central

Workspace: `C:\Users\djwan\Downloads\djshouseofcards-next-fixes-applied`

Current verified git state: `main` at `7cb1177c Clean up shared storefront layout`, matching `origin/main`, with a clean working tree before this handoff file was added.

## Executive Snapshot

- The site is a static HTML/CSS/JavaScript storefront with Supabase catalog/admin, Stripe Checkout through Supabase Edge Functions, generated static catalog fallbacks, local media under `assets/`, Shopify marketplace sync, and FTPS cPanel release tooling.
- There is no normal npm build. Repo-native validation is script based.
- Current local catalog has `3,180` rows in `products.json`.
- Current storefront asset version is `20260617d`; service worker cache is `dj-house-v2026-06-17-04`.
- Public website pages checked live return `200` and include asset version `20260617d`.
- Public Shopify storefront pages checked live return `200`; Shopify collection page is public and product-visible.
- Admin-level Shopify/Supabase verification requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; those were not present in this shell, and stored credential files were not inspected.
- Secret audit flags the ignored local `codex_account_keys.env` file only. It is intentionally ignored by `.gitignore` and not tracked.

## Chronological Project Understanding

### 2026-04-13 to 2026-05-29: H-Drive Storefront Foundation

Thread highlights:

- Initial full website analysis identified a hand-authored static storefront with shared JS/CSS, local wishlist/admin behavior, and optional Supabase backend.
- Repaired encoding corruption in HTML, scripts, and product data.
- Normalized catalog image references against real local assets and regenerated generated catalog bundles.
- Built a Supabase import path without making the storefront backend-only.
- Fixed Supabase schema/grants/cache refresh issues, then imported `2,721` products into Supabase.
- Switched the site to live Supabase backend mode after import.
- Performed repeated debugging, optimization, and rendered smoke passes.
- Added/improved shared shell behavior, mobile nav, footer/header treatment, product-card design, filters, desktop sidebar/drawer filtering, and loading skeletons.
- Older eBay workbook work established conservative hosted-image matching rules for fields such as `html_full_link`, `item_photo_url`, `html_image_urls`, and `photo_host_page_url`.

### 2026-06-01 to 2026-06-05: Computer Cleanup Audit

- User requested identifying unnecessary/useless/duplicate files on the machine.
- Work stayed report-only; no deletion/move actions were performed.
- Consolidated workbook/notes artifacts were produced for review.

### 2026-06-06 to 2026-06-07: C-Drive Site Hardening

- Current `C:\Users\djwan\Downloads\...` checkout became the primary active project.
- cPanel release process was hardened around reviewed path lists, no routine asset deletes, and `-AllowAssetDelete` only with explicit approval.
- Deep site flow debugging fixed wishlist, catalog state, filters, cache-version drift, duplicate rendering/races, and restored structured metadata behavior.
- Performance work added 48-item bootstrap JSON files and delayed full catalog hydration.
- WCAG/accessibility work improved contrast, headings, focus handling, modal inert behavior, form state, and semantic structure.
- Structured data tooling now emits/audits Organization, LocalBusiness/Store, WebSite, page, breadcrumb, FAQ, Product, and Offer schemas.
- Collector profile work was scoped to account localStorage unless backend persistence is explicitly requested.
- Catalog attribute auditing was formalized through `scripts/audit-product-catalog-quality.py`.

### 2026-06-07 to 2026-06-12: Account, Wishlist, Checkout, and Release

- `account.js` became the buyer account workspace owner for profile rendering, wishlist insight, auth refresh, and order history.
- `supabase/account-schema.sql` introduced owner-only `customer_account_profiles` and `customer_wishlist_items`.
- `supabase-client.js` exposes account/wishlist helpers such as `getAccountProfile`, `saveAccountProfile`, `clearAccountProfile`, `listWishlist`, and `replaceWishlist`.
- Wishlist sync was tied to auth lifecycle/catalog hydration; sign-out clears browser state without deleting backend data.
- Quantity-aware cart and checkout later became first-class behavior rather than just wishlist polish.
- A verified release path emerged: site integrity, structured data, secret audit, rendered desktop/mobile checks, cPanel dry-run/audit/deploy with reviewed manifest, and live verification.

### 2026-06-12 to 2026-06-17: Primary Workspace, Shopify, Theme, and Final Syncs

- Shopify marketplace sync was built around Supabase Edge Functions and a custom Shopify app.
- Added OAuth install/callback flow, client-credentials support, catalog sync, inventory sync, webhook handling, publication tooling, theme apply tooling, and repeatable verifier scripts.
- Shopify catalog was imported/mapped at `3,180` products: `2,232` non-legacy and `948` legacy.
- Non-legacy products were published to Online Store, TikTok, and Whatnot; legacy listings were kept Draft.
- Shopify theme work added DJHC custom CSS/logo/theme apply tooling and later verified the public Horizon theme showed DJHC styling.
- Word-doc-driven site improvements added or refined crawlable static catalog fallbacks, Featured Finds, wishlist/account polish, SEO/sitemap content, Condition & Authenticity, and Sell/Trade/Want List pages.
- Later corrections removed accidental marketplace buttons from the website header, kept marketplace links in home/footer, fixed footer overlap over artwork, and aligned account-page field widths.
- Repeated debugging and cleanup passes simplified footer/core setup, removed stale CSS overrides/comments, and removed an identical duplicate contract doc plus ignored local clutter.
- Latest pushed commit before this handoff: `7cb1177c Clean up shared storefront layout`.

## Current Architecture Map

- `core.js`: shared helpers, initialization, asset versioning, theme, wishlist/cart storage, image fallback, footer enhancement, and accessibility helpers.
- `catalog.js`: product loading/rendering, filters/sidebar, cards, wishlist, cart page, modal, pagination, and catalog page orchestration.
- `supabase-client.js`: only browser module that directly talks to Supabase.
- `backend-admin.js`: live catalog administration.
- `payments.js`: buyer auth and Stripe checkout bridge for single-item and cart checkout.
- `account.js`: buyer account workspace, local collector profile, wishlist insight, and remote checkout activity display.
- `nav.js`, `contact.js`, `seo.js`, `sw.js`: navigation, contact flow, metadata/JSON-LD, and service worker.
- `styles.css`: shared/desktop styling.
- `styles-mobile-overrides.css`: final narrow-screen overrides.
- `supabase/functions/*`: Stripe checkout/webhook, Shopify OAuth, catalog sync, Shopify webhook, Shopify theme apply, and helper modules.
- `scripts/*`: release, catalog generation/audit, Supabase import/sync, Shopify verification/theme/catalog, smoke checks, and workbook/catalog maintenance tools.

## Current Validation Results

Local source checks:

- `scripts/site-integrity-check.mjs`: passed, `22` HTML files, `3,180` catalog rows, asset version `20260617d`, `0` issues.
- `scripts/audit-structured-data.mjs`: passed.
- JS syntax checks passed for `core.js`, `catalog.js`, `account.js`, `payments.js`, `backend-admin.js`, `nav.js`, `seo.js`, and key Shopify scripts.
- Python compile checks passed for desktop/mobile smoke scripts and catalog audit.
- `git diff --check`: passed.
- Catalog quality audit: `92` review-only issues, `0` fixable.
- Product asset-title audit: `0` missing assets, `0` remote assets, `0` main-image-back cases; remaining title/folder mismatches are review-only.

Live/public checks:

- `https://www.djshouseofcards-comics.com/`: `200`, asset version marker present.
- `https://www.djshouseofcards-comics.com/account.html`: `200`, asset version marker present.
- `https://www.djshouseofcards-comics.com/collectibles.html`: `200`, asset version marker present.
- `https://xy2hik-nq.myshopify.com/`: `200`, DJHC custom theme CSS marker present.
- `https://xy2hik-nq.myshopify.com/collections/all`: `200`, DJHC custom theme CSS marker present.

Rendered browser checks:

- Website desktop and mobile home/account/collectibles pages showed no console errors.
- Website header marketplace links count is `0`; marketplace links remain in footer.
- Website mobile checks showed no horizontal overflow.
- Shopify collection page rendered product cards and checkout/add controls.
- Shopify mobile collection page had a tiny `3px` horizontal overflow signal caused by off-canvas/skip-link/menu-drawer elements. It was not a catalog visibility blocker, but it is worth tightening in a later theme polish pass.

## Current Catalog Snapshot

- Total products: `3,180`
- Categories:
  - Baseball: `785`
  - Basketball: `1,878`
  - Football: `339`
  - Comics: `165`
  - Collectibles: `13`
- Current featured products:
  - `2`: `1954 Topps #128 Hank Aaron RC PSA 3`
  - `5`: `1955 Topps #47 Hank Aaron PSA 6`
  - `565`: `2010 Finest Dual Jersey Autographs #RG Rob Gronkowski/200`
  - `779`: `Star Wars #1 Diamond Box .35 / No UPC Newsstand`
  - `829`: `Autographed Baseball Signed by 5 Hall of Famers and Pete Rose`
  - `2463`: `2024-25 Bowman University Chrome Cooper Flagg Warriors Gold Refractor /50 PSA 10`
  - `3529`: `2023 Topps Nolan Ryan All Aces SSP Auto /25 PSA 8`

## Caveats and Boundaries

- The full Shopify/Supabase verifier was not run in this turn because `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are not set in the shell environment. I did not inspect `codex_account_keys.env`.
- The secret audit fails on the ignored local `codex_account_keys.env` file. This is expected, but any commit/release flow should continue to verify the file remains ignored and untracked.
- `PROJECT-HISTORY-CURRENT-STATE.md` exists but was last consolidated on 2026-06-13 and is stale relative to the later Shopify publishing/theme/site cleanup work. This file supersedes it for current handoff.
- Generated catalog files must not be manually edited. After approved `products.json` edits, run `node .\scripts\build-public-catalog.mjs --optimize-segments`.
- Use `scripts/audit-product-catalog-quality.py --fix` only when explicitly asked; default mode is audit-only.
- Live/destructive actions still require explicit authorization: cPanel deployment, Supabase writes, Shopify mutations, product/listing/asset deletion, payment changes, emails, and customer/order modifications.

## Going Forward

- Treat this chat and this handoff as the current working baseline.
- Start future site work by checking `git status --short --branch`, `git diff --stat`, and the relevant owning module.
- For shopper-facing work, verify source checks plus rendered desktop/mobile behavior.
- For Shopify/Supabase work, run the verifier only when the required environment variables are deliberately available for that process.
- Keep legacy Shopify listings Draft unless the user explicitly changes that requirement.
- Keep marketplace links out of the website header unless explicitly requested; they belong in home/footer/storefront areas.
