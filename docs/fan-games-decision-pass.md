# Fan games: decision flow and Game Studio pass

September 7, 2026. Implementation record; release verification is separate.

## Player-facing changes

- **Fix the Five:** each round names the objective and legal role minimums.
  Preview a candidate, compare optional public source statistics against the
  outgoing player, then explicitly confirm the swap. The reveal explains which
  player changed and which four stayed fixed. Ranking among replacements is
  not described as an improvement over the outgoing player, whose score is not
  part of that public comparison.
- **Draft Night:** preview and confirm each pick; the checklist shows filled
  and remaining board slots. Candidate comparisons remain optional. The final
  debrief explains the objective and role constraints. A valid one-pick
  alternative supplied by the service can be tried directly, preserving four
  players and requesting a fresh reveal. Missing alternatives are not treated
  as proof that no better alternative exists.
- **Lineup DNA:** the one-change tool states the current objective and what
  remains fixed. Its exact-swap report separates production differences, changed
  role-coverage categories, remaining concerns, and optional interpretation.
  Both groups use the same reference pool and conservative sample policy for
  descriptive roles. The what-if report does not apply the substitution.

## Game Studio application

Used the plugin's shared architecture, game UI, and browser playtest workflows.
The player fantasy is a coach or general manager making a bounded basketball
decision. The core loop is inspect → preview → commit → reveal → compare/retry.
There is no timer, speed reward, new randomness, or progression currency.

The existing static DOM/JavaScript stack is retained: these are text-heavy
roster decisions, not sprite, camera, or WebGL games. No engine, package,
generated asset, analytics collector, account persistence, or external service
was added. Existing collector branding and ongoing visual work were preserved.

`tools/game-decision-model.js` owns pure public-stat checks, disclosed board
rules, draft-slot accounting, and validation of supplied one-pick suggestions.
`tools/game-decision-ui.js` renders those descriptions through semantic HTML.
Neither module calculates a Scout rank. Previews stay in memory; only committed
selections use the existing browser-local game records.

UI priorities are one obvious confirmation action, reversible preview, visible
selection state, keyboard focus recovery, touch targets, and optional rather
than always-expanded comparisons. The same controls work in both themes.

## Findings and fixes

1. **Incorrect DNA signature ordering:** two existing DNA tests failed before
   this change because the first confirmed role in definition order was shown
   as the signature. Confirmed strengths are now ordered by their strongest
   supported signal. This changes descriptive ordering, not optimizer scoring.
2. **Missing public stats could display as zero:** both daily-game pages coerced
   null/empty values with `Number()`. The shared reader now accepts only finite,
   nonnegative numeric source values and keeps missing values unavailable.
3. **Immediate commitment:** a candidate click previously submitted immediately.
   Previews now require a separate confirm action. Cancel returns focus to the
   selected candidate and makes no reveal request.
4. **Unusable light-theme cancel contrast:** screenshot review caught inherited
   white-on-light button styling. Scoped colors now preserve visible primary
   and secondary actions without changing shared storefront buttons.
5. **Dense DNA explanation:** the initial expanded paragraph was hard to scan
   on mobile. The result now leads with the changed player and consequences;
   longer qualifications remain in an expandable method section.

## Verification

Commands used from the repository root:

```powershell
node --test scripts/tests/game-decision-model.test.mjs scripts/tests/lineup-dna.test.mjs scripts/tests/scout-daily-game-client.test.mjs scripts/tests/scout-daily-games.test.mjs
node --test prototypes/basketball-lineup-optimizer/tests/fan-analytics.test.mjs prototypes/basketball-lineup-optimizer/tests/lineup-role-model.test.mjs prototypes/basketball-lineup-optimizer/tests/workflow-state.test.mjs
$env:NODE_PATH = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node scripts/fan-games-design-smoke.mjs
node scripts/lineup-workflow-smoke.mjs --release
node scripts/site-integrity-check.mjs
node scripts/build-lineup-lab-release.mjs --check
git diff --check
```

The focused suites cover 37 passing tests, including unchanged deterministic
Scout ranking, null preservation, fixed draft roles, scoped alternatives, role
explanations, and workflow persistence. The daily-game browser suite uses only
synthetic boards, blocks external requests, and checks 390/900/1440px in both
themes. It exercises preview without reveal, keyboard and touch input, cancel,
source comparison, confirm, undo, replay, one-pick exploration, failed reveals,
and unavailable-board recovery. DNA's browser check uses the explicit local
historical course fixture, not a current Scout-production claim.

Screenshots stay in ignored `outputs/fan-games-design/` and
`outputs/lineup-workflow/`. The generated Lineup Lab release was synchronized
with the source prototype and checked for parity. No catalog generation or
source-package regeneration was performed.

## Remaining gates

No private model inputs, scoring coefficients, or new answer keys enter the
browser. No backend compiler, schema, or permissions were changed. Live Scout
availability was not checked by these offline tests, and the site still must
fail closed if the validated game service is unavailable.

The authorized static release uses cache revision `20260907b` and the exact
48-path list in `scripts/cpanel-game-decisions-20260907b-release.txt`. Upload
an immutable committed snapshot in three phases: assets, HTML, then service
worker. Verify live bytes against that snapshot. No deletes, catalog uploads,
Supabase writes, or global deployment-state changes are part of this release.
Unfinished Scout Studio and analytics changes stay out. Its existing HTML has
only a cache-version change in Git to keep the repository's version contract
consistent; the Scout Studio route is not in the upload list.
