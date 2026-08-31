# Shared UI primitives

## Architecture note

This repository is a **vanilla static HTML, CSS, and JavaScript site**, not a React, Vue, Svelte, Next.js, or other component-framework application. There is no shared `components/` directory and no client-side router. Reuse happens through repeated HTML shell markup, shared global scripts, CSS classes, and DOM-renderer functions.

Lineup Lab is a standalone ES-module page. Its UI primitives are complete DOM functions inside `prototypes/basketball-lineup-optimizer/app.js`; they are not framework components with props. The solver, data adapters, analytics, and URL codec are deliberately non-visual modules and are not listed here.

## Toast

- Source: `prototypes/basketball-lineup-optimizer/app.js`
- Kind: lightweight feedback primitive
- Inputs: `message`
- Dependencies: `elements.toast`, `state.toastTimer`

```js
function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 3600);
}
```

## Storefront card-search link

- Source: `prototypes/basketball-lineup-optimizer/app.js`
- Kind: contextual secondary action
- Inputs: normalized player object
- Behavior: opens an internal basketball-card catalog search rather than claiming an in-stock match.

```js
function createCardSearchLink(player) {
  // An internal search link is safer than attempting to fuzzy-match a player
  // directly to catalog records. It preserves the collector's intent while the
  // catalog remains the authority for whether cards are actually in stock.
  const link = document.createElement("a");
  link.className = "text-button card-search-link";
  link.href = `${CARD_SEARCH_PATH}?search=${encodeURIComponent(player?.name || "")}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Find Cards";
  link.setAttribute("aria-label", `Find cards matching ${player?.name || "this player"} in the storefront (opens in a new tab)`);
  return link;
}
```

## Player media and roster-table controls

- Source: `prototypes/basketball-lineup-optimizer/app.js`
- Kind: player-avatar, media-fallback, table-cell, and selection-checkbox primitives
- Inputs: player record, action metadata, and current app state
- Behavior: preserves a useful initials fallback until a confirmed headshot loads, then maintains a stable accessible control target.

```js
function createCell(row, text, className = "", label = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (label) cell.dataset.label = label;
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function initialsForDisplay(value, fallback = "NBA") {
  const initials = String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return initials || fallback;
}

function updateDatasetMediaSummary() {
  const source = state.dataset?.source || {};
  const headshotPlayers = state.dataset?.players.filter((player) => safeExternalImageUrl(player.headshotUrl)) || [];
  const failedHeadshots = headshotPlayers.filter((player) => state.playerMediaStatus.get(player.id) === "failed").length;
  const usableHeadshots = Math.max(0, headshotPlayers.length - failedHeadshots);
  const hasLogoUrl = Boolean(safeExternalImageUrl(source.teamLogoUrl));
  const usableLogo = hasLogoUrl && state.teamLogoStatus !== "failed";
  const mediaParts = [];
  if (usableHeadshots) mediaParts.push(`${usableHeadshots} player headshot${usableHeadshots === 1 ? "" : "s"}`);
  if (usableLogo) mediaParts.push("team logo");

  if (mediaParts.length === 0) {
    elements.datasetMedia.textContent = "Player initials and the team mark are shown; no confirmed photos or logo is available for this pool.";
    return;
  }
  const availability = `${mediaParts.join(" and ")} available.`;
  const fallbacks = [];
  if (failedHeadshots) {
    fallbacks.push(`initials substituted for ${failedHeadshots} headshot${failedHeadshots === 1 ? "" : "s"} that could not load`);
  }
  if (hasLogoUrl && !usableLogo) fallbacks.push("team mark substituted for the logo that could not load");
  elements.datasetMedia.textContent = fallbacks.length
    ? `${availability} ${fallbacks.join("; ")}.`
    : `${availability} Initials stay in place until each remote image loads.`;
}

function recordPlayerMediaStatus(player, imageUrl, status) {
  // Lazy images from an old team can finish after the player pool changes.
  // Accept a result only when both the player ID and confirmed URL still match
  // the current dataset, preventing stale events from changing the new summary.
  const current = currentPlayer(String(player?.id || ""));
  if (!current || safeExternalImageUrl(current.headshotUrl) !== imageUrl) return;
  if (status === "failed" && state.playerMediaStatus.get(current.id) === "loaded") return;
  state.playerMediaStatus.set(current.id, status);
  updateDatasetMediaSummary();
}

function createPlayerAvatar(player, className = "player-avatar") {
  // Every player gets a stable visual footprint. A confirmed headshot overlays
  // the initials when it loads; a network failure simply leaves the useful
  // initials fallback in place instead of showing a broken-image icon.
  const visual = document.createElement("span");
  visual.className = className;
  visual.setAttribute("aria-hidden", "true");

  const fallback = document.createElement("span");
  fallback.className = `${className}__fallback`;
  fallback.textContent = initialsForDisplay(player?.name);
  visual.append(fallback);

  const imageUrl = safeExternalImageUrl(player?.headshotUrl);
  if (!imageUrl) return visual;

  const image = document.createElement("img");
  image.className = `${className}__image`;
  image.alt = "";
  image.width = 80;
  image.height = 80;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("load", () => {
    image.classList.add("is-loaded");
    recordPlayerMediaStatus(player, imageUrl, "loaded");
  }, { once: true });
  image.addEventListener("error", () => {
    recordPlayerMediaStatus(player, imageUrl, "failed");
    image.remove();
  }, { once: true });
  image.src = imageUrl;
  visual.append(image);
  return visual;
}

function createTableCheckbox(player, action, label, checked, disabled = false) {
  // The visible checkbox stays compact, while its label provides a full 44px
  // pointer/touch target. Keeping data-action on the input preserves delegated
  // change handling and keyboard behavior.
  const target = document.createElement("label");
  target.className = "table-check-target";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "table-check";
  input.dataset.action = action;
  input.dataset.playerId = player.id;
  input.checked = checked;
  input.disabled = disabled;
  input.setAttribute("aria-label", `${label} ${player.name}`);
  target.append(input);
  return target;
}

/**
 * Keep the active hard rules and convenience selections visible above a long
 * roster table. This is deliberately a summary of state—not another way to
 * select a player—so a fan can undo a choice without hunting through 20-plus
 * mobile cards or horizontal desktop columns.
 */
```

## Active-choice tray

- Source: `prototypes/basketball-lineup-optimizer/app.js`
- Kind: visible state summary with remove actions
- Inputs: `lockedIds`, `excludedIds`, `compareIds`, `watchlistIds`
- Behavior: exposes current hard rules and convenience selections above the roster table and removes them through delegated actions.

```js
function renderActiveSelectionTray() {
  if (!state.dataset) return;
  const entries = [];
  const selectionTypes = [
    ["lock", state.lockedIds, "Must include"],
    ["exclude", state.excludedIds, "Do not use"],
    ["compare", state.compareIds, "Compare"],
    ["watch", state.watchlistIds, "Watch"],
  ];
  for (const [action, ids, label] of selectionTypes) {
    for (const id of ids) {
      const player = currentPlayer(id);
      if (!player) continue;
      entries.push({ action, id, label, player });
    }
  }

  elements.activeSelectionTray.replaceChildren();
  elements.activeSelectionTray.hidden = entries.length === 0;
  if (entries.length === 0) return;
  const heading = document.createElement("strong");
  heading.textContent = "Active choices";
  elements.activeSelectionTray.append(heading);
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `selection-chip selection-chip--${entry.action}`;
    button.dataset.selectionAction = entry.action;
    button.dataset.playerId = entry.id;
    button.textContent = `${entry.label}: ${entry.player.name} ×`;
    button.setAttribute("aria-label", `Remove ${entry.player.name} from ${entry.label.toLowerCase()}`);
    elements.activeSelectionTray.append(button);
  }
}

function handleActiveSelectionRemoval(event) {
  const button = event.target.closest("[data-selection-action][data-player-id]");
  if (!button) return;
  const { selectionAction: action, playerId } = button.dataset;
  if (action === "lock") {
    state.lockedIds.delete(playerId);
    markScenarioChanged();
  } else if (action === "exclude") {
    state.excludedIds.delete(playerId);
    markScenarioChanged();
  } else if (action === "compare") {
    state.compareIds.delete(playerId);
    renderCompare();
  } else if (action === "watch") {
    state.watchlistIds.delete(playerId);
    state.watchlistSnapshots.delete(playerId);
    saveWatchlist();
    renderWatchlist();
  } else {
    return;
  }
  renderPlayerTable();
}

function restorePlayerControlFocus(focusTarget) {
  if (!focusTarget) return;
  const control = [...elements.playerTableBody.querySelectorAll("[data-action][data-player-id]")]
    .find((candidate) => (
      candidate.dataset.action === focusTarget.action
      && candidate.dataset.playerId === focusTarget.playerId
    ));
  control?.focus({ preventScroll: true });
}
```

## Result score, season context, and role tags

- Source: `prototypes/basketball-lineup-optimizer/app.js`
- Kind: results-display primitives
- Inputs: label/value or player/analytics explanation data
- Behavior: keeps source season, team stint, sample, playoff availability, and provisional-role status close to the result.

```js
function renderScoreCard(label, value, primary = false) {
  const card = document.createElement("div");
  card.className = `score-card${primary ? " score-card--primary" : ""}`;
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  card.append(labelNode, valueNode);
  return card;
}

