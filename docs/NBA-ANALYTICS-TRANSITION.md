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
commerce project's `get_nba_product_slab_stats` RPC, but that RPC reads only
the validated local cache. It never reads full historical NBA facts from the
commerce project after decommissioning. A missing or invalidated cache entry
safely hides the optional stats panel; it never exposes stale mapping data or
falls back to a duplicate analytics table.

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

## Commerce-project analytics decommission

After a full source-to-target checksum verification and a zero-mismatch cache
refresh, the duplicate historical NBA facts can be removed from the commerce
project. The decommission migration has an in-transaction cache-coverage
preflight: every currently visible, verified NBA-mapped product must have a
current cache entry sourced from the dedicated analytics project.

The commerce project deliberately retains its mapping identity projection:

- `sports`, `sports_leagues`, `athletes`, and
  `athlete_league_memberships` preserve the foreign keys for
  `product_athlete_mappings`.
- `athlete_aliases` and `athlete_external_ids` remain as conservative
  identity/mapping evidence. They are small and are not historical NBA
  performance data.
- Products, media, mappings, customer/auth records, orders, offers, payments,
  and Storage are never included in the decommission scope.

The migration truncates only the duplicated NBA fact/profile tables and removes
the obsolete original Lineup Lab views plus legacy product-stat fallback RPC.
It preserves the empty table schemas so the exact verified data in the
dedicated analytics project remains a controlled recovery source if needed.

The original-to-target parity command is a pre-decommission evidence check,
not a recurring health check. Once the commerce facts are intentionally empty,
use `check-nba-analytics-target.mjs --scope base` to validate the dedicated
project; do not expect the historical source-to-target checksum to remain
equal.

After this point, run the cache-refresh worker after either of these events:

1. A verified NBA product mapping is added, changed, or removed.
2. The dedicated analytics project receives an approved NBA profile/stat refresh.

## Product-stats cache refresh

After an approved analytics data refresh or a verified NBA mapping change, run
the worker wrapper. It generates a one-use worker trigger secret in process
memory, invokes the server-side worker, reads the dedicated analytics project,
and verifies the compact rows persisted in commerce before reporting success.

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
