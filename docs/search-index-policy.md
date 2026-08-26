# Search indexing policy

This matrix treats `noindex` as an indexing instruction, not an access-control
mechanism. `robots.txt` permits crawling so search engines can observe each
page-level robots directive. Supabase authentication and authorization remain
the access controls for admin data and actions.

| URL | Policy | Sitemap | Canonical and schema |
| --- | --- | --- | --- |
| `/` | Public-indexable | Yes | Self-canonical; `WebPage` |
| `/shop.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/sports-cards.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/baseball-cards.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/basketball-cards.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/football-cards.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/comics.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/collectibles.html` | Public-indexable | Yes | Self-canonical; `CollectionPage` |
| `/about.html` | Public-indexable | Yes | Self-canonical; `AboutPage` |
| `/contact.html` | Public-indexable | Yes | Self-canonical; `ContactPage` |
| `/sell-trade-want-list.html` | Public-indexable | Yes | Self-canonical; `ContactPage` |
| `/policies.html` | Public-indexable | Yes | Self-canonical; `WebPage` |
| `/shipping.html` | Public-indexable | Yes | Self-canonical; `WebPage` |
| `/returns.html` | Public-indexable | Yes | Self-canonical; `WebPage` |
| `/wishlist.html` | Crawlable-noindex | No | Self-canonical; `noindex,nofollow` |
| `/cart.html` | Crawlable-noindex | No | Self-canonical; `noindex,nofollow` |
| `/checkout-success.html` | Crawlable-noindex | No | Self-canonical; `noindex,nofollow` |
| `/account.html` | Crawlable-noindex | No | Self-canonical; `noindex,nofollow` |
| `/offer.html` | Crawlable-noindex | No | Self-canonical; `noindex,nofollow` |
| `/lineup-lab/` | Crawlable-noindex public beta | No | Self-canonical; `noindex,nofollow` |
| `/offline.html` | Crawlable-noindex | No | No indexable canonical; `noindex,nofollow` |
| `/admin.html` | Authentication-protected | No | Self-canonical; `noindex,nofollow` |
| `/inbox.html` | Authentication-protected | No | Self-canonical; `noindex,nofollow` |
| `/metrics.html` | Authentication-protected | No | Self-canonical; `noindex,nofollow` |

## Release rule

Public URLs in `sitemap.xml` receive the release date only when their visible
or indexable content changes. Do not add noindex or authenticated URLs to the
sitemap. Before changing this matrix, update the structured-data build and
audit registries, then run `node scripts/audit-search-index-policy.mjs` and
`node scripts/audit-structured-data.mjs`.

## Product detail URLs

Category pages with `?item=` are covered separately in
`docs/product-url-schema-strategy.md`. They remain category-canonical until a
product-detail architecture is explicitly approved.
