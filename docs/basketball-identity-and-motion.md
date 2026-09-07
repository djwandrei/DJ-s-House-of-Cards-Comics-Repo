# Basketball identity and interaction pass

Approved fan-suite release candidate `20260907c`, implemented in the canonical
checkout. The reviewed release list covers the public fan pages, generated Lab,
new artwork/fonts, and shared cache-version references. It excludes the separate
unfinished Scout Studio work and performs no deletes. Release verification is
recorded under `outputs/fan-suite/` and reported with the actual Git commit.

The release-specific read-only fallback auditor is
`scripts/audit-fan-suite-release.mjs` (the generic auditor named in the deploy
guide is absent). Its `--committed` mode checks every release file against HEAD;
`--live` compares all 81 public file hashes. The FTPS helper sorts its inputs,
so deploy the reviewed list in three no-delete path-list phases: non-HTML assets,
then HTML pages, then `sw.js`. No source-only Scout preview is uploaded.

## Approved suite implementation

- Manrope 400/700 and Barlow Condensed 700 are self-hosted, with both OFL licenses.
- `tools/basketball-theme.css` is the final shared presentation contract;
  `lab-theme.css` adapts the Lab controls to it. Heading ink is a semantic token
  rather than a hard-coded navy value that disappears on dark surfaces.
- The common destination strip identifies the current page. Court style gives
  direct Dark/Light controls, including on mobile; it shares the site's saved
  preference. First visits open dark.
- `tools/basketball-palettes.js` provides 30 independent team-inspired schemes
  plus DJHC. The real Lab selector drives appearance; BRK/CHO/PHO aliases map
  explicitly. Unsupported historical teams, CSV/demo rosters and pages without
  a team selection keep DJHC. No palette writes to the roster or optimizer.
- The guided Lab advances with a 240ms directional slide/fade and reverses on
  Back. Inactive panels are hidden/inert; focus, state and validation settle
  synchronously. Reduced motion and backgrounding cancel the visual cue.
- Basketball artwork, original game emblems, concise card-search copy, native
  dropdowns, visible focus, disclosure/reveal transitions and finite badge
  interactions extend to the public fan-tool family.
- Existing game/source gates, scoring, exact solver, prices and catalog data
  remain unchanged. Workshop pages remain explicitly unfinished frameworks.

