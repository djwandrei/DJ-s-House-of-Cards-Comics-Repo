// Real Chromium layout/interaction test, with an offline course fixture only.
// No credentials, private evidence, account writes, or live game submissions.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const root = process.cwd();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = path.join(root, "outputs", "lineup-workflow");
fs.mkdirSync(output, { recursive: true });
const allowed = new Map([[".html", "text/html"], [".js", "text/javascript"], [".css", "text/css"], [".json", "application/json"], [".png", "image/png"], [".webp", "image/webp"], [".jpg", "image/jpeg"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".svg", "image/svg+xml"]]);
const server = createServer((request, response) => {
  let relative = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  if (relative.endsWith("/")) relative += "index.html";
  const target = path.resolve(root, "." + relative);
  if (!target.startsWith(root + path.sep) || !allowed.has(path.extname(target)) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
  response.setHeader("Content-Type", allowed.get(path.extname(target)));
  response.setHeader("Cache-Control", "no-store");
  if (["backend-config.js", "supabase-client.js"].includes(path.basename(target))) { response.end("window.DJ ||= {}; window.DJ.remoteCatalog = { getSession: async () => null };"); return; }
  fs.createReadStream(target).pipe(response);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browserPath = [process.env.EDGE_PATH, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(p => p && fs.existsSync(p));
assert.ok(browserPath, "Chromium is required");
const port = 9700 + Math.floor(Math.random() * 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "djhc-workflow-"));
const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let websocket;
const pending = new Map();
const exceptions = [];
let nextId = 0;
async function retry(fn, label, timeout = 15000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await wait(120); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const setValue = (selector, value, event = "input") => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true}));})()`);
const current = () => evaluate(`document.querySelector('[data-workflow-stage]:not([hidden])')?.dataset.workflowStage || (!document.querySelector('#results').hidden ? 'results' : 'none')`);
async function reloadReady(label) {
  const origin = await evaluate("performance.timeOrigin");
  await send("Page.reload");
  await retry(() => evaluate(`performance.timeOrigin !== ${origin} && document.readyState === 'complete' && document.querySelector('.journey-draft-status')?.textContent.includes('saved') && !!document.querySelector('[data-workflow-stage]:not([hidden])')`), label);
}
async function screenshot(name) { await wait(300); const shot = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(shot.data, "base64")); }
async function assertStage(expected) { await retry(async () => (await current()) === expected, expected); assert.equal(await evaluate("document.activeElement.id"), "workflowHeading"); }
const sourcePath = process.argv.includes("--release") ? "/lineup-lab/index.html" : "/prototypes/basketball-lineup-optimizer/index.html";
try {
  const tabs = await retry(async () => { const r = await fetch(`http://127.0.0.1:${port}/json/list`); return r.ok ? r.json() : null; }, "browser launch");
  websocket = new WebSocket(tabs.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { websocket.onopen = resolve; websocket.onerror = reject; });
  websocket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const base = `http://127.0.0.1:${server.address().port}`;
  await send("Page.navigate", { url: base + sourcePath });
  await retry(() => evaluate("document.querySelector('#datasetCount')?.textContent === '15' && document.querySelector('.journey-draft-status')?.textContent.includes('saved')"), "fixture + workflow", 20000);
  assert.equal(await current(), "team");
  assert.equal(await evaluate("document.querySelector('#loadLiveDataButton').textContent"), "Retry historical data");
  await screenshot("desktop-team");
  assert.equal(await evaluate("document.querySelector('[data-workflow-target=review]').disabled"), true);
  await click("#workflowNext"); await assertStage("plan");
  await click('[data-preset="offense"]');
  await screenshot("desktop-plan");
  await click("#workflowNext"); await assertStage("players");
  await evaluate("document.querySelector('#playerPoolDetails').open=true");
  await click('[data-action="lock"]');
  assert.equal(await evaluate("document.querySelectorAll('[data-action=lock]:checked').length"), 1);
  await click("#workflowNext"); await assertStage("rules");
  await click("#detailedModeButton");
  await setValue("#minGuardsInput", 6);
  await click("#workflowNext");
  assert.equal(await current(), "rules");
  assert.equal(await evaluate("document.querySelector('#workflowErrors').hidden"), false);
  assert.match(await evaluate("document.querySelector('#workflowErrors').textContent"), /required court-role slots/);
  await setValue("#minGuardsInput", 2);
  await setValue("#minPointsInput", 9999);
  await click("#workflowNext");
  assert.match(await evaluate("document.querySelector('#workflowErrors').textContent"), /floor exceeds/);
  await setValue("#minPointsInput", "");
  await click("#workflowNext"); await assertStage("review");
  assert.match(await evaluate("document.querySelector('#workflowReview').textContent"), /Must include:/);
  await screenshot("desktop-review");
  await reloadReady("draft restored");
  assert.equal(await current(), "review");
  assert.equal(await evaluate("document.querySelectorAll('[data-action=lock]:checked').length"), 1);
  await click("#optimizeButton");
  await retry(async () => (await current()) === "results", "exact result", 55000);
  assert.match(await evaluate("document.querySelector('#resultsHeading').textContent"), /recommended lineup/);
  await screenshot("desktop-results");
  assert.match(await evaluate("document.querySelector('.lineup-dna__swap').textContent"), /Decision brief:/);
  await click('[data-action="lineup-dna-replacement"]');
  await retry(() => evaluate("document.querySelector('[data-lineup-dna-replacement-output]')?.textContent.includes('Role check:')"), "DNA exact substitution", 55000);
  assert.match(await evaluate("document.querySelector('[data-lineup-dna-replacement-output]').textContent"), /original selection has not been replaced/);
  assert.equal(await evaluate("document.querySelector('[data-lineup-dna-replacement-output] details').open"), false);
  await retry(() => evaluate("!document.querySelector('#toast').classList.contains('is-visible')"), "transient toast cleared");
  await evaluate("document.querySelector('.lineup-dna__swap').scrollIntoView({block:'start'})");
  await screenshot("desktop-dna-decision");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.querySelector('.lineup-dna__swap').scrollIntoView({block:'start'})");
  assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "DNA mobile overflow");
  await screenshot("mobile-dna-decision");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await click("#workflowRevise"); await assertStage("plan");
  await setValue("#modeInput", "rotation", "change");
  await click('[data-workflow-target="rules"]');
  await setValue("#rotationMaxInput", 20);
  await click("#workflowNext");
  assert.match(await evaluate("document.querySelector('#workflowErrors').textContent"), /exactly 240/);
  await setValue("#rotationMaxInput", 40);
  await click("#workflowNext"); await assertStage("review");
  // Cancel after a real Worker has been started, without waiting for a full
  // exact rotation. Test that duplicate programmatic submission stays blocked.
  await click("#optimizeButton");
  assert.equal(await current(), "running");
  await screenshot("desktop-running");
  await click("#cancelOptimizeButton"); await assertStage("review");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  for (const step of ["team", "plan", "players", "rules", "review"]) {
    await click(`[data-workflow-target="${step}"]`); await wait(220);
    assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), `${step}: mobile overflow`);
    await screenshot(`mobile-${step}`);
  }
  await evaluate("history.back()"); await retry(async () => (await current()) === "rules", "browser back");
  await evaluate("history.forward()"); await retry(async () => (await current()) === "review", "browser forward");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.journey-ball')).animationName"), "none");
  // Detailed preferences survive a Simple-mode draft, including a hard reload.
  await click('[data-workflow-target="rules"]');
  await setValue("#rotationMaxInput", 39);
  await click("#simpleModeButton");
  assert.equal(await evaluate("document.querySelector('#rotationMaxInput').value"), "40");
  await reloadReady("simple draft restored");
  await click("#detailedModeButton");
  assert.equal(await evaluate("document.querySelector('#rotationMaxInput').value"), "39");
  // Forward navigation must revalidate a previously completed decision.
  await setValue("#rotationMaxInput", 20);
  await click('[data-workflow-target="review"]');
  assert.equal(await current(), "rules");
  await setValue("#rotationMaxInput", 40);
  for (const width of [320, 760, 900, 1024]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 761 });
    assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), `${width}px overflow`);
  }
  // A confirmed reset removes the draft instead of immediately autosaving it.
  await evaluate("window.confirm=()=>true");
  await click(".journey-restart");
  await assertStage("team");
  await wait(150);
  assert.equal(await evaluate("localStorage.getItem('djhc-lineup-lab-workflow-v1')"), null);
  assert.equal(await evaluate("document.querySelectorAll('[data-action=lock]:checked').length"), 0);
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send("Page.navigate", { url: base + "/tools/index.html" });
  await retry(() => evaluate("document.querySelector('#toolsFeatured')?.children.length > 0"), "fan hub");
  if (await evaluate("!!document.querySelector('[data-play-filter=games]')")) {
    await click('[data-play-filter="games"]');
    assert.equal(await evaluate("document.querySelectorAll('#toolsFeatured article:not([hidden])').length"), 2);
    await evaluate("document.querySelector('#playNow').scrollIntoView()");
    await screenshot("mobile-fan-tools");
    await click('#suggestPlay');
    assert.equal(await evaluate("document.querySelectorAll('#toolsFeatured article.is-suggested:not([hidden])').length"), 1);
    assert.equal(await evaluate("document.activeElement.closest('article').classList.contains('is-suggested')"), true);
    await click('[data-play-filter="all"]');
    assert.equal(await evaluate("document.querySelectorAll('#toolsFeatured article:not([hidden])').length"), 5);
  }
  assert.deepEqual(exceptions, []);
  console.log(JSON.stringify({ ok: true, sourcePath, checks: ["single active step", "gated navigation", "focus", "locks", "role and production conflicts", "draft restore", "exact lineup", "DNA exact swap and role debrief", "collapsed interpretation", "minute conflicts", "cancel", "390px all stages", "back/forward", "reduced motion", "fan hub"], screenshots: output }, null, 2));
} catch (error) {
  console.error(error);
  if (websocket?.readyState === 1) { console.error(await evaluate("({heading:document.querySelector('#workflowHeading')?.textContent,status:document.querySelector('#liveDataStatus')?.textContent,errors:document.querySelector('#workflowErrors')?.textContent})").catch(() => null)); await screenshot("failure").catch(() => {}); }
  console.error(exceptions); process.exitCode = 1;
} finally {
  websocket?.close(); browser.kill(); server.close();
}
