# DJ's House of Cards & Comics: Project History and Current State

Last consolidated: 2026-06-13 22:40 Central

Primary workspace: `C:\Users\djwan\Downloads\djshouseofcards-next-fixes-applied`

Current branch: `codex/sync-deployed-site-fixes`

## Purpose and Scope

This document is the durable handoff for using the current Codex chat as the
primary project workspace. It consolidates:

- Project-related chat requests and outcomes in chronological order.
- The current repository architecture and operating rules.
- The current local, GitHub-branch, Supabase, and live cPanel website state.
- Current validation results, known issues, and unfinished work.
- The user's recurring preferences and decisions.

The chronology covers the predecessor `H:\My Drive\djshouseofcards-next-fixes-applied`
website work and every prior chat associated with the current
`C:\Users\djwan\Downloads\djshouseofcards-next-fixes-applied` workspace.
Credentials, passwords, tokens, and private values from older chats are
intentionally omitted.

## Executive Snapshot

- The site is a static HTML/CSS/JavaScript storefront with no normal npm build.
- The current active branch is `codex/sync-deployed-site-fixes`; this June 13
  release pass is being committed and pushed to that branch as the current
  GitHub sync point.
- The June 13 catalog/workbook pass normalized non-legacy workbook fields,
  restored/downloaded missing local photos, removed reused-image catalog issues,
  and generated updated non-legacy and legacy listing workbooks under
  `outputs/workbook-source-pass/`.
- Local catalog and public Supabase catalog media paths currently match:
  `3,180` local rows, `3,180` active remote rows, `0` missing remote rows, and
  `0` media-path mismatches after hard-deleting 23 remote-only Supabase rows.
- Local and live static code are on asset version `20260613c` and
  service-worker cache `dj-house-v2026-06-13-03`.
- The June 13 cPanel path-list release uploaded 206 reviewed files with
  `0` deletes. The post-deploy audit found 205 byte-matching files, `0`
  differences, `0` missing remote files, and only `.htaccess` unverified as a
  hidden file.
- Rendered live verification passed for desktop static pages, the basketball
  catalog, a multi-quantity cart item (`12 available` with cart quantity max
  `12`), and mobile catalog/cart/policy views. The Python smoke helpers remain
  blocked in this environment by missing `websockets`.
- Remaining Supabase caveat: the live `products` table still lacks the newer
  `quantity_available` sale-state column. The frontend currently falls back to
  `copy_count`, and the schema SQL in `supabase-schema.sql` still needs to be
  applied through Supabase SQL Editor or a machine with Supabase CLI/psql access.

## User Working Contract

These preferences were repeated across the project and should guide future work:

- Be proactive after the task is clear, but stay inside the requested scope.
- Treat broad site-review requests as implementation plus real verification.
- Use rendered desktop and mobile verification for shopper-facing changes.
- Work with existing local changes and never revert unrelated work.
- Treat the authoritative workbook `Listings` sheet as the source of truth for
  non-legacy listings.
- Keep uncertain product, photo, metadata, duplicate, and cleanup matches for
  review instead of guessing.
- Cleanup and duplicate-review work is report-only unless deletion is explicitly
  authorized.
- Do not hide listings as a substitute for deleting listings that were approved
  for permanent removal.
- Keep raw credentials out of chats and files. Use secure prompts, OAuth, or
  trusted secret stores.
- Require explicit authorization for cPanel deploys, Supabase writes, permanent
  listing/asset removal, live payment changes, and email sends.
- Prefer reviewed no-delete cPanel path-list releases.
- Do not delete assets during routine releases.
- Preserve bootstrap-first catalog loading and align public asset versions with
  the service-worker cache version.
- Matching Supabase row counts is not enough; verify relevant fields and media
  paths before declaring a catalog sync complete.

## Chronological Project History

### 2026-04-13 through 2026-05-29: Predecessor H-Drive Website Work

