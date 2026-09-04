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
| Football | `iuhjjwqfkohrrjqgpahh` | NFL identities, seasons, media metadata, import audit, stats, and source records | 311,405,715 bytes (297.0 MiB) |
| Retired combined warehouse | `rioxosivyhczxshhmaen` (deleted) | Former MLB/NFL source; permanently retired after verified parity and Commerce cutover | Not applicable |

## Verified split state

- Baseball: 13,672 athletes, 134,988 stat rows, 134,988 source records,
  154 completed import runs, and zero NFL memberships/stat/source rows.
- Football: 15,824 athletes, 149,050 stat rows, 151,690 source records,
  329 completed import runs, and zero MLB memberships/stat/source rows.
- Every copied table passed row-count parity and two independent deterministic
  content checksums against the former combined source before its retirement.
- After the parity checks, Commerce cache readback, and project-content audit,
  the combined warehouse was permanently deleted on September 2, 2026. Do not
  target or attempt to relink its former project ref.

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
  approved. If that changes, use the league-specific importer target guards
  before using `--apply`; never use the retired combined target.
- Refresh the Commerce cache with:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-pro-sports-product-slab-stats-cache.ps1 -Apply
  ```

## Health checks and controlled continuation

Run the compact, read-only health check before any new historical work:

```powershell
node .\scripts\audit-pro-sports-analytics-health.mjs --sport both --season-start 1980 --season-end 2026
```

It uses explicit Baseball and Football project refs, performs no provider
request or database write, and separates true historical gaps from an
in-progress current season. The local `DJHC Pro Sports Analytics Health` Task
Scheduler task invokes `scripts/run-pro-sports-analytics-health.ps1` daily at
6:30 AM and records only a compact local report under
`outputs/sports-reference-history/health/`. It does not use Codex automation,
fetch Sports Reference, or apply imports.

The 2026-09-04 baseline is healthy for MLB (94/94 required groups from
1980–2026) and complete for NFL through 2025 (322/322 required groups). The
seven NFL 2026 groups are current-season pending, not historical gaps.

When a health report identifies a genuinely approved backfill, use
`scripts/run-pro-sports-history-backfill-resumable.ps1` only with both
`-Apply` and `-AllowSourceAccess`. The runner has a per-range mutex, validates
the expected checkpoint group count before calling a range complete, preserves
separate MLB checkpoint ranges, and supports a single `-StatGroup` repair.
It must never be scheduled as an unattended import worker without separate
source and database-write approval.
