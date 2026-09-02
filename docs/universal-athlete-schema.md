# Universal Athlete Schema

## Boundary

The universal layer owns identity and product relationships. It does not try
to make basketball, baseball, and football statistics look alike.

- `sports` defines a sport, beginning with `basketball`.
- `sports_leagues` defines a league within a sport, beginning with `NBA`.
- `athletes` is the durable human identity. A normalized name is indexed but
  never unique because two athletes can share a name.
- `athlete_league_memberships` verifies that an athlete belongs to a league
  context before an alias, external ID, or product can use that context.
- `athlete_aliases` stores reviewed, league-scoped names. Aliases can be
  ambiguous across athletes; resolution must therefore count distinct athlete
  IDs instead of choosing the first row.
- `athlete_external_ids` stores provider IDs without making a provider the
  canonical identity.
- `product_athlete_mappings` is an audited many-to-many bridge from catalog
  products to athletes. It preserves subject order, season context, match
  method, confidence, review state, and evidence.

The existing `nba_players` record is the NBA profile. Its `athlete_id` points
to the universal identity, while height, position, team seasons, and NBA stats
remain in the NBA domain. Baseball and football should receive equivalent
league-profile/stat domains rather than adding sport-specific columns to
`athletes`.

## Identity rules

1. Never use a display name as a primary key.
2. Normalize only case and whitespace automatically. Punctuation, suffixes,
   and qualifiers remain meaningful until reviewed.
3. Never fuzzy-match directly into a shopper-visible mapping.
4. A verified alias can resolve automatically only when it identifies exactly
   one active athlete in the selected league.
5. A multi-subject product is published only when every subject resolves to a
   different athlete. Partial panels are withheld.
6. Provider IDs are evidence, not identity. A provider ID can change without
   changing the athlete UUID.
7. Universal identity merges require an explicit reviewed operation; they are
   not inferred from matching names.

## NBA product mapping

`player_athlete` remains source evidence in the catalog. The mapper splits only
on the established pipe delimiter, preserves order, and resolves each token
against verified NBA aliases. Adjacent title prefixes such as `2003-04` can set
the depicted NBA season. Broad ranges such as `2020-2025` remain unresolved.

The migration performs the initial conservative backfill. For later catalog
additions, audit with:

```powershell
node .\scripts\build-nba-product-player-mappings.mjs --report=outputs/nba-product-mapping-audit.json
```

The audit requires `SUPABASE_SERVICE_ROLE_KEY` because aliases, evidence, and
review state are intentionally private. Apply mode is insert-only, skips every
product that already has any mapping row, writes a backup, never deletes, and
requires both explicit gates:

```powershell
$env:NBA_PRODUCT_MAPPING_ALLOW_WRITE='confirmed'
node .\scripts\build-nba-product-player-mappings.mjs --apply --confirm=insert-only-reviewed-nba-mappings
```

For a credential-free review of current catalog coverage against the latest
local verified mapping backup, run:

```powershell
node .\scripts\audit-nba-product-mapping-coverage.mjs
```

This produces a review-only queue. It may identify a high-confidence candidate
only when every pipe-delimited subject has the same exact source name as prior
verified mappings and those mappings resolve consistently to one distinct
athlete per subject. The queue is evidence for review; it never writes to
Supabase and never promotes title similarity into a shopper-visible mapping.

Because a local backup can lag the live catalog, validate exact expansion
candidates against the public buyer-safe RPC before treating them as new rows:

```powershell
node .\scripts\audit-public-nba-product-mapping-status.mjs
```

This read-only check records only public mapping identity, subject order, and
review state. Use `--all` to audit every row in the coverage queue. A product
already returned as `mapped` must not be proposed as an insert from a stale
snapshot.

To compare the remaining live-empty queue with the public NBA analytics player
identity pool, run the read-only candidate audit:

```powershell
node .\scripts\audit-nba-analytics-identity-candidates.mjs
```

It requires ten or more live mapped products to prove that analytics
`player_id` values and commerce athlete IDs share the same namespace. Exact
accent/punctuation folds are review candidates; suffix and one-character name
differences are suggestion-only. Neither class is automatically written.

After reviewing the identity queue, generate the deduplicated alias-and-mapping
proposal with:

```powershell
node .\scripts\build-nba-product-mapping-review-proposal.mjs
```