Thread: `DJ's Website Optimization`
(`019d8788-cbdc-7153-bb0a-5ae9bd6768ea`)

- Requested a full website code analysis, optimization, debugging, and publish.
- Established `catalog.js` as the center of storefront product loading.
- Changed hosted catalog loading to prefer JSON while keeping generated
  JavaScript bundles for `file://` fallback.
- Coupled catalog-script and service-worker cache versions.
- Performed local/live smoke validation, commit/push, and cPanel deployment.

Thread: `Summarize eBay HTML upload messages`
(`019e723d-6714-73b3-ab04-f6bdf8bf62f9`)

- Reconstructed prior requirements for the `Ebay Bulk Upload with HTML`
  workbook.
- Established conservative hosted-photo matching: exact schema fields,
  high-confidence matches only, and unresolved rows left for review.

### 2026-05-24 through 2026-06-07: Foundational Audit and Iterative Site Work

Thread: `Audit website files and assets`
(`019e59ca-f4db-7540-8061-98454236f6e9`)

This was the largest foundational thread. The user's requests progressed through:

- Complete website, GitHub, cPanel, Supabase, functionality, design, connection,
  and asset analysis.
- Making the current `C:\Users\djwan\Downloads\...` folder the real active Git
  checkout.
- Repeated deeper functionality, design, debugging, optimization, accessibility,
  admin, account, catalog, and code-comment passes.
- Workbook-driven listing additions, photo-link population, player/attribute
  correction, and pricing work.
- Fixing reported storefront regressions: product-card sizing, five desktop
  columns, duplicate Account links, account-page clutter, correct contact email,
  missing images, missing prices, ranged-price display, menu cleanup, and modal
  image loading.
- Adding Stripe Checkout scaffolding and requesting real customer purchases.
- Synchronizing GitHub, Supabase, and cPanel while protecting credentials.

Durable outcomes from this thread:

- Current folder became the active Git repository.
- Numerous storefront, catalog, account, admin, PWA, accessibility, performance,
  image, and pricing improvements landed across many commits.
- Ranged listings retain guide-range information but use the high numeric price
  for checkout/display where appropriate.
- Supabase Edge Functions were introduced for checkout and webhook handling.
- The public contact email was corrected to `djscardscomics13@gmail.com`.
- Asset paths were normalized to agree with Supabase public behavior.
- A prior checkpoint reached 3,332 local/remote products and zero media-path
  mismatches before the later authoritative-workbook reconciliation reduced the
  active catalog to 3,203.

### 2026-06-01 through 2026-06-05: Computer Cleanup Audit

Thread: `Find duplicate files`
(`019e8325-0bf7-7472-a866-d469902e8686`)

- Requested increasingly deep computer-wide cleanup and duplicate-file passes.
- Work stayed report-only; no files were deleted or moved.
- Produced a consolidated cleanup workbook and updated aggregated notes.
- This work is adjacent to the website but not part of the storefront runtime.

### 2026-06-06: Marketing Internship Guide

Thread: `Generate internship ideas`
(`019e9c49-4860-7930-8e23-dcce27119cf1`)

- Requested marketing internship assignments for the user's sister.
- Produced and refined the branded PDF at
  `outputs/DJ-House-of-Cards-Marketing-Internship-Guide.pdf`.

### 2026-06-06 through 2026-06-07: Safe cPanel Release Audit

Thread: `Audit cPanel asset deletions`
(`019e9e17-28c4-7e91-9edf-125f11ce0134`)

- Audited deleted assets against current catalog/live-facing references.
- Hardened the FTPS deploy script so asset deletes require explicit
  `-AllowAssetDelete`.
- Ensured skipped deletes do not advance deploy state.
- Added reviewed path-list release auditing and prepared a safe no-delete
  static release process.
- Recommended keeping asset cleanup separate from routine releases.

### 2026-06-06 through 2026-06-07: Deep Website Debugging

