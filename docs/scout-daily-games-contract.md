# Scout Daily Games contract

`Fix the Five` and `Draft Night` are being moved from a bundled 2021–22
Minnesota box-score game to a Scout-driven daily-game system. This contract
keeps the advanced model private while making the game result reproducible and
useful to a public visitor.

## Source window and readiness

The allowed source window is 2023–24 through 2025–26 (season ending years
2024, 2025, and 2026). A season is never selectable merely because a source
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

Historical box-score and role signals can still explain a Lineup DNA result,
but they cannot alter the Scout rank. A game's 0–100 score is a normalized
relative score within its fixed disclosed board; rank remains the primary
comparison when source values are tied or negative.

## Current gate

The 2023–24 archive is not eligible until its active source and validation
work completes. The daily catalog must fail closed for it rather than silently
substitute a box-score score or a different season.
