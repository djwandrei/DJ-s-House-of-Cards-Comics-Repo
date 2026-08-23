# Codex Agent Contract: DJ's House of Cards & Comics

## Operating Rules

This is a static HTML/CSS/JavaScript storefront with Supabase catalog
administration, Stripe Checkout through Supabase Edge Functions, generated
catalog fallbacks, local product media, and FTPS deployment to cPanel. There is
no normal npm build step.

- Make the most efficient correct change and verify the affected shopper/admin flow.
- Treat this file as the root contract. Read `CODEBASE_GUIDE.md` for architecture
  or data flow and `CPANEL-DEPLOY.md` for deployment/live sync.
- Stay within the requested feature or workflow. Avoid adjacent changes, broad
  rewrites, formatting churn, speculative optimization, and new dependencies
  without clear need.
- Normal implementation stays local. Live or destructive actions require
  explicit authorization.
- Broad site reviews require rendered desktop and mobile verification when deemed absolutely necessary
- Work with existing user changes; never revert unrelated work.
- Finish only after reviewing the diff, synchronizing required generated files,
  and reporting real caveats or skipped checks.

## Repo Facts

Ownership:

- `core.js`: shared helpers, initialization, asset versions, theme, wishlist,
  image fallbacks, and accessibility utilities
- `catalog.js`: product loading/rendering, filters, cards, wishlist, modal, and
  pagination
- `supabase-client.js`: only browser module that directly accesses Supabase
- `backend-admin.js`, `payments.js`, `account.js`: admin, checkout, and buyer
  workspace behavior
- `nav.js`, `contact.js`, `seo.js`, `sw.js`: navigation, contact, metadata, and
  service-worker behavior
- `styles.css`: shared/desktop styles
- `styles-mobile-overrides.css`: final narrow-screen overrides; inspect it for
  every mobile change

Sources of truth:

- Non-legacy listings: `Listings` sheet in
  `C:\Users\djwan\Downloads\Ebay Bulk Upload - 08-22-2026.xlsx`
- Live catalog: Supabase `products`
- Deployable static catalog/generation source: `products.json`
- Product media: `assets/`
- Product rendering: `catalog.js`
- Supabase row mapping/browser access: `supabase-client.js`

After release, Supabase and the static catalog should match on product IDs,
media paths, and relevant fields. Matching row counts is insufficient.

Never manually edit `products-data-*.js`, `products-bootstrap-*.json`, or
category product JSON files. After an approved `products.json` change, run:

```powershell
node .\scripts\build-public-catalog.mjs --optimize-segments
```

Use the workspace Node runtime if `node` is unavailable. Use
`scripts/audit-product-catalog-quality.py --fix` only when explicitly asked;
its default mode is audit-only.

## Safety

Do not modify, stage, commit, upload, move, delete, overwrite, or regenerate
protected material unless explicitly required:

- `.env*`, `codex_account_keys.env`, credentials, tokens, and private keys
- `.deploy/` configuration/state
- product/listing data, customer/order/payment data, and financial records
- authoritative workbooks, exports, curated files, source images, and backups

Never expose secrets or stage `codex_account_keys.env`. Do not inspect private
credentials, deployment config, customer records, or workbook data unless
required.

Explicit authorization is required for:

- cPanel deployment, Supabase writes, or any script's `--apply` mode
- permanent listing/asset removal or `-AllowAssetDelete`
- payment configuration changes, live charges, email sends, or customer/order
  modifications

Before destructive work, identify the exact scope, preserve a backup when
practical, run an audit/dry run, review the proposal, apply only the reviewed
scope, and verify the result.

Cleanup/duplicate-review tasks are report-only unless removal is authorized.
Never delete from filename similarity alone or hide a listing instead of
deleting it.

## Execution

Inspect first:

```powershell
git status --short --branch
git diff --stat
rg -n -m 30 "exact error|symbol|route|filename" .
```

Search before opening large files. Use targeted reads; avoid secrets and large
catalog, bundle, asset-tree, log, or diff dumps. Expand scope only when evidence
or the request requires it.

Edit rules:

- Follow existing architecture, naming, formatting, and browser APIs.
- Fix the root cause with the smallest complete diff.
- Keep shared behavior in its existing shared module.
- Reuse localStorage helpers for local-only buyer features; do not add backend
  persistence unless requested.
- Do not alter product data, image links, URLs, branding, or unrelated copy
  during ordinary UI work.

Task-specific rules:

- **Storefront UI:** Trace the page HTML and owning module. Start catalog UI in
  `catalog.js` and shared initialization/helpers in `core.js`. Check both style
  sheets and affected shared-component pages.
- **Account/Admin:** Keep collector profiles in the existing `account.js`
  localStorage profile unless remote persistence is requested. Treat admin
  actions as live Supabase writes; keep browser access in `supabase-client.js`.
- **Catalog:** Use `scripts/audit-product-catalog-quality.py` for catalog-wide
  review. Leave uncertain product/image/metadata matches for review. Local
  generated files do not prove Supabase parity.
- **SEO/Accessibility:** Keep canonical URLs, descriptions, headings, JSON-LD,
  and visible content aligned.
- **Performance:** Preserve bootstrap-first catalog loading unless evidence
  supports changing it. Optimize only after identifying a real bottleneck.
- **Cleanup:** Check references, links, imports, service-worker entries, config,
  hashes, dimensions, generated status, and live usage.
- **Payments:** Never create live charges during verification.

Review last:

```powershell
git diff --check
git diff --stat
git diff -- path\to\affected-file
```

Check for secrets, unrelated edits, encoding damage, accidental generated-file
changes, and unexpected product/asset changes.

## Verification

Run the narrowest checks covering the risk. Baseline:

```powershell
node .\scripts\site-integrity-check.mjs
git diff --check
```

Add when relevant:

- JavaScript: `node --check .\path\to\changed-script.js`
- catalog/data: `python .\scripts\audit-product-catalog-quality.py`
- SEO/schema: `node .\scripts\audit-structured-data.mjs`
- Python: `python -m py_compile .\path\to\changed_script.py`
- release/admin/Supabase/payment/credential-adjacent work:
  `powershell -ExecutionPolicy Bypass -File .\scripts\audit-secrets.ps1`
- shopper-facing behavior/layout: relevant desktop/mobile smoke checks and a
  rendered browser check at affected viewports

Use cache-busted URLs when stale assets could hide results. If a check cannot
run, state why and use the strongest available fallback. Never claim success
without relevant verification.

## Authorized Release

Before deploying changed cacheable JS, CSS, or catalog assets, align
`PRODUCT_ASSET_VERSION` in `core.js`, HTML/service-worker query versions, and
`CACHE_VERSION` in `sw.js`.

Routine static release:

```powershell
node .\scripts\audit-cpanel-release.mjs .\scripts\cpanel-current-static-no-assets-release.txt
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -DryRun -PathList .\scripts\cpanel-current-static-no-assets-release.txt
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -PathList .\scripts\cpanel-current-static-no-assets-release.txt
```

- Path-list releases contain only reviewed files and perform no deletes.
- Prefer `-SkipDelete` outside path-list releases.
- Never use `-AllowAssetDelete` without a live-reference audit and approval.
- Audit Supabase media paths with
  `node .\scripts\sync-supabase-image-paths.mjs` before repairs.
- Use `scripts/import-products-to-supabase.ps1` only for requested catalog sync.
- Verify requested live work, shopper/admin behavior, and relevant field parity.