Thread: `Debug website flows`
(`019e9e1c-cd90-7323-beba-071c271b66b3`)

- Traced homepage, categories, product modals, wishlist, contact, search,
  filters, mobile menu, state, and data-loading flows.
- Fixed wishlist resilience, stale browser-history catalog state, year filters,
  invalid deep links, duplicate wishlist rendering/races, and cache-version
  drift.
- Repaired/verified the 48-item bootstrap flow and restored `seo.js`.

### 2026-06-06 through 2026-06-07: Performance Optimization

Thread: `Fix web performance issues`
(`019e9e1d-ba3c-7731-8a88-b40233f3a3ab`)

- Requested a senior performance pass with a safe middle ground of 48 items.
- Added per-category 48-item bootstrap JSON files.
- Catalog pages render bootstrap data first and hydrate the full catalog after
  user intent or a delayed background timer.
- Updated build, validation, cache, and deploy plumbing so the optimization is
  release-safe.

### 2026-06-07: WCAG 2.2 AA Work

Thread: `Audit WCAG 2.2 AA accessibility`
(`019ea0aa-772e-7ac2-914f-3fe344290928`)

- Audited contrast, keyboard navigation, focus, ARIA, forms, alt text,
  semantics, headings, and screen-reader behavior.
- Improved product-card contrast, heading hierarchy, contact validation,
  semantic roles, modal `inert` behavior, focus handling, and admin/catalog
  headings.

### 2026-06-07: Structured Data Work

Thread: `Audit structured data schemas`
(`019ea0ab-1422-76a0-a8b0-edf628637ce8`)

- Implemented Organization, LocalBusiness, Store, WebSite, page, breadcrumb,
  FAQ, Product, and Offer JSON-LD.
- Added structured-data build/audit tooling and visible contact-page FAQ
  content.
- A second rendered pass found no additional schema changes needed.

### 2026-06-07: Collector Profile Feature

Thread: collector-system design / `Implement only the collecter profiles section`
(`019ea0ac-819c-76c2-97a6-fb0050cde5e6`)

- Designed possible collector systems, then implemented only Collector Profiles
  per the user's strict scope request.
- Added account-page collector fields, preview, tags, completion meter, and
  responsive styling.
- Kept the collector profile in the existing localStorage buyer profile rather
  than adding backend persistence.

### 2026-06-07: Catalog Attribute and Product-Data Audit

Thread: `I want you to go through the site and ensure that all the products have the correct attributes and attribute cards`
(`019ea1de-ebfa-76b0-b97e-1b4f4a333291`)

- Expanded storefront attribute normalization and card/modal presentation.
- Kept richer attributes in full product details while limiting main-grid pills.
- Built and hardened `scripts/audit-product-catalog-quality.py`.
- Performed card-by-card audits for attributes, player, team, year, sport,
  league, image reuse, placeholders, and gallery ordering.
- Applied conservative fixes and regenerated catalog outputs when explicitly
  authorized.

### 2026-06-07: cPanel and Supabase Sync

Thread: `I want you to sync up cPanel and supabase with the current workspace/github repo`
(`019ea412-959a-7843-a702-07f3793623fa`)

- Established FTPS host/root configuration and safe dry-run/release behavior.
- Kept credentials out of tracked files.
- Reinforced the reviewed no-delete path-list release process.

### 2026-06-07 through 2026-06-12: Authoritative Listings, Simplification, and Production Checkout

Thread: `Optimize site and sync deploys`
(`019ea495-e613-7723-904f-110f4e348311`)

Status at this snapshot: active and unfinished.

Major user requests and outcomes:

- Consolidate project chats, debug/optimize, and sync GitHub, Supabase, cPanel.
- Permanently delete Supabase listings that should be removed rather than hide
  them.
- Make the current workbook `Listings` sheet authoritative for all non-legacy
  listings.
