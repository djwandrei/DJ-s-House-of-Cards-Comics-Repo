# Scout Daily Games contract

`Fix the Five` and `Draft Night` are being moved from a bundled 2021–22
Minnesota box-score game to a Scout-driven daily-game system. This contract
keeps the advanced model private while making the game result reproducible and
useful to a public visitor.

## Source window and readiness

The allowed source window is 2017–18 through 2025–26 (season ending years
2018 through 2026). A season is never selectable merely because a source
folder exists. It must have a ready archive and a validated O/D Scout model
whose held-out calibration reports both components improved.

The compiler treats three source families differently:

- **Team season** uses one franchise's roster from one validated season.
- **Franchise window** uses one franchise across two or more seasons, and
  requires one validated combined Scout model covering every included season.
- **Multi-season pool** mixes eligible player identities across multiple
  seasons and franchises, and uses the same combined-model requirement.

Cross-season challenges cannot combine scores from separate single-season
models. That would make a rank look comparable when it is not.

## Daily board and privacy boundary

The server compiles a deterministic board from the Chicago calendar date,
game kind, validated model scope, and catalog version. The public board may
contain player names, positions, public historical context, source labels,
and the selected Scout objective. It may not contain player O/D RAPM values,
model coefficients, raw impact totals, archive paths, provider identifiers,
or credentials.

The server stores only the sealed outcome map needed to reveal a choice's
rank, 0–100 board score, and limited one-pick learning after a selection.
The result is a Scout-board comparison, not a forecast, a simulated game, or
a claim that a historical five actually played together.

## Scoring

The Scout O/D model is the whole ranking objective:

- **Offensive edge** ranks the model's offensive component.
- **Defensive edge** ranks the positive points-prevented component.
- **Two-way balance** weights those components equally.

Historical box-score and role signals are descriptive context only. Lineup
DNA is not a scoring input for either daily game. A game's 0–100 score is a
normalized relative score within its fixed disclosed board; rank remains the
primary comparison when source values are tied or negative.

## Implementation and activation

The private catalog lives in the analytics Supabase project. Its scope and
player tables have no Data API access, and the only private-read RPC is
service-role-only. The commerce `scout-daily-game` Edge Function calls that
RPC, compiles the board server-side, and returns either a public board or one
sealed outcome for a legal selection. The browser may never call the analytics
project directly.

Activation order is intentionally gated:

1. Apply the catalog migration followed by the forward 2017–26 window
   migration (`20260909120000_expand_scout_daily_game_window_2017_26.sql`) to
   the analytics project.
2. Have the analytics pipeline register, ingest, reconcile, and finalize a
   scope only after its archive/source and O/D calibration reports pass.
3. Set the commerce function's analytics service credentials, deploy
   `scout-daily-game`, and confirm a public board/reveal smoke test.
4. Release the static game pages with their cache versions aligned.

Until all four steps have succeeded, the public game remains unavailable. It
must not fall back to bundled historical fixtures, a static Minnesota board,
or heuristic/Lineup DNA scoring.

## Current gate

The 2017–18 through 2025–26 rows remain individually subject to source and
calibration gates. The daily catalog must fail closed for a missing or
unvalidated season rather than silently substitute a box-score score or a
different season.
