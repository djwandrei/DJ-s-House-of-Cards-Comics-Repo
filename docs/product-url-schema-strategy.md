# Product URL and Product schema strategy

## Current evidence

The storefront is a static cPanel site. `DJ.productPageUrl()` creates a
category URL with `?item=<id>`, `catalog.js` opens that product in a client-side
modal, and browser history retains the query URL for sharing. Each static
category HTML file has a category self-canonical URL, while `seo.js` can inject
`Product` and `Offer` JSON-LD after the product data and modal are available.

That is a mixed model: the shareable query opens a useful product view for a
shopper, but it is not a self-canonical, initially rendered product document.

## Options

| | 1. Generated product-detail pages | 2. Category-modal URLs consolidated to category pages |
| --- | --- | --- |
| SEO model | Every product receives a crawlable, self-canonical HTML URL with initial Product and Offer schema. | Category pages are the only crawl targets; `?item=` is a shopper sharing/state URL, not a separate rich-result target. |
| Correctness | Strongest product-rich-result alignment, provided availability and price are regenerated accurately. | Matches the current static initial HTML and category canonicals; avoids presenting client-only product schema as a separate document. |
| Static-hosting fit | Requires a generator to emit and maintain thousands of product pages, canonical metadata, XML sitemap entries, and retired-product handling. | Works directly with the existing static cPanel deployment and catalog generation model. |
| Catalog impact | Requires a complete product-page build stage and strict data-change/rebuild discipline. | No product-data rewrite; category catalog generation remains unchanged. |
| Sharing | Native product URLs with initial title, image, and description. | Shared links still reopen the product modal, but social/SEO previews remain category-level. |
| Maintenance cost | Higher: stale availability, price, image, redirects, and sitemap lifecycle all need ongoing guarantees. | Lower: one stable page per department and one canonical model. |

## Recommendation

Adopt option 2 for the current static architecture: preserve `?item=` for
shopper sharing and modal restoration, canonicalize it to the category page,
and do not treat it as an independently indexable Product page. This is the
smallest correct model until there is an approved investment in generated,
self-canonical product-detail pages.

## Approval gate

No product URL, catalog record, or Product/Offer schema behavior is changed by
this analysis. If option 1 is approved later, first define the generated URL
format, product retirement policy, static HTML payload budget, sitemap build,
and a deterministic catalog-to-page verification step. If option 2 is approved
for implementation, make the smallest schema/runtime adjustment needed to keep
query URLs from implying separate rich-product intent.