- Repair asset-loss regressions and restore non-legacy product photos.
- Simplify the site's code without reducing functionality.
- Add comments where they explain architecture or non-obvious behavior.
- Make Stripe Checkout and real customer accounts live with `$6.00` shipping.

Completed work recorded by the thread:

- Authoritative workbook reconciliation and permanent removal of 203 Supabase
  listings.
- Catalog/media repair and current 3,203-row local/remote media-path parity.
- Large runtime/admin simplification, including removal of obsolete `admin.js`.
- Checkout hardening, reservations, order history, webhook idempotency, and
  multi-copy inquiry fallback.
- Production checkout database tables and secrets are reportedly in place.
- Current hardened checkout commit is `11523d23`.

Still unfinished in that thread:

- Complete the reversible production-checkout probe and remove every test
  record/account after verification.
- Publish the current `20260612d` storefront release to cPanel.
- Re-run live verification after deployment.

### 2026-06-09: Multi-Platform Listing Automation Planning

Thread: `Sync listings across platforms`
(`019eaf44-0cde-7960-a936-ab27fee79894`)

- Requested synchronized listings across eBay, Facebook Marketplace, Whatnot,
  and the website.
- Established a safe architecture: one canonical listing source, OAuth/API
  connectors, stored platform listing IDs, and reconciliation.
- eBay is the strongest direct API path.
- Facebook Marketplace and Whatnot require eligibility/access verification
  before promising direct automation.

### 2026-06-11: Hosted Photo-Link and Missing-Photo Workbook Work

Thread: `Search through my photo hosting site...`
(`019eb7af-9fd9-77d0-8271-926181fe21d8`)

- Scoped work to `Needs Link` and later `No Photo` sheets.
- Conservatively matched local assets, created flat upload-ready folders, and
  left uncertain rows unresolved.
- Updated the workbook with newly hosted links for verified matches.

### 2026-06-12: Repository Agent Contract

Thread: `Improve codex agent markdown`
(`019ebaf4-670e-7ca3-b397-9beb3feb984f`)

- Reviewed, condensed, and website-specialized the Codex Agent Contract.
- Installed it as the repository's active `AGENTS.md`.
- The resulting `AGENTS.md` is currently the only pre-existing tracked local
  modification and has not been committed.

### 2026-06-12: Primary Workspace Consolidation

Current thread: `Review project chats and site`
(`019ebb19-f317-7733-93b7-a1345808d9a2`)

- Reconstructed the chronological project history.
- Audited the repository, catalog, Supabase media parity, live cPanel state,
  local/live rendered behavior, validators, and current open risks.
- Created this durable handoff.

## Current Architecture

### Runtime

1. Static HTML pages load shared versioned CSS and only the JavaScript modules
   needed by each page.
2. `core.js` creates `window.DJ` and provides shared helpers, image fallback,
   theme, wishlist, accessibility, catalog fallback loading, and service-worker
   registration.
3. `nav.js` owns desktop/mobile navigation behavior.
4. `catalog.js` owns catalog source selection, normalization, filters, cards,
   wishlist actions, pagination, bootstrap-first loading, and product modals.
5. `supabase-client.js` is the only browser module that directly accesses
   Supabase. It owns auth, product row mapping, catalog reads/writes, uploads,
   checkout function invocation, and order reads.
6. `backend-admin.js` is the only listing editor and writes directly to live
   Supabase after admin authentication.
7. `payments.js` owns browser-safe customer auth and the bridge to Stripe
   Checkout through Supabase Edge Functions.
8. `account.js` owns local buyer/collector profiles plus remote order history.
9. `contact.js`, `seo.js`, `offline.js`, and `sw.js` own their respective
   focused concerns.

### Sources of Truth

- Non-legacy listings: authoritative workbook `Listings` sheet.
- Live catalog: Supabase `products`.
- Deployable static catalog: `products.json`.
- Generated category/bootstrap/fallback files: built from `products.json`.
- Product media: `assets/`.
- Storefront rendering behavior: `catalog.js`.
- Supabase browser mapping and access: `supabase-client.js`.

### Generated Catalog Rule

Never manually edit `products-data-*.js`, `products-bootstrap-*.json`, or
category product JSON files. After an approved `products.json` change, run:

```powershell
node .\scripts\build-public-catalog.mjs --optimize-segments
```

Use the workspace-bundled Node executable when `node` is not on `PATH`.

## Current Repository and Catalog Snapshot

### Repository Shape

- Tracked/non-ignored files found by `rg --files`: 13,288.
- Most files are product media: 6,579 WebP, 5,902 JPG, and 690 JPEG files.
- Main source surface: 14 HTML pages, 21 JavaScript files, 2 CSS files,
  Supabase SQL/Edge Functions, and local validation/deployment scripts.
- Main CSS remains large: `styles.css` is about 228 KB and
  `styles-mobile-overrides.css` is about 43 KB.
- `catalog.js` is about 177 KB and is the largest hand-authored browser module.

### Catalog

- Total products: 3,203.
- Authoritative-workbook/non-legacy products: 2,232.
- Legacy or other products: 971.
- Baseball: 805.
- Basketball: 1,880.
- Football: 340.
- Comics: 165.
- Collectibles: 13.
- Products with a positive numeric price: 3,183.
- Contact-for-price or non-positive-price products: 20.
- Placeholder primary images: 191.
- External primary-image URLs: 0.
- Supabase media parity: 3,203 local, 3,203 active remote, 0 mismatches.

## Current Verification Results

### Passed

- `scripts/site-integrity-check.mjs`
  - 14 HTML files.
  - 3,203 catalog rows.
  - Asset version `20260612d`.
  - 0 issues.
- `scripts/audit-structured-data.mjs`
  - Passed all static page schemas and Product/Offer runtime sample.
- `scripts/normalize-range-checkout-prices.mjs --check`
  - Checked 2,248 ranged listings across eight catalog files.
  - 0 incorrect.
- JavaScript syntax checks
  - Passed for 12 main browser/service-worker scripts.
- `scripts/audit-secrets.ps1`
  - Passed.
- Local mobile smoke
  - Filter drawer, nav, theme placement, product modal, and close geometry pass.
- Live mobile smoke
  - Same focused checks pass on the live site.
- Browser-rendered local baseball page
  - 48 visible cards, 5 desktop columns, 0 broken loaded images,
    0 horizontal overflow, 1 Account link, and no console warnings/errors.
- Browser-rendered live baseball page
  - 48 visible cards, 5 desktop columns, 0 broken loaded images,
    0 horizontal overflow, 1 Account link, no console warnings/errors,
    and product modal opens with a loaded image.
- Local and live contact pages display `djscardscomics13@gmail.com`.

### Incomplete or Failed Checks

- `scripts/desktop_smoke_check.py` crashes in the smoke harness at the local
  wishlist assertion because `local_wishlist_report` can be `None`.
  It crashes the same way against local and live before writing a final report.
- `scripts/hard-delete-supabase-products-not-in-catalog.mjs` could not run in
  audit mode because the current process does not have a service-role key.
- A current deep field-by-field Supabase comparison was not performed. Current
  verification confirms row count and media-path parity only.

## Current Local Versus Live State

### Local / GitHub Branch

- Local storefront version: `20260612d`.
- GitHub remote feature branch matches local HEAD `11523d23`.
- Current branch is 46 commits ahead of `main`.
- Current checkout/account code includes customer auth, checkout reservations,
  order history, webhook idempotency, and multi-copy inquiry fallback.

### Supabase

- Public product/media audit: 3,203 active rows and zero media-path mismatches.
- Production checkout tables and required secrets are reported as installed by
  the still-active deployment thread.
- The latest hardened checkout and webhook Edge Functions are deployed, and the
  temporary deployment token used for that release was revoked.
- Do not call Stripe Checkout fully live-ready until the active thread finishes
  its reversible checkout probe, test-data cleanup, and final verification.

