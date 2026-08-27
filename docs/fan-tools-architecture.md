# Fan Tools Architecture

The `/tools/` page is the discovery surface for sports-fan tools and collector
games. It is intentionally separate from the storefront catalog and from the
Lineup Lab source harness.

## Registry contract

`tools/registry.js` is the metadata source for the hub. Every entry must have:

- a stable `id` that does not change when the display name changes;
- `kind` (`tool` or `game`);
- `status` (`live`, `planned`, or `research`);
- a plain-language `summary`;
- a non-empty `capabilities` list;
- a non-empty `dependencies` list; and
- an `implementationNotes` boundary.

Only live entries may have an `href`. Planned and research-gated entries remain
non-links until their data, tests, and release path are ready.

## Implementation boundary

Each new experience should live in its own folder and have a browser entry point
that can be loaded without initializing unrelated storefront modules.

- Use `core.js` for shared theme, accessibility, and local-state helpers.
- Use `supabase-client.js` for approved browser reads; do not create a second
  commerce client inside a game.
- Treat analytics reads as read-only and source-labeled. Raw provider payloads,
  credentials, and private tables never belong in browser code.
- Keep scenario, challenge, and collection state local-first unless a separate
  persistence request is approved.
- Never let a game mutate catalog quantity, sale state, pricing, checkout, or
  Shopify state.

## Promotion checklist

Before changing a registry entry to `live`:

1. Add the tool folder, page entry point, and focused tests.
2. Document data sources, uncertainty, and fallback behavior.
3. Run JavaScript syntax checks, focused tests, `site-integrity-check.mjs`, and
   `git diff --check`.
4. Add only the reviewed tool paths to a cPanel path-list release.
5. Recheck byte parity after deployment; a local page is not a live release.

The hub itself remains `noindex` until more than the initial Lineup Lab is live.
That keeps the roadmap discoverable to visitors without presenting planned
features as finished products in search results.
