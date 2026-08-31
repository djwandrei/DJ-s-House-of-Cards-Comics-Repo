# Route map

## Architecture

This is a **multi-page vanilla static HTML/CSS/JavaScript site**. It has no React/Vue/Svelte component tree, no Next/Nuxt/Astro file router, and no React Router-style configuration. Each URL maps directly to a static HTML document. Shared storefront navigation is configured in `nav.js` through `PAGE_NAV_CONFIG`; the storefront shell markup is repeated in individual page files and enhanced by `core.js`.

Lineup Lab is intentionally different: its deployable page is `/lineup-lab/`, generated from the source folder `prototypes/basketball-lineup-optimizer/`. This map references the source folder, not the generated `lineup-lab/` output.

## Storefront browsing

| URL | Source entry | Shell | Summary |
| --- | --- | --- | --- |
| `/` | `index.html` | Repeated storefront header/footer + `core.js` + `nav.js` | Home storefront, hero, Lineup Lab promo, featured catalog cards, and product-details modal. |
| `/shop.html` | `shop.html` | Shared storefront shell | General catalog browsing and filtering. |
| `/sports-cards.html` | `sports-cards.html` | Shared storefront shell | Sports-card hub. |
| `/baseball-cards.html` | `baseball-cards.html` | Shared storefront shell | Baseball catalog. |
| `/basketball-cards.html` | `basketball-cards.html` | Shared storefront shell | Basketball catalog; destination used by Lineup Lab's “Find Cards” link. |
| `/football-cards.html` | `football-cards.html` | Shared storefront shell | Football catalog. |
| `/comics.html` | `comics.html` | Shared storefront shell | Comics catalog. |
| `/collectibles.html` | `collectibles.html` | Shared storefront shell | Collectibles catalog. |

## Buyer and transaction pages

| URL | Source entry | Shell | Summary |
| --- | --- | --- | --- |
| `/wishlist.html` | `wishlist.html` | Shared storefront shell | Device/account-synchronized wishlist view. |
| `/cart.html` | `cart.html` | Shared storefront shell | Cart and checkout handoff. |
| `/checkout-success.html` | `checkout-success.html` | Shared storefront shell | Submitted checkout confirmation and reconciliation status. |
| `/account.html` | `account.html` | Shared storefront shell | Customer account workspace. |
| `/offer.html` | `offer.html` | Shared storefront shell | Offer workflow. |

## Contact and informational pages

| URL | Source entry | Shell | Summary |
| --- | --- | --- | --- |
| `/about.html` | `about.html` | Shared storefront shell | Store background and brand context. |
| `/contact.html` | `contact.html` | Shared storefront shell | Contact page. |
| `/sell-trade-want-list.html` | `sell-trade-want-list.html` | Shared storefront shell | Sell, trade, and want-list workflow. |
| `/policies.html` | `policies.html` | Shared storefront shell | Policies and authenticity information. |
| `/shipping.html` | `shipping.html` | Shared storefront shell | Shipping policy. |
| `/returns.html` | `returns.html` | Shared storefront shell | Returns policy. |
| `/offline.html` | `offline.html` | Lightweight offline shell | Offline fallback page for the service-worker experience. |

## Administration and internal workflow pages

| URL | Source entry | Shell | Summary |
| --- | --- | --- | --- |
| `/admin.html` | `admin.html` | Shared storefront shell | Catalog and administration workspace. |
| `/inbox.html` | `inbox.html` | Shared storefront shell | Administration inbox. |
| `/metrics.html` | `metrics.html` | Shared storefront shell | Conversion and performance metrics view. |

## Lineup Lab

| URL | Source entry | Shell | Summary |
| --- | --- | --- | --- |
| `/lineup-lab/` | `prototypes/basketball-lineup-optimizer/index.html` | Dedicated `.lab-header` / `.lab-footer`; not the storefront navigation | Historical NBA exact lineup and 8–12 player rotation optimizer. It has tabs for optimizer, player comparison, collector watchlist, and model/data documentation. The source page loads `app.js` as an ES module and the shared Supabase browser adapter; it remains intentionally separate from normal storefront navigation and search discovery. |

### Lineup Lab source dependency map

```text
prototypes/basketball-lineup-optimizer/index.html
├─ styles.css
├─ ../../backend-config.js
├─ ../../supabase-client.js
└─ app.js
   ├─ optimizer-core.js
   ├─ player-data.js
   ├─ supabase-nba-data.js
   ├─ fan-analytics.js
   ├─ scenario-url.js
   ├─ optimizer-worker.js
   └─ fixtures/timberwolves-2021-22.json
```

There is no full router-config source to embed because routing is browser/server static-file resolution rather than a JavaScript router.