### Live cPanel

- Live storefront still serves asset version `20260612b`.
- Local storefront serves `20260612d`.
- Reviewed release audit: 22 files different, 12 files the same, 0 remote files
  missing, `.htaccess` unverified.
- Live pages still render successfully in the focused checks, but they do not
  yet contain the latest local checkout/account/runtime release.

## Current Catalog-Quality Findings

The audit-only product-quality pass reported 1,501 issues across 3,203 products.
No fixes were applied.

- 1,115 attribute mismatches:
  - 1,020 are attribute-order-only differences with the same attribute set.
  - 95 are substantive attribute differences that deserve review.
- 23 fixable `playerAthlete` mismatches.
- 1 fixable team mismatch.
- 1 fixable sport mismatch.
- 147 pre-2000 placeholder primary images for review.
- 44 other placeholder primary images for review.
- 162 reused-image findings for review.
- 7 missing-player review findings.
- 1 player-not-visible-in-title review finding.

Do not run `scripts/audit-product-catalog-quality.py --fix` without explicit
authorization. The current raw fixable count is inflated by the 1,020
attribute-order-only differences.

## Known Issues and Open Work

1. Finish the active production-checkout verification and cPanel release
   thread.
2. Deploy the reviewed current static release to cPanel after checkout function
   verification; cPanel is currently behind local/GitHub.
3. Re-run cPanel audit, live desktop/mobile smoke, schema, site integrity, and
   live checkout closed-state checks after deployment.
4. Fix the desktop smoke harness null handling before relying on it as a release
   gate.
5. Perform a reviewed catalog-quality pass focused first on the 95 substantive
   attribute mismatches and the 25 player/team/sport mismatches.
6. Review placeholder and reused-image findings conservatively; do not guess or
   delete assets.
7. Perform a deeper Supabase field-parity comparison after the checkout release.
8. Decide whether and when the 46-commit feature branch should be merged into
   `main`.
9. Review and commit the new `AGENTS.md` contract and this handoff document only
   when the user requests it.

## Safe Next Sequence

1. Let `Optimize site and sync deploys`
   (`019ea495-e613-7723-904f-110f4e348311`) finish or explicitly stop it before
   starting another live deploy.
2. Confirm the reversible checkout probe and test-data cleanup completed, then
   verify the functions' closed-state/auth behavior without leaving a live
   charge or test account behind.
3. Audit the reviewed cPanel release path list.
4. Dry-run the cPanel release.
5. Deploy the reviewed no-delete release.
6. Confirm live asset version `20260612d`.
7. Re-run local/live rendered checks and the repository validators.
8. Address catalog-quality issues only through a separately reviewed,
   explicitly authorized catalog-data task.

## Standard Verification Commands

Use the workspace Node executable if `node` is unavailable.

```powershell
node .\scripts\site-integrity-check.mjs
node .\scripts\audit-structured-data.mjs
node .\scripts\normalize-range-checkout-prices.mjs --check
python .\scripts\audit-product-catalog-quality.py
powershell -ExecutionPolicy Bypass -File .\scripts\audit-secrets.ps1
git diff --check
```

Safe cPanel review:

```powershell
node .\scripts\audit-cpanel-release.mjs .\scripts\cpanel-current-static-no-assets-release.txt
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -DryRun -PathList .\scripts\cpanel-current-static-no-assets-release.txt
```

Do not run the actual deploy, Supabase `--apply`, catalog audit `--fix`, or
permanent removal commands without explicit authorization.

## Chat Consolidation Guidance

This document plus the current primary chat now contains the durable project
context needed for future work. Older completed chats can be removed after the
user is satisfied with this handoff.

Do not delete or archive the still-active `Optimize site and sync deploys`
thread until its checkout/function/cPanel work is finished or intentionally
stopped. Its live deployment state is the one remaining piece that can still
change after this snapshot.
