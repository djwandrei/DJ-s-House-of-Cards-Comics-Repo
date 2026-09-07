import { WORKFLOW_STEPS, resolveWorkflowStep, saveWorkflowDraft, DRAFT_KEY } from "./workflow-state.js?v=20260907b";

const make = (tag, className = "", text = "") => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};
const button = (text, className = "button button--quiet") => {
  const node = make("button", className, text);
  node.type = "button";
  return node;
};

// Move the original controls, never clone them. All existing listeners, labels,
// datasets, constraints, and result components retain their single owner.
export function createWorkflowView({ state, form, capture, validate, reset, storage, draft }) {
  const q = selector => document.querySelector(selector);
  const root = q("#optimizerView");
  const workflow = state.workflow = { current: "team", furthest: 0, form: null, ready: false, hasChanges: false };
  const shell = make("div", "guided-workflow");
  const rail = make("aside", "journey-rail");
  rail.setAttribute("aria-label", "Your coaching journey");
  rail.append(make("p", "journey-rail__eyebrow", "Your coaching journey"));
  const nav = make("nav");
  nav.setAttribute("aria-label", "Build progress");
  const stepper = make("ol", "journey-steps");
  const stepButtons = WORKFLOW_STEPS.map((step, index) => {
    const li = make("li");
    const control = button("", "journey-step");
    control.dataset.workflowTarget = step.id;
    control.append(make("span", "journey-step__number", String(index + 1)), make("span", "journey-step__label", step.label), make("small", "journey-step__status"));
    li.append(control); stepper.append(li);
    control.addEventListener("click", () => go(step.id));
    return control;
  });
  nav.append(stepper); rail.append(nav);
  const ticket = make("div", "journey-ticket");
  ticket.append(make("p", "journey-rail__eyebrow", "Game-plan ticket"));
  const ticketCopy = make("p"); ticket.append(ticketCopy); rail.append(ticket);
  const draftStatus = make("p", "journey-draft-status", "Your setup stays on this device.");
  draftStatus.setAttribute("role", "status");
  rail.append(draftStatus);
  const restart = button("Start over", "journey-restart"); rail.append(restart);
  const canvas = make("div", "journey-canvas");
  const headingWrap = make("header", "journey-heading");
  const progress = make("p", "eyebrow"); progress.id = "workflowProgressLabel";
  const heading = make("h2"); heading.id = "workflowHeading"; heading.tabIndex = -1;
  const description = make("p", "journey-description");
  headingWrap.append(progress, heading, description);
  const errors = make("section", "journey-errors"); errors.id = "workflowErrors"; errors.tabIndex = -1; errors.hidden = true;
  errors.setAttribute("aria-label", "Settings that need attention");
  const stages = Object.fromEntries(WORKFLOW_STEPS.map(step => {
    const stage = make("section", `journey-stage journey-stage--${step.id}`);
    stage.dataset.workflowStage = step.id;
    stage.setAttribute("aria-labelledby", "workflowHeading");
    return [step.id, stage];
  }));
  const busy = make("section", "journey-stage journey-busy");
  busy.dataset.workflowStage = "running";
  busy.setAttribute("aria-labelledby", "workflowHeading");
  const court = make("div", "journey-court"); court.setAttribute("aria-hidden", "true");
  court.append(make("span", "journey-ball"));
  const busyHeading = make("h3", "", "Checking every eligible group");
  const busyNote = make("p", "", "The exact search runs in the background. Larger rotations can take longer; your settings are kept if you cancel.");
  busy.append(court, busyHeading, busyNote, q("#solverStatus"), q("#optimizationProgress"), q("#cancelOptimizeButton"));
  const busyProgress = make("progress", "journey-search-progress");
  busyProgress.setAttribute("aria-label", "Exact search progress (indeterminate until the solver reports work)");
  busy.prepend(busyProgress);
  stages.running = busy;

  stages.team.append(q("#liveDataPanel"), q("#datasetStrip"));
  const plan = q('[aria-labelledby="scenarioHeading"]');
  const rules = q('[aria-labelledby="constraintsHeading"]');
  const players = q('[aria-labelledby="playersHeading"]');
  const runCard = q(".run-card");
  // Reporting preferences do not define the objective; keep them with advanced
  // options. The original IDs and Detailed behavior remain unchanged.
  const reporting = make("details", "journey-rule-group detailed-only");
  reporting.append(make("summary", "", "Reports & alternatives"));
  reporting.append(q("#alternativesInput").closest("label"), q("#analyticsPanel"));
  stages.rules.append(q("#simpleModelSummary"), rules, reporting);
  stages.plan.append(plan);
  stages.players.append(players);
  const groups = [...rules.querySelectorAll(".constraint-groups > fieldset")];
  groups.forEach((fieldset, index) => {
    const disclosure = make("details", "journey-rule-group");
    const summary = make("summary", "", fieldset.querySelector("legend").textContent.trim());
    disclosure.dataset.ruleGroup = String(index);
    fieldset.before(disclosure); disclosure.append(summary, fieldset);
    if (fieldset.id === "rotationSettings") disclosure.dataset.rotationGroup = "true";
  });
  const review = make("div", "journey-review"); review.id = "workflowReview";
  stages.review.append(review, runCard);
  const navigation = make("div", "journey-navigation");
  const back = button("← Back"); back.id = "workflowBack";
  const next = button("Continue →", "button"); next.id = "workflowNext";
  const nextHint = make("span", "journey-next-hint");
  navigation.append(back, nextHint, next);
  // Remove the now-empty layout wrappers, not any shopper controls.
  q(".builder-grid").remove();
  form.noValidate = true;
  form.prepend(...Object.values(stages));
  form.append(navigation);
  const results = q("#results");
  const resultNavigation = make("div", "journey-result-navigation");
  const revise = button("← Revise game plan"); revise.id = "workflowRevise";
  const rerun = button("Review & run again", "button"); rerun.id = "workflowRerun";
  resultNavigation.append(revise, rerun);
  root.prepend(shell);
  shell.append(rail, canvas);
  canvas.append(headingWrap, errors, form, results, resultNavigation);
  q("#emptyResult").hidden = true;
  // Keep the legacy controls for module compatibility, but expose just one
  // solve action, on Review. Start over is an explicit, confirmed action.
  q("#resetScenarioButton").hidden = true;
  q(".mobile-solve-bar").hidden = true;

  let errorsVisible = false;
  let saving = false;
  let suppressDraft = false;
  let queued = false;
  function save() {
    if (!workflow.ready || saving || suppressDraft) return;
    workflow.form = capture();
    const saved = saveWorkflowDraft(storage, workflow, workflow.form);
    draftStatus.textContent = saved ? "✓ Draft saved on this device" : "Draft cannot be saved here. Keep this tab open; CSV imports need reimporting after a refresh.";
    workflow.saved = saved;
  }
  function writeUrl(replace = false) {
    const url = new URL(location.href);
    url.searchParams.set("step", workflow.current === "running" ? "review" : workflow.current);
    history[replace ? "replaceState" : "pushState"]({ ...history.state, lineupStep: workflow.current }, "", url);
  }
  function clearErrors() {
    root.querySelectorAll(".journey-field-error").forEach(node => node.remove());
    root.querySelectorAll('[data-workflow-invalid]').forEach(node => {
      node.removeAttribute("aria-invalid");
      const descriptions = (node.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => !id.startsWith("journey-error-"));
      if (descriptions.length) node.setAttribute("aria-describedby", descriptions.join(" "));
      else node.removeAttribute("aria-describedby");
      delete node.dataset.workflowInvalid;
    });
    errors.replaceChildren(); errors.hidden = true;
  }
  function showErrors(list, focus = true) {
    clearErrors();
    errorsVisible = Boolean(list.length);
    if (!list.length) return;
    errors.hidden = false;
    errors.append(make("h3", "", "A quick adjustment before you continue"));
    const ul = make("ul"); errors.append(ul);
    list.forEach((error, index) => {
      const li = make("li");
      const link = button(error.message, "text-button");
      link.addEventListener("click", () => {
        go(error.step, { force: true });
        let target = document.getElementById(error.field);
        // Hidden advanced defaults need a visible edit path in Simple mode.
        if (target?.closest(".detailed-only") && state.experienceMode === "simple") q("#detailedModeButton").click();
        target?.closest("details")?.setAttribute("open", "");
        for (let parent = target?.parentElement; parent; parent = parent.parentElement) if (parent.matches("details")) parent.open = true;
        if (target) { if (!target.matches("input, select, button, a[href]")) target.tabIndex = -1; target.focus(); } else heading.focus();
      });
      li.append(link); ul.append(li);
      const target = document.getElementById(error.field);
      if (target && !target.dataset.workflowInvalid) {
        const detail = make("small", "journey-field-error", error.message);
        detail.id = `journey-error-${index}`;
        target.after(detail);
        target.setAttribute("aria-invalid", "true");
        target.setAttribute("aria-describedby", `${target.getAttribute("aria-describedby") || ""} ${detail.id}`.trim());
        target.dataset.workflowInvalid = "true";
      }
    });
    if (focus) errors.focus();
  }
  function renderReview() {
    review.replaceChildren();
    for (const step of WORKFLOW_STEPS.slice(0, 4)) {
      const card = make("section", "journey-review-card");
      const top = make("div", "journey-review-card__heading");
      const edit = button(`Edit ${step.label.toLowerCase()}`, "text-button");
      edit.dataset.workflowEdit = step.id;
      edit.addEventListener("click", () => go(step.id));
      top.append(make("h3", "", step.label), edit); card.append(top);
      if (step.id === "team") {
        card.append(make("p", "", `${q("#datasetName").textContent} · ${q("#datasetSeason").textContent} · ${state.loadedLiveSelection?.seasonPhase || "Local data"}`));
      } else if (step.id === "players") {
        const names = ids => [...ids].map(id => state.dataset?.players.find(p => p.id === id)?.name || id).join(", ") || "None";
        card.append(make("p", "", `Must include: ${names(state.lockedIds)}`), make("p", "", `Excluded: ${names(state.excludedIds)}`));
        const usage = Object.entries(state.offensiveResponsibilities).map(([id, value]) => `${names([id])}: ${Math.round(value * 100)}%`).join("; ");
        if (usage) card.append(make("p", "", `Usage scenarios${state.experienceMode === "simple" ? " (saved; inactive in Simple)" : ""}: ${usage}`));
      } else {
        if (step.id === "plan") {
          card.append(make("p", "journey-review-emphasis", `${q("#runModeSummary").textContent} · ${q("#runPresetSummary").textContent}`));
          if (q("#modelModeInput").value !== "scout") card.append(make("p", "", q("#weightShareSummary").textContent));
          if (state.opponentDataset) card.append(make("p", "", `Opponent context: ${state.opponentDataset.source?.team || "Loaded"}. Only explicitly applied priorities affect this build.`));
        } else card.append(make("p", "journey-review-emphasis", state.experienceMode === "simple" ? "Recommended Simple settings" : "Detailed settings · inspect every active rule"));
        const dl = make("dl");
        const controls = stages[step.id].querySelectorAll("input[id], select[id]");
        for (const input of controls) {
          if (input.disabled || input.type === "file" || input.type === "search") continue;
          // Step wrappers are hidden on Review; only inspect conditional nodes
          // inside the stage, not the outer step visibility.
          let conditionallyHidden = false;
          for (let node = input; node && node !== stages[step.id]; node = node.parentElement) if (node.hidden) conditionallyHidden = true;
          if (conditionallyHidden) continue;
          const label = input.closest("label")?.querySelector("span")?.textContent;
          if (!label) continue;
          const value = input.tagName === "SELECT" ? input.selectedOptions[0]?.textContent : input.value || "No limit";
          const row = make("div"); row.append(make("dt", "", label), make("dd", "", value || "—")); dl.append(row);
        }
        card.append(dl);
      }
      review.append(card);
    }
  }
  function render({ focus = false } = {}) {
    const index = WORKFLOW_STEPS.findIndex(step => step.id === workflow.current);
    const special = index < 0;
    const current = WORKFLOW_STEPS[index];
    progress.textContent = special ? (workflow.current === "running" ? "Exact search in progress" : "Your result") : `Step ${index + 1} of ${WORKFLOW_STEPS.length} · ${current.label}`;
    heading.textContent = current?.title || (workflow.current === "running" ? "Drawing up your best group…" : state.lastResult?.ok ? "Meet your game plan." : "Let's adjust the plan.");
    description.textContent = current?.description || (workflow.current === "running" ? "Real work, real constraints. The solver will report its progress below." : "Explore the result, test a swap, or revise your settings and build again.");
    stepButtons.forEach((control, i) => {
      const active = i === index;
      const complete = i < workflow.furthest || special;
      control.disabled = workflow.current === "running" || i > workflow.furthest;
      control.classList.toggle("is-current", active); control.classList.toggle("is-complete", complete && !active);
      if (active) control.setAttribute("aria-current", "step"); else control.removeAttribute("aria-current");
      control.querySelector(".journey-step__number").textContent = complete && !active ? "✓" : String(i + 1);
      control.querySelector(".journey-step__status").textContent = active ? "Current" : complete ? "Completed · edit" : "Up next";
    });
    Object.entries(stages).forEach(([id, node]) => { node.hidden = id !== workflow.current; });
    const onResults = workflow.current === "results";
    results.hidden = !onResults;
    form.hidden = onResults;
    resultNavigation.hidden = !onResults;
    navigation.hidden = special;
    next.hidden = workflow.current === "review";
    back.disabled = index === 0;
    next.textContent = index === 3 ? "Review game plan →" : "Continue →";
    nextHint.textContent = index >= 0 && index < 4 ? `Next: ${WORKFLOW_STEPS[index + 1].label}` : "All set? Run the exact search below.";
    restart.disabled = workflow.current === "running";
    document.querySelectorAll(".experience-switcher button, .tool-nav button").forEach(control => { control.disabled = workflow.current === "running"; });
    q("#emptyResult").hidden = true;
    ticketCopy.textContent = `${q("#datasetTeam").textContent} · ${q("#datasetSeason").textContent}\n${q("#runModeSummary").textContent}\n${q("#runPresetSummary").textContent} · ${state.lockedIds.size} locked`;
    const rotationGroup = q('[data-rotation-group]');
    if (rotationGroup) rotationGroup.hidden = q("#modeInput").value !== "rotation";
    if (workflow.current === "review") renderReview();
    if (focus) { heading.focus({ preventScroll: true }); headingWrap.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" }); }
  }
  function go(requested, { force = false, replace = false, focus = true } = {}) {
    if (workflow.current === "running" && !force) return;
    const target = force ? requested : resolveWorkflowStep(requested, workflow.furthest, Boolean(state.lastResult));
    const fromIndex = WORKFLOW_STEPS.findIndex(step => step.id === workflow.current);
    const toIndex = WORKFLOW_STEPS.findIndex(step => step.id === target);
    if (!force && workflow.ready && toIndex > fromIndex && fromIndex >= 0) {
      const conflicts = validate().filter(error => WORKFLOW_STEPS.findIndex(step => step.id === error.step) < toIndex);
      if (conflicts.length) { showErrors(conflicts); if (replace) writeUrl(true); return; }
    }
    workflow.current = target;
    clearErrors(); errorsVisible = false;
    render({ focus }); writeUrl(replace); save();
    if (target === "review") showErrors(validate(), false);
  }
  function refresh() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      render();
      if (errorsVisible) showErrors(validate().filter(error => workflow.current === "review" || error.step === workflow.current), false);
      save();
    });
  }
  function continueStep() {
    if (!workflow.ready) { showErrors([{ step: "team", field: "loadLiveDataButton", message: "The roster is still loading. Please wait or try the demo." }]); return; }
    const index = WORKFLOW_STEPS.findIndex(step => step.id === workflow.current);
    const list = validate().filter(error => WORKFLOW_STEPS.findIndex(step => step.id === error.step) <= index);
    if (list.length) { showErrors(list); return; }
    workflow.furthest = Math.max(workflow.furthest, Math.min(4, index + 1));
    workflow.hasChanges = true;
    suppressDraft = false;
    go(WORKFLOW_STEPS[Math.min(4, index + 1)].id);
  }
  back.addEventListener("click", () => { const i = WORKFLOW_STEPS.findIndex(step => step.id === workflow.current); if (i > 0) go(WORKFLOW_STEPS[i - 1].id); });
  next.addEventListener("click", continueStep);
  revise.addEventListener("click", () => go("plan"));
  rerun.addEventListener("click", () => go("review"));
  restart.addEventListener("click", () => {
    if (!confirm("Start a fresh game plan? This clears this Lab draft and its settings. Your loaded roster, comparisons, and watchlist are kept.")) return;
    saving = true; reset(); workflow.furthest = 0; workflow.hasChanges = false;
    try { storage.removeItem(DRAFT_KEY); } catch { /* blocked storage is nonfatal */ }
    go("team", { force: true }); saving = false; suppressDraft = true;
    workflow.saved = true;
    draftStatus.textContent = "Draft cleared. Start a new game plan.";
  });
  shell.addEventListener("input", () => { suppressDraft = false; workflow.hasChanges = true; refresh(); });
  shell.addEventListener("change", () => { suppressDraft = false; workflow.hasChanges = true; refresh(); });
  window.addEventListener("popstate", () => {
    if (workflow.current === "running") { writeUrl(true); return; }
    go(new URL(location.href).searchParams.get("step"), { replace: true });
  });
  window.addEventListener("beforeunload", event => {
    if (workflow.ready && workflow.hasChanges && !workflow.saved) { event.preventDefault(); event.returnValue = ""; }
  });
  render();
  return {
    refresh,
    changed() { suppressDraft = false; workflow.hasChanges = true; refresh(); },
    ready(restored = false) {
      workflow.ready = true;
      workflow.furthest = restored ? draft?.furthest || 0 : 0;
      const urlStep = new URL(location.href).searchParams.get("step");
      const requested = restored && urlStep === "results" ? "review" : urlStep || (restored ? draft?.step : null) || "team";
      suppressDraft = Boolean(draft && !restored);
      go(resolveWorkflowStep(requested, workflow.furthest), { force: true, replace: true, focus: false });
      if (suppressDraft) draftStatus.textContent = "The saved roster was unavailable. Your original draft is kept until you make a new choice.";
    },
    beforeSubmit(event) {
      if (workflow.current === "running") return false;
      if (event && workflow.current !== "review") { continueStep(); return false; }
      const list = validate();
      if (list.length) { showErrors(list); return false; }
      return true;
    },
    start() { workflow.furthest = 4; go("running", { force: true }); },
    finish() { go("results", { force: true, replace: true }); },
    cancelled() { if (workflow.current === "running") go("review", { force: true, replace: true }); },
  };
}
