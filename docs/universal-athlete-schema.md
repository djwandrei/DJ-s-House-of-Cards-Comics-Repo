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

## Adding MLB or NFL later

1. Add the sport/league row.
2. Add a league profile table with a unique `athlete_id` reference.
3. Import provider IDs, then create verified league aliases.
4. Reuse `product_athlete_mappings`; do not create another product bridge.
5. Add a league-specific stats schema and fixed-shape public RPC.
6. Add a storefront provider adapter that normalizes that RPC into the shared
   panel contract.
7. Run identity, mapping, rights, aggregation, accessibility, and responsive
   regression tests before publishing mappings.
