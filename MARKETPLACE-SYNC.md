# Shopify, Facebook, TikTok Shop, and Whatnot Sync

Shopify should be the marketplace hub for this storefront:

```text
DJ's website / Supabase <-> Shopify <-> TikTok Shop
                                  <-> Whatnot
DJ's website / Supabase -> Facebook Commerce feed
```

The official TikTok and Whatnot Shopify sales channels synchronize products,
inventory, and orders. Shopify remains the source of truth for fields shared
with Whatnot.

Facebook is intentionally independent of Shopify for now. Its catalog feed is
generated from the same website catalog and uses the same stable `DJHC-{product
ID}` identifier as the Shopify SKU so sales can be reconciled back to the same
website/Supabase inventory row.

Legacy listings are intentionally retained as Shopify drafts. Only eligible
non-legacy workbook listings may be activated or published to TikTok and
Whatnot.

## Prepared Catalog

Generate the current Shopify import and review files:

```powershell
node .\scripts\build-shopify-catalog.mjs
```

Use the workspace Node runtime when `node` is not on `PATH`.

The command creates ignored local artifacts under `outputs/marketplace-sync/`:

- `shopify-products-draft.csv`: Shopify import, intentionally unpublished and
  in draft status
- `shopify-marketplace-readiness.xlsx`: review workbook with product,
  inventory, price, image, and shipping-weight checks
- `shopify-product-review.json`: machine-readable product review data
- `shopify-catalog-summary.json`: generation totals and blockers

Every product uses a stable `DJHC-{product ID}` SKU and `djhc-{product ID}`
Shopify handle. Do not replace these values with title-derived identifiers;
titles can change, while channel inventory mappings must remain stable.

Generate the current Facebook Commerce feed:

```powershell
node .\scripts\build-facebook-catalog.mjs
```

The command creates:

- `facebook-products.csv`: Meta Commerce Manager feed for eligible non-legacy
  products with real images, positive prices, and available inventory
- `feeds/facebook-products.csv`: deployable public feed for Meta scheduled URL
  ingestion at `https://www.djshouseofcards-comics.com/feeds/facebook-products.csv`
- `facebook-product-review.json`: per-product eligibility/rejection data
- `facebook-catalog-summary.json`: feed totals and blocker counts

The Facebook feed uses the website URL as the product `link`, not Shopify. This
keeps Facebook independent of Shopify while still preserving the same `DJHC-*`
product IDs used by Shopify mappings.

## Release Gates

Do not activate or publish the generated catalog until:

1. The live Supabase schema includes `quantity_available`,
   `checkout_enabled`, and `sale_status` from `supabase-schema.sql`.
2. The zero-price/contact-for-price rows in the workbook are priced or kept
   unpublished.
3. The provisional per-item shipping weights are reviewed. Whatnot assigns
   shipping profiles from Shopify weights.
4. Shopify location, shipping, tax, return, and payment settings are verified.
5. A small product batch is imported and checked before the full catalog.
6. Facebook catalog imports should use the generated feed and preserve the
   `id` column exactly. Do not allow Meta to regenerate item IDs from titles.

The current catalog has 2,232 non-legacy listings with prices. The 948 legacy
listings, including all 20 zero-price/contact-for-price rows, must remain draft.

The generator's weight suggestions are review values, not measured package
weights:

- raw sports card: 113 g
- graded sports card: 170 g
- comic: 454 g
- collectible: 907 g
- additional cards identified by workbook card count: 5 g each

## Shopify Setup

1. Create or open the Shopify store.
2. Configure the physical inventory location and shipping settings.
3. Import `shopify-products-draft.csv`.
4. Verify products, images, quantities, prices, SKUs, and weights.
5. Keep the products in draft until website synchronization is connected.
6. Create a Shopify Dev Dashboard app with the minimum required Admin API scopes:
   `read_products`, `write_products`, `read_inventory`, `write_inventory`,
   `read_locations`, `read_publications`, and `write_publications`.
7. Apply `supabase/marketplace-schema.sql`, configure the Shopify Edge Function
   secrets, deploy `shopify-webhook`, `shopify-catalog-sync`,
   `shopify-oauth-start`, and `shopify-oauth-callback`.
