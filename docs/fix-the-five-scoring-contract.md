# Fix the Five scoring contract

`Fix the Five` is a five-round historical lineup decision game. It asks a
visitor to replace one named player in a fixed five from a published,
reviewed player pool. It does not simulate a past game, forecast a future
result, or rate the real-world value of a player.

## Release boundary

- Every release contains at least ten versioned challenge fixtures.
- Each fixture uses one named historical team-season snapshot and a stable
  source URL.
- A fixture contains five distinct starting-player IDs, one removed-player ID,
  at least three distinct candidate IDs, objective weights, source-listed
  position requirements, and one reviewed `answerId`.
- All listed player IDs must resolve inside the published source roster.
- A candidate is eligible only when it keeps the five distinct and satisfies
  the fixture's G/F/C requirements. Multi-position players may fill one
  required court slot, not several at once.
- Tests re-evaluate every fixture. A release fails when an answer ID, court
  shape, source row, or schema version is no longer valid.

## Source-bounded Lineup DNA

The game derives seven coverage signals from the roster's visible historical
per-game values, expressed per 36 minutes where appropriate:

| Signal | Inputs | Boundary |
| --- | --- | --- |
| Lead playmaker | assists, points, ball security | Box-score role signal |
| Floor spacer | three-point percentage, effective field-goal percentage, points | Accuracy and volume proxy; not movement tracking |
| Low-turnover connector | assists, ball security | Box-score role signal |
| Efficient finisher | effective field-goal percentage, points, rebounds | Box-score role signal |
| Ball-pressure proxy | steals, ball security | Not a matchup or full defensive assignment |
| Rim protector | blocks, rebounds | Box-score role signal |
| Rebounder | rebounds | Box-score role signal |

The two strongest selected players for each signal provide coverage with a
diminishing second-player contribution. The game shows the change from the
starting five to the selected replacement, labels proxy evidence plainly, and
does not present it as observed on-court lineup performance.

## Candidate ranking and round score

For every legal candidate, the game calculates:

1. A direct objective score from the fixture's published weights across
   scoring, efficiency, spacing, rebounding, creation, steals, blocks, and
   ball security. Values are percentile-ranked inside the reviewed roster only.
2. A Lineup DNA fit index that weights the seven role-coverage signals by the
   same objective.
3. A transparent composite: 62% direct objective score and 38% DNA fit index.

The best legal published candidate has a round score of 100. Every other
candidate receives its composite as a percentage of that reference. This means
the score reports distance from the best answer on the fixed board. DNA
coverage is part of the composite, and the result separately displays the
before/after role change. It never reports a projected win total, odds, or a
claim that a chosen five actually played together.

## Run, streak, and sharing contract

- A daily run uses the Chicago calendar date (`America/Chicago`) as its seed.
- The seed deterministically selects five distinct fixtures from the released
  bank. A shared seed always recreates the same five fixture IDs and order for
  the same release.
- Progress, completed daily seeds, best score, and streak are stored only in
  the visitor's browser under a versioned local-storage key.
- A share URL includes the non-sensitive seed and a completed score summary;
  it never includes account information, inventory state, private analytics,
  or a claim that a result was server-verified.
- Restarting a run is local and reversible. There are no global leaderboards,
  prizes, purchases, or account requirements.

## Challenge schema

```js
{
  schemaVersion: 1,
  id: 'min-2022-space-the-wing',
  reviewStatus: 'reviewed',
  source: {
    team: 'MIN', season: 2022, phase: 'regular',
    label: 'Minnesota 2021–22 historical snapshot', url: '...'
  },
  title: 'Open the wing',
  brief: '...',
  focus: '...',
  lineupIds: ['...', '...', '...', '...', '...'],
  removeId: '...',
  candidateIds: ['...', '...', '...'],
  objectiveWeights: { points: 18, efgPct: 12, /* ... */ },
  positionMinimums: { G: 2, F: 2, C: 1 },
  answerId: '...',
  reviewNote: '...'
}
```

Changes to an existing challenge's roster, choices, answer, source, or
scoring version require a new fixture ID or release-bank version so saved and
shared runs remain explainable.
