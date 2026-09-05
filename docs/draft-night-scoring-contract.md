# Draft Night scoring contract

`Draft Night` is a five-pick historical lineup game. A visitor makes one pick
from each disclosed role group on a fixed, reviewed player board. It does not
recreate a real game, forecast a future result, or claim that a drafted five
played together.

## Release boundary

- Every release contains at least eight versioned, curated, test-validated
  decks, and visitors can choose any published deck for local practice.
- Every deck names one historical team-season snapshot and stable source URL.
- A deck has exactly five rounds with at least three disclosed candidates in
  each round. A player cannot appear in more than one round.
- Each five-player path must satisfy the deck's published G/F/C court shape.
- The release validates all 243 combinations in each current 3×3×3×3×3 deck.
  A deck cannot ship if an ID, source row, position assignment, or schema
  version is invalid.
- `reviewStatus: "reviewed"` means the deck was curated for this release and
  passed the published automated validation. It does not claim independent
  scout, historian, or real-game review.
- A daily Chicago-date seed selects one reviewed deck. A shared URL includes
  the non-sensitive seed and self-reported score only; it does not reveal
  account data, private analytics, inventory, or server-verified results.

## Historical role model and score

The game derives the same seven source-bounded coverage signals used by `Fix
the Five`: lead playmaking, floor spacing, low-turnover connection, efficient
finishing, a steals-and-ball-security ball-pressure proxy, rim protection,
and rebounding. Source-visible per-game values are converted to per-36 values
where appropriate. Before roster-relative percentiles are calculated,
low-minute source rates are conservatively shrunk toward that roster's
minute-weighted center using a published 360-source-minute prior; this limits
a tiny source sample without claiming a projection or inventing missing
events.

For every legal five, the game calculates a direct objective score from the
deck's declared historical weights and a Lineup DNA fit index. The published
composite is 62% direct objective score plus 38% DNA fit. The strongest legal
combination on that exact deck scores 100. Every other score is its composite
as a percentage of that reference. After the reveal, the game may show nearby
one-pick published alternatives for learning; these are still board-bound
comparisons, never real-game recommendations.

That ranking is a transparent comparison of the disclosed board. Ball
pressure is only a box-score proxy; no result establishes a matchup,
movement-shooting ability, team defensive result, actual lineup outcome, or
future win projection.

## Local play

Draft choices and local high scores stay under a versioned browser-storage
key. Restarting, undoing a pick (including the final pick), replaying the same
board, and selecting another published practice objective are local and
reversible. There is no account requirement, leaderboard, prize, purchase,
or backend write. The current release uses scoring version `draft-night-v2`.