The five sibling Superdesign drafts used 210 credits. Their source canvas is
[DJHC Lineup Lab Model and UX Upgrade](https://superdesign.dev/teams/1d9cd047-15e5-468a-b2b3-5be0e0fce5c9/projects/44964533-087f-4f20-88d3-0e2895ff8d6e).
The Lab transition preview is version 12; the refetched HTML matches the tested
local preview. Canvas layouts are design references, not backend readiness proof.

## Visual direction

Preserve DJ's company logo and the navy, gold, red/blue collector identity.
Use individual basketball emblems as game marks, not replacements for the shop
brand. Finished emblems use intentional navy tiles with rounded corners.

- Fix the Five: basketball, five court positions, and a substitution arrow.
- Draft Night: basketball, five draft cards, and a draft-star crest.
- Lineup Lab: basketball, a five-player play diagram, and laboratory details.

The built-in image-generation tool produced the original illustrations. The
brief specified bold collector/varsity badges, limited navy/cream/gold/orange
colors, readable small-scale silhouettes, and no text or third-party marks.
The first transparency attempts returned opaque backgrounds; final artwork
was regenerated with deliberate solid navy backgrounds. No fake checkerboard
is shipped. Sharp only resized/encoded the finished artwork.

## Assets

Each experience has a 256px WebP emblem and a 32px PNG tab icon under
`assets/games/`, named `{experience}-emblem-20260907.webp` and
`{experience}-icon-20260907.png`. All six files total approximately 57 KB.
Full-size generated master copies are retained in the main checkout under
`outputs/imagegen-basketball-20260907/` (local, ignored output).

The existing `assets/basketball-footer.webp` / `.jpg` is reused without changes:
the shared fan-tool footer uses its existing image token and responsive sizing,
and the standalone Lab has a responsive lazy-loaded picture. The hub hero now
uses the existing basketball hero image instead of grass.

## Behavior

- Distinct hero badges, hub-card marks, tab icons, and a six-destination active-page
  switcher. Current links use `aria-current="page"`.
- Keyboard/touch badge bounce, short candidate-card deals, preview/result
  entrances, active-step check-in, and hover/press feedback. No sound, flashing,
  automatic celebration, parallax, delayed controls, or scoring changes.
- Reduced-motion preference suppresses decorative motion; changing it while a
  badge is bouncing cancels the animation. Background tabs also stop the bounce.
- Lineup Lab gets its own emblem, result-card entrances, highlighted journey
  steps, and a basketball treatment on the existing solver busy indicator.
- Optional Coach's prompt cards cycle Balanced, Defense, and Offense practice
  ideas. Browsing changes no settings. Applying clicks the existing preset
  button, preserving the app's weight handling, invalidation, and saved draft
  behavior. It never changes roster/rules or starts a solve.
- The mobile Lab plan selectors use the full column for readable labels.

## Ownership and synchronization

`tools/basketball-branding.css` and `.js` own the shared game presentation and
optional badge interaction. `tools/fan-tools.css`, `.js`, and `registry.js`
own hub marks and basketball imagery. Registry consumers use the current cache
revision, including workshop imports; no workshop logic changed.

Edit Lab in `prototypes/basketball-lineup-optimizer/`. New `lab-experience.css`
and `.js` are registered in the existing release builder. The generated
`lineup-lab/` copy is synchronized, not separately authored.

## Verification

- `node scripts/basketball-branding-smoke.mjs`: 27 offline viewport/theme checks,
  no overflow, asset loading, badge keyboard/touch input, live reduced-motion
  changes, active-page links, footer artwork, and prompt state boundaries.
- `node scripts/fan-games-design-smoke.mjs`: full synthetic game runs at
  390/900/1440px in light/dark, preview/confirm, undo, retry, restart, and failure.
- `node scripts/lineup-workflow-smoke.mjs --release`: exact build, guided steps,
  draft restoration, constraints, cancellation, Lineup DNA, and mobile flow.
- Registry and game-decision unit tests; site integrity; structured-data audit;
  JavaScript syntax; release builder parity; and whitespace/diff review.
- Rendered screenshot evidence: `outputs/basketball-branding/`,
  `outputs/fan-games-design/`, and `outputs/lineup-workflow/`.

Synthetic boards are test-only. This pass does not change whether production
Scout sources are ready, deploy backend functions, expose private values, or
claim that an unavailable daily game is playable.

## Historical preview evidence (before implementation approval)

The following records describe the earlier preview stage. That direction was
subsequently approved and implemented above; these historical checks do not
substitute for the release-candidate browser tests.

`.superdesign/basketball-palettes.mjs` defines Collector Court (DJHC) plus 30
original named team-inspired schemes and explicit dark/light semantic tokens.
The reference snapshot is [NBA Colors](https://nbacolors.com/), retrieved
September 7, 2026. These are independent DJHC UI interpretations, not certified
current official team color specifications. Atlanta, LA Clippers, and Utah use
separately documented newer identity directions; reference inconsistencies are
not copied silently. Exact seeds and adjusted UI-role shades stay distinct.

`node --test .superdesign/basketball-palettes.test.mjs` verifies the 31 entries,
62 theme combinations, role contrast targets, hex validity, and seed immutability.
Team selection now drives the corresponding palette automatically, without a
separate color-team picker. Appearance changes never write back to team/season
data or scores. The preview opens in Minnesota's dark scheme, retains light/dark
through team changes, and uses DJHC when no supported team is selected. Reset
display restores dark without changing the team. The demo selector updates
illustrative team context only; no source data is loaded and no solve runs.
This must remain a review artifact until the user approves applying it.

[Interactive theme preview](https://p.superdesign.dev/draft/f3c9e5e0-7347-4cdb-ad87-0a47c28d3484),
version 8, is saved on the existing Lab canvas. The first browser matrix passed
248 combinations (31 schemes, two modes, four widths). After the final decorative
stripe, rail-contrast, and placeholder fixes, the refetched version passed another
24 representative combinations and the interaction checks. All three font faces
and both emblems loaded; search/reset, independent plan state, Simple/Detailed,
rotation-size choices, keyboard focus, reduced motion, and no-overflow checks
passed. Screenshots and the latest report are in `outputs/team-color-preview/`.

Version 9 links colors directly to the team selector. All 30 teams were checked
in both modes, plus eight responsive combinations (320/390/900/1440px), for 68
browser cases. Team switches retained the chosen mode, strategy, build type,
and rotation size; display reset retained the selected team; no-team fallback
used DJHC. Keyboard selection and the journey Edit link worked. Screenshots
and report: `outputs/auto-team-preview/`. This is still a preview, not a live
team-data integration or deployment.
