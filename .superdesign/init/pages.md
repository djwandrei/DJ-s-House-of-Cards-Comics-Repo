# Lineup Lab page dependency map

## Repository shape relevant to this target

- **Framework:** none. Lineup Lab is a static HTML page with browser-native ES modules, a Web Worker, and vanilla CSS.
- **Component library:** none. Repeated UI is expressed through semantic HTML, CSS classes, and DOM-rendering helpers in `app.js`.
- **Source target:** `prototypes/basketball-lineup-optimizer/`.
- **Production artifact:** `lineup-lab/` is generated from that source. It is deliberately excluded from this map so a design task uses the maintainable source files rather than generated copies.

## /lineup-lab/ (Lineup Lab)

**Source entry:** `prototypes/basketball-lineup-optimizer/index.html`

**Purpose:** An NBA historical team-season lineup and rotation optimizer. Visitors can load a team stint, define a game plan and hard constraints, run an exact background solve, inspect evidence and alternatives, compare players, save a local collector watchlist, export results, and print a scouting-style report.

**Dependency tree:**

```text
prototypes/basketball-lineup-optimizer/index.html
|- prototypes/basketball-lineup-optimizer/styles.css
|  |- ../../assets/fonts/inter-400.woff2
|  |- ../../assets/fonts/inter-700.woff2
|  `- ../../assets/fonts/bebas-neue-400.woff2
|- ../../assets/icons/favicon-32.png
|- ../../assets/dj-logo.png
|- ../../backend-config.js
|  `- shared browser configuration bootstrap used before the data adapter
|- ../../supabase-client.js
|  `- shared browser-side Supabase client exposed to Lineup Lab's data adapter
`- prototypes/basketball-lineup-optimizer/app.js
   |- optimizer-core.js
   |  `- presets, safe-search limits, exact lineup/rotation model utilities
   |- player-data.js
   |  `- CSV import/export plus browser-safe player and dataset normalization
   |- supabase-nba-data.js
   |  `- player-data.js
   |  `- team-season, team-stint, logo, headshot, and source-metadata adapter
   |- fan-analytics.js
   |  `- rate views, era context, player roles, role coverage, selection and replacement explanations
   |- scenario-url.js
   |  `- shareable scenario encoding and defensive decoding
   |- fixtures/timberwolves-2021-22.json
   |  `- stable course-demo fallback roster
   `- optimizer-worker.js
      `- optimizer-core.js
         `- runs the exact solve off the main thread
```

### Runtime-adjacent source, not a visual page dependency

```text
prototypes/basketball-lineup-optimizer/dev-server.mjs
`- nba-stats-api.js
   `- player-data.js
```

The dependency-free local server safely serves the prototype and provides a constrained legacy NBA Stats API proxy for local development. The deployed Lineup Lab itself reads the approved historical pool through the shared Supabase browser adapter; it does not scrape Basketball Reference in the browser.

### Page structure within the entry file

```text
index.html
|- .lab-header
|  `- compact DJ's Lineup Lab brand lockup and beta badge
|- .hero
|  |- explanation, primary action, model-help action, proof list
|  `- visual court-card scenario motif
|- #workspace
|  |- .tool-nav
|  |  `- Optimizer, Compare players, Collector watchlist, Data and model tabs
|  |- #liveDataPanel
|  |  `- historical team, season, and phase chooser
|  |- #datasetStrip
|  |  `- team mark, data provenance, roster metadata, CSV/demo actions
|  |- #optimizerView
|  |  |- game-plan preset cards and objective-weight controls
|  |  |- optional historical-opponent scouting details
|  |  |- player/rotation rules, source-aware minute controls, and active selections
|  |  |- sortable player pool table with must-include, exclude, compare, and watch actions
|  |  `- results panel: chosen group, minute plan, role coverage, evidence, alternatives, charts, exports
|  |- #compareView
|  |  `- selected-player bars and rate-view comparison table
|  |- #watchlistView
|  |  `- browser-local collector/player watchlist with optional card-search handoff
|  `- #modelView
|     `- source boundary, model contract, CSV tools, and limitations
`- .lab-footer
   `- storefront return link
```

### Shared shell relationship

Lineup Lab intentionally has an independent, minimal `.lab-header` and `.lab-footer`; it does **not** load the storefront's `core.js`, `nav.js`, shared `styles.css`, or shared mobile override. It does reuse DJ's logo, favicon, Inter/Bebas font files, and the shared backend/Supabase bootstrap. The broader storefront's reusable shell lives in root `index.html`, `styles.css`, `styles-mobile-overrides.css`, `core.js`, and `nav.js`; use it only when a future fan-tool needs full storefront navigation, cart/account behavior, theme handling, or the standard footer.

For Lineup Lab-specific design work, the candidate context set is the source `index.html`, `styles.css`, `app.js`, `optimizer-core.js`, `fan-analytics.js`, `player-data.js`, `supabase-nba-data.js`, `scenario-url.js`, and `optimizer-worker.js`. Add the fixture only when its demo-state content affects the draft.
