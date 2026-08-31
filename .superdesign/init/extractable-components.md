# Extractable Lineup Lab UI patterns

Lineup Lab is a static page, so the items below are design-level reusable patterns rather than prebuilt framework components. Each is grounded in repeated semantic markup, CSS, and/or DOM-rendering helpers already present in the source. Do not extract one-off explanatory copy or solver-specific evidence panels as generic components.

## LabHeader

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** layout
- **Description:** Compact dark product header with DJ logo, product name/subtitle, back-to-store link, and beta status.
- **Extractable props:** `homeHref` (string, default: `../../index.html`), `productName` (string), `productSubtitle` (string), `statusLabel` (string), `showStatus` (boolean, default: true)
- **Hardcoded:** DJ logo asset, navy header treatment, brand typography, component spacing, and default public-beta visual style.

## ToolTabBar

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** layout
- **Description:** Accessible tab navigation that switches data-tool workspaces and carries small dynamic counts.
- **Extractable props:** `activeTab` (string, default: `optimizer`), `items` (array of label/id/count), `onTabChange` (callback)
- **Hardcoded:** Tab-row structure, active underline/color treatment, keyboard/ARIA behavior, and the optimizer/compare/watchlist/model default labels.

## HistoricalDatasetPicker

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Three-field source selector for an NBA team, season, and season phase, paired with a clear load action and status message.
- **Extractable props:** `teamOptions` (array), `seasonOptions` (array), `phase` (string), `selectedTeam` (string), `selectedSeason` (number), `isLoading` (boolean), `statusMessage` (string), `onLoad` (callback)
- **Hardcoded:** Historical NBA wording, selected-team data labels, source-status color states, and the current regular/playoffs option labels.

## DatasetProvenanceStrip

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Compact current-data summary with a logo fallback, team/season/player counts, media availability, and data-management actions.
- **Extractable props:** `teamName` (string), `seasonLabel` (string), `teamLogoUrl` (string), `rosterCount` (number), `mediaSummary` (string), `actions` (array), `isPendingSelection` (boolean)
- **Hardcoded:** NBA fallback mark, diagnostic wording, metadata labels, source-card layout, and CSV/course-demo action labels.

## StrategyPresetGrid

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Selectable strategy cards that make high-level intent understandable before exposing detailed weighting controls.
- **Extractable props:** `presets` (array of title/description/id), `activePreset` (string), `onPresetChange` (callback), `disabled` (boolean)
- **Hardcoded:** The current five NBA strategy labels, two-line card anatomy, selected blue surface treatment, and copy-first grid layout.

## ConstraintFieldGroup

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Labeled control cluster with inline plain-language help for hard rules, optional thresholds, and source-aware model assumptions.
- **Extractable props:** `label` (string), `helpText` (string), `isOptional` (boolean), `controlType` (select/number/range), `value` (string or number), `onChange` (callback), `isDisabled` (boolean)
- **Hardcoded:** Field spacing, outlined input appearance, muted help style, and Lineup Lab's gold/blue focus treatment.

## ActiveSelectionTray

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Visible removable chips for the currently must-include, excluded, compared, and watched players, preventing hidden state from becoming confusing.
- **Extractable props:** `lockedItems` (array), `excludedItems` (array), `comparedItems` (array), `watchedItems` (array), `onRemove` (callback), `hiddenWhenEmpty` (boolean, default: true)
- **Hardcoded:** State colors, close affordance, action names, compact chip treatment, and the table-to-tray relationship.

## PlayerActionTable

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Horizontally safe player table combining identity/media, historical context, eligibility, and explicit multi-action controls.
- **Extractable props:** `players` (array), `columns` (array), `lockedIds` (array), `excludedIds` (array), `compareIds` (array), `watchlistIds` (array), `onPlayerAction` (callback), `emptyMessage` (string)
- **Hardcoded:** Avatar/headshot fallback behavior, NBA stat column set, section labels, selected-row tones, fixed first-column behavior, and responsive table treatment.

## PlayerIdentityMedia

- **Source:** `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Player or team identity row with a trusted image URL, thoughtfully cropped circular headshot/logo, text fallback, name, and contextual secondary line.
- **Extractable props:** `name` (string), `subtitle` (string), `imageUrl` (string), `fallbackLabel` (string), `imageAlt` (string), `imagePosition` (string), `onImageStatus` (callback)
- **Hardcoded:** Trusted-host image policy, circular crop, initials fallback, current color system, and default source-specific context text.

## ResultsWorkbench

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** layout
- **Description:** Result hierarchy that puts the selected lineup/rotation first, then minute plan, role coverage, evidence, alternatives, comparison charts, and exports.
- **Extractable props:** `status` (idle/loading/success/failure/stale), `headline` (string), `primaryResult` (object), `evidence` (array), `alternatives` (array), `actions` (array), `onReplacementRequest` (callback)
- **Hardcoded:** Exact-optimizer language, scouting-report export wording, evidence labels, result card styles, and solver-status messaging.

## ComparisonBars

- **Source:** `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Side-by-side rate-view comparison rows with colored player bars and a matching table for more detail.
- **Extractable props:** `players` (array), `metrics` (array), `view` (string), `colors` (array), `lowerIsBetterMetrics` (array), `emptyMessage` (string)
- **Hardcoded:** Current NBA metric set, four-color palette, rate-view naming, and Lineup Lab table/card layout.

## CollectorWatchlistGrid

- **Source:** `prototypes/basketball-lineup-optimizer/app.js`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** basic
- **Description:** Device-local player watchlist cards that retain a historical-player snapshot and hand fans back to relevant card inventory search.
- **Extractable props:** `players` (array), `onRemove` (callback), `cardSearchHref` (string), `emptyMessage` (string), `isMigrated` (boolean)
- **Hardcoded:** Local-storage persistence model, DJHC card-search destination, NBA player metadata, and existing card-grid spacing.

## LabFooter

- **Source:** `prototypes/basketball-lineup-optimizer/index.html`, `prototypes/basketball-lineup-optimizer/styles.css`
- **Category:** layout
- **Description:** Minimal closing band that identifies the product and returns fans to the storefront without pulling in the full commerce footer.
- **Extractable props:** `productName` (string), `homeHref` (string), `homeLabel` (string)
- **Hardcoded:** Dark footer surface, one-line historical-tools description, and current return-link placement.

## Not candidates for extraction

- The court illustration, precise optimizer evidence copy, individual historical-opponent details, and model-limitations cards are intentionally scenario-specific.
- The exact minute allocator, player role classifier, URL codec, and Supabase adapter are domain logic; retain them as modules, not visual DraftComponents.
- The storefront's full navigation and commerce footer are separate shared-shell concerns. They should be brought into a future fan-tools route only when the route is meant to join the discoverable storefront shell.
