# NBA analytics project transition

## Ownership boundary

The existing Supabase project remains the commerce system of record. It owns
the catalog, product media, product-to-athlete mappings, customer/auth data,
orders, payments, and all storefront administration.

The dedicated NBA analytics project owns only reusable NBA identity and
historical analytics data. It must not receive product rows, product assets,
customer data, orders, payment records, or commerce credentials.

## Data flow

```
Original commerce project
  products + verified NBA mappings
          |
          | worker reads athlete IDs only
          v
Dedicated NBA analytics project
  public Lineup Lab views + private athlete-profile batch RPC
          |
          | public-safe athlete stats only
          v
Original commerce project
  nba_product_slab_stats_cache -> public product stats RPC
```

Lineup Lab reads public, read-only NBA views directly from the dedicated
analytics project. The storefront product panel keeps using the original
commerce project's `get_nba_product_slab_stats` RPC. That RPC prefers a
validated local cache and falls back to the original scoped source query when
the cache is missing or no longer matches the verified mapping state.

## Initial copy and verification

The migration script copies the NBA-only table allowlist. It is insert/update
only on the target and never deletes either project. It verifies row counts and
canonical row hashes after the copy.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nba-analytics-transition.ps1 -Apply
```

Read-only target readiness:

```powershell
node .\scripts\check-nba-analytics-target.mjs --scope base
```

The PBP/RAPM scope is deliberately separate because its migrations and
ingestion pipeline are maintained independently from this base transition.

## Product-stats cache refresh

After an approved analytics data refresh, run the worker wrapper. It generates
a one-use worker trigger secret in process memory, invokes the server-side
worker, and requires a zero-mismatch shadow comparison against the retained
legacy source query.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-nba-product-slab-stats-cache.ps1 -Apply
```

Without `-Apply`, the wrapper is a dry run. The worker does not copy products,
assets, customers, orders, or payments. It writes only the compact public-safe
stats cache and its audit run record in the original commerce project.

## Deployment sequence

1. Apply reviewed analytics-project migrations.
2. Run the NBA-only copy and checksum verification.
3. Deploy the cache worker and configure its target-project secrets.
4. Run a zero-mismatch cache refresh.
5. Apply the cache cutover only after that validation succeeds.
6. Publish the static client configuration and cache-version bump.

The private batch/cache helper RPCs must retain explicit `anon` and
`authenticated` revocations. Only the established public product RPC and
public Lineup Lab read views are browser-accessible.