function playerInsightFor(explanation, playerId) {
  return explanation?.selectedPlayers?.find((item) => item.playerId === playerId) || null;
}

function renderPlayerSeasonContext(player, insight) {
  const context = document.createElement("p");
  context.className = "lineup-player__context";
  const source = player.analytics?.source || state.dataset?.source || {};
  const sample = insight?.sample || analyticsRateViews(player).sample || {};
  const phase = source.phase === "playoffs" || source.seasonPhase === "playoffs"
    ? "Playoffs"
    : "Regular season";
  const parts = [
    source.season || state.dataset?.source?.season,
    source.team || player.team,
    phase,
    Number.isFinite(Number(sample.games)) ? `${formatNumber(sample.games, 0)} G` : "",
    Number.isFinite(Number(sample.totalMinutes)) ? `${formatNumber(sample.totalMinutes, 0)} total min` : "",
  ].filter(Boolean);
  if (player.analytics?.postseasonAvailable === true) parts.push("Playoff stats available");
  context.textContent = parts.join(" · ");
  return context;
}

function renderRoleTags(roles = []) {
  const tags = document.createElement("div");
  tags.className = "role-tags";
  if (!Array.isArray(roles) || roles.length === 0) {
    const tag = document.createElement("span");
    tag.className = "role-tag role-tag--neutral";
    tag.textContent = "Role signal not established";
    tag.title = "The current comparison pool did not establish a statistical role signal for this player.";
    tags.append(tag);
    return tags;
  }
  roles.slice(0, 3).forEach((role) => {
    const tag = document.createElement("span");
    tag.className = "role-tag";
    const provisional = role.confidence === "small-sample";
    // Keep short-stint labels useful while making their uncertainty obvious at
    // the exact place a fan first sees them—not only in a later method note.
    tag.textContent = provisional
      ? `Provisional ${role.shortLabel || role.label}`
      : role.shortLabel || role.label;
    tag.title = `${role.label}${provisional ? " (provisional small sample; not counted toward role coverage)" : ""}: ${role.evidence?.[0] || "statistical role signal"}`;
    tags.append(tag);
  });
  return tags;
}
```

## Contribution bars

- Source: `prototypes/basketball-lineup-optimizer/app.js`
- Kind: explainability primitive
- Inputs: objective-breakdown object
- Behavior: renders only positively weighted metrics and makes the selected strategy legible as relative percentile contributions.

```js
function renderContributionList(breakdown) {
  const list = document.createElement("ul");
  list.className = "contribution-list";
  const entries = Object.entries(breakdown || {}).sort(
    (left, right) => right[1].scoreContribution - left[1].scoreContribution,
  );
  for (const [metric, detail] of entries) {
    if (detail.weight <= 0) continue;
    const item = document.createElement("li");
    item.className = "metric-bar";
    const label = document.createElement("span");
    label.textContent = METRIC_LABELS[metric] || titleCase(metric);
    const track = document.createElement("span");
    track.className = "metric-bar__track";
    const fill = document.createElement("span");
    fill.className = "metric-bar__fill";
    fill.style.width = `${Math.max(2, Math.min(100, detail.averagePercentile * 100))}%`;
    track.append(fill);
    const value = document.createElement("strong");
    value.textContent = `${Math.round(detail.averagePercentile * 100)}`;
    item.append(label, track, value);
    list.append(item);
  }
  return list;
}

function auditRow(labelText, valueText, passed = true) {
  const row = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = labelText;
  const value = document.createElement("strong");
  value.className = passed ? "pass" : "fail";
  value.textContent = valueText;
  row.append(label, value);
  return row;
}
```

## Non-visual shared modules

These are part of the Lineup Lab dependency graph but should not be treated as UI components:

- `optimizer-core.js` — exact lineup/rotation feasibility and objective optimization.
- `fan-analytics.js` — role classification, rate views, selection explanations, replacement deltas, and coverage analysis.
- `player-data.js` — source-neutral player/dataset normalization plus CSV import/export.
- `supabase-nba-data.js` — imported Basketball Reference team-season adapter.
- `nba-stats-api.js` — provider adapter support.
- `scenario-url.js` — safe shareable-scenario query codec.

