# Shopify, TikTok Shop, and Whatnot Sync

Shopify should be the marketplace hub for this storefront:

```text
DJ's website / Supabase <-> Shopify <-> TikTok Shop
                                  <-> Whatnot
```

The official TikTok and Whatnot Shopify sales channels synchronize products,
inventory, and orders. Shopify remains the source of truth for fields shared
with Whatnot.

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
6. Create a Shopify custom app with the minimum required Admin API scopes:
   `read_products`, `write_products`, `read_inventory`, `write_inventory`,
   `read_locations`, and the order/webhook scopes required by the final flow.

Keep Shopify credentials in Supabase Edge Function secrets or another trusted
secret store. Never place them in browser JavaScript, static site files, Git,
or cPanel.

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

Use Shopify's `productSet` mutation for catalog synchronization and
`inventorySetQuantities` or the appropriate inventory-adjustment mutation for
inventory changes. The exact mutation and compare-and-swap behavior should be
verified against the selected Shopify API version when the custom app is
created.

## TikTok Shop

Install Shopify's TikTok sales channel after Shopify inventory is verified.
TikTok requires a verifiable Shopify location, an online store, a TikTok for
Business account, a visible return policy, merchant verification, and valid
warehouse information. Product category, dimensions, weight, or certification
review may still be required during channel onboarding.

Official setup:

https://help.shopify.com/en/manual/online-sales-channels/social-commerce/tiktok/setup

## Whatnot

Install the official Whatnot Sales Channel:

https://apps.shopify.com/whatnot

Connect a Whatnot Owner or Manager account, select the Shopify products to
sync, review failed inventory, and activate approved Buy It Now listings.
Newly synchronized products initially appear as inactive Whatnot inventory.

Official setup:

https://help.whatnot.com/hc/en-us/articles/44650692889997-Shopify-x-Whatnot-Integration

## Shopify References

- Product CSV:
  https://help.shopify.com/en/manual/products/import-export/using-csv
- External catalog sync:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/productSet
- Inventory synchronization:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities
