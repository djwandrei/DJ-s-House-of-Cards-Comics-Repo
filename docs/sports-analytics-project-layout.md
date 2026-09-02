# Sports analytics project layout

The live analytics boundary is one Supabase organization/project per sport.
Commerce remains in the original project and stores only validated, compact
shopper-facing cache payloads. Advanced NBA Scout/PBP/RAPM work remains
deferred and is not part of the Basketball-Reference warehouse.

| Role | Project ref | Live contents | Verified database size |
| --- | --- | --- | ---: |
| Commerce | `gkqdymnmczabcggvigce` | Products, mappings, payments, and the public-safe stats cache | Separate; unchanged by the split |
| Basketball | `fbbmuqbdpgsmvnezowwn` | Basketball-Reference descriptive data | Separate; unchanged by the split |
| Baseball | `sptahazcjnorayjkltdx` | MLB identities, seasons, media metadata, import audit, stats, and source records | 349,441,171 bytes (333.3 MiB) |
| Football | `iuhjjwqfkohrrjqgpahh` | NFL identities, seasons, media metadata, import audit, stats, and source records | 311,372,947 bytes (296.9 MiB) |
| Recovery source | `rioxosivyhczxshhmaen` | Original combined MLB/NFL warehouse retained for rollback | 648,088,723 bytes (618.1 MiB) |

## Verified split state

- Baseball: 13,672 athletes, 134,988 stat rows, 134,988 source records,
  154 completed import runs, and zero NFL memberships/stat/source rows.
- Football: 15,824 athletes, 149,050 stat rows, 151,690 source records,
  329 completed import runs, and zero MLB memberships/stat/source rows.
- Every copied table passed row-count parity and two independent deterministic
  content checksums against the retained combined source.
- The combined source is a recovery asset. Do not delete, truncate, relink, or
  repurpose it until a separately approved retirement review.

## Storefront routing

`sync-pro-sports-product-slab-stats-cache` routes MLB requests to Baseball and
NFL requests to Football. Its service credentials are server-only Supabase
secrets. The Commerce cache records the source project ref per product and the
browser continues to use only `get_pro_sports_product_slab_stats(product_id)`.

The live cache readback after cutover is:

- MLB: 667 products, sourced from Baseball, zero mismatches, zero stale rows.
- NFL: 225 products, sourced from Football, zero mismatches, zero stale rows.

No cPanel file changes are required for this split because the existing
storefront RPC contract did not change.

## Operator rules

- Always pass an explicit `--project-ref` for schema or data work. The shared
  `supabase-sports-analytics` migration tree intentionally supports both
  league schemas, while each operational project contains only its league's
  data.
- The reviewed 20260902034101 identity repair applies only to Baseball. Its
  migration-history entry is intentionally marked applied without execution
  in Football.
- Historical MLB/NFL imports are frozen unless a new import is explicitly
  approved. If that changes, update the old combined-target importer guards
  before using `--apply`.
- Refresh the Commerce cache with:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-pro-sports-product-slab-stats-cache.ps1 -Apply
  ```