The proposal is not a database payload. It keeps aliases in `needs_review` and
lists the mandatory private preflight checks for athlete status, NBA
membership, alias uniqueness, product eligibility, and existing mapping rows.

With a service-role key injected in the process environment, run those checks
without writing:

```powershell
node .\scripts\audit-nba-product-mapping-private-preflight.mjs
```

The output separates products ready for alias review, ready for mapping review,
and blocked by drift or conflicting state. It never inserts aliases or mappings.

## Slab-to-Stats API

Shopper code cannot select the mapping tables. It calls
`get_nba_product_slab_stats(product_id)`, which returns only:

- a verified visible product ID;
- universal and NBA player IDs;
- public NBA profile fields;
- rights-confirmed primary headshots;
- depicted-season context;
- regular-season/playoff totals and selected advanced metrics.

The RPC withholds sold, hidden, archived, deleted, unverified, disputed, and
unmapped records. Team stints are aggregated without double-counting provider
aggregate rows. Additive metrics are summed; rate metrics are minutes-weighted
unless the provider supplied one aggregate value.

The storefront loads this data only after an NBA product modal opens. Catalog
cards and initial catalog rendering do not load player stats.

## MLB/NFL Slab-to-Stats

MLB and NFL now follow the same shopper boundary as NBA without exposing the
warehouse or mapping bridge directly:

1. The isolated pro-sports analytics project accepts requested verified athlete
   IDs through `get_pro_sports_athlete_slab_stats_batch(league_code,
   athlete_ids)`. Only its service role can execute that function. It returns
   normalized season summaries and rights-confirmed headshots, never provider
   provenance, external IDs, commerce products, or customer data.
2. The Commerce project cache
   `pro_sports_product_slab_stats_cache` holds the compact, validated payload
   for visible MLB/NFL listings. Direct table access is revoked from browsers.
3. `get_pro_sports_product_slab_stats(product_id)` is the shopper-facing RPC.
   It returns a cache row only while the product remains visible and its active,
   verified athlete mapping still exactly matches the cached athlete IDs.
4. `sync-pro-sports-product-slab-stats-cache` is the service-role Edge worker.
   It reads only reviewed mappings, validates the isolated project identity,
   upserts the cache, verifies every stored hash, and intentionally leaves
   stale rows intact for review; the public RPC fails closed on those rows.
5. `pro-sports-slab-stats.mjs` loads only after an eligible MLB or NFL product
   modal opens. It uses the same visual panel contract as NBA while selecting
   a position-appropriate stat group when a card season has multiple summaries.

Run the guarded refresh wrapper after an approved MLB/NFL mapping or source
update:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-pro-sports-product-slab-stats-cache.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync-pro-sports-product-slab-stats-cache.ps1 -Apply
```

The first command is a dry run. The apply command changes only the dedicated
Commerce cache and its server-side audit rows; it does not edit products,
workbooks, inventory, prices, sales state, or identity mappings.

### MLB/NFL catalog identity expansion

`scripts/audit-pro-sports-product-mapping-coverage.mjs` performs the first
review-gated expansion step for MLB and NFL. It reads `products.json` and the
already-authorized local Baseball Reference / Pro Football Reference caches,
then resolves catalog subjects against stable provider player IDs. The report
separates exact unique provider matches, punctuation/diacritic-only review
candidates, duplicate-name ambiguity, team conflicts, unseen names, and
intentional team-lot blanks. Multi-player products resolve all subjects in
order or remain unpublished.

The report is proposal-only. A provider external ID is not treated as a
commerce-project `athlete_id`; publication still requires a private cross-
project identity preflight, verified league membership and aliases, and an
explicit database write gate. The audit does not edit workbooks, catalog
artifacts, Supabase, or storefront files.

`scripts/build-pro-sports-product-mapping-review-proposal.mjs` packages only
the unique exact, career-window-disambiguated, and punctuation/diacritic-only
matches into a hashed review proposal. Then
`scripts/audit-pro-sports-product-mapping-private-preflight.mjs` uses the two
already-linked Supabase projects for read-only checks: analytics provider-ID
resolution, active/verified athlete identity, current commerce product values,
league readiness, alias conflicts, and existing mappings. It emits no insert,
update, delete, migration, or deploy payload.