8. In the Shopify Dev Dashboard app version, use the OAuth start function as the
   app URL and the callback function as the allowed redirection URL. Enable the
   non-embedded legacy install flow only for this standalone inventory sync app,
   install the app, bootstrap the SKU mappings, and register the inventory
   webhook.
9. Run the read-only verification action before connecting TikTok or Whatnot:

   ```powershell
   node .\scripts\verify-shopify-sync.mjs
   ```

   The script requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
   current shell. It calls `shopify-catalog-sync` with
   `action: verify-catalog`, confirms mapping coverage, SKU format, quantities,
   prices, primary Shopify images, webhook failures, and verifies that every
   legacy mapping remains draft-gated.
   If the verifier reports `missingShopifyImages`, preview and repair only those
   rows with `action: repair-missing-images`; the action defaults to dry-run
   unless `dryRun` is explicitly set to `false`.
10. Activate eligible non-legacy products with `action:
    activate-nonlegacy-products`, then publish them to reviewed sales channels
    with `action: publish-nonlegacy-products`. The publication action is also
    dry-run by default and supports `channels`, `limit`, and `afterProductId`.
    Shopify products must be `ACTIVE` before they can appear in channels, but
    active status alone does not publish them.

Keep Shopify credentials in Supabase Edge Function secrets or another trusted
secret store. Never place them in browser JavaScript, static site files, Git,
or cPanel. New Dev Dashboard apps use `SHOPIFY_CLIENT_ID` and
`SHOPIFY_CLIENT_SECRET`; the Edge Functions request and cache Shopify's
short-lived Admin API token server-side when needed. The OAuth callback
exchanges the authorization code to complete app installation, but it does not
return or log the access token.

## Website Inventory Automation

The durable synchronization flow is:

1. Shopify inventory changes update Supabase through a signed Shopify webhook.
2. TikTok and Whatnot orders reduce Shopify inventory through their official
   sales channels; Shopify then sends the same inventory change to Supabase.
3. Website Stripe orders finalize Supabase inventory and call Shopify's Admin
   API to apply the matching inventory adjustment.
4. Product mappings store the website product ID, Shopify product ID, variant
   ID, inventory item ID, and location ID.
5. Webhook event IDs are recorded for idempotency so retries cannot decrement
   inventory twice.

`shopify_product_mappings.publish_enabled` is an additional release gate.
Mappings start with publishing disabled. Keep it disabled for every legacy
listing; enabling it is allowed only for reviewed non-legacy listings.

For Facebook, use the generated `DJHC-*` feed ID as the reconciliation key. If a
Facebook sale is completed outside Shopify, subtract inventory from the matching
website/Supabase product first, then let the Shopify sync flow reconcile the
matching Shopify SKU. Do not mark Facebook-only sales against title text; title
matching is not stable enough for inventory.

The integration uses Shopify API version `2026-04`. Admin listing saves use
`productSet` for safe product fields and `productVariantsBulkUpdate` for price.
Website Stripe sales use `inventoryAdjustQuantities` with Shopify's required
`@idempotent` key. Shopify `inventory_levels/update` webhooks then apply the
absolute quantity to Supabase. The webhook HMAC still uses the Shopify client
secret, while outbound Admin API calls use the client credentials grant flow.

## TikTok Shop

Install Shopify's TikTok sales channel after Shopify inventory is verified.
TikTok requires a verifiable Shopify location, an online store, a TikTok for
Business account, a visible return policy, merchant verification, and valid
warehouse information. Product category, dimensions, weight, or certification
review may still be required during channel onboarding. Do not enable TikTok
publishing until the verification action returns
`safeForChannelOnboarding: true`.

Official setup:

https://help.shopify.com/en/manual/online-sales-channels/social-commerce/tiktok/setup

## Whatnot

Install the official Whatnot Sales Channel:

https://apps.shopify.com/whatnot

Connect a Whatnot Owner or Manager account, select the Shopify products to
sync, review failed inventory, and activate approved Buy It Now listings.
Newly synchronized products initially appear as inactive Whatnot inventory.
Keep legacy Shopify listings in Draft and exclude them from Whatnot activation.

Official setup:

https://help.whatnot.com/hc/en-us/articles/44650692889997-Shopify-x-Whatnot-Integration

## Shopify References

- Product CSV:
  https://help.shopify.com/en/manual/products/import-export/using-csv
- External catalog sync:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
- Inventory synchronization:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
