import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function createBrowserWindow() {
  const listeners = new Map();
  return {
    DJ: {},
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) || []) listener(event);
    }
  };
}

test('Fan Tools milestones queue only aggregate, one-time events until analytics is ready', async () => {
  const originalWindow = globalThis.window;
  const window = createBrowserWindow();
  globalThis.window = window;

  try {
    const moduleUrl = new URL(`../../tools/fan-telemetry.js?test=${Date.now()}-${Math.random()}`, import.meta.url);
    const { createFanMilestones, flushFanTelemetryQueue } = await import(moduleUrl.href);
    const milestones = createFanMilestones('Fix the Five');

    milestones.mark('not-a-milestone');
    milestones.mark('game_start');
    milestones.mark('game_start');
    assert.equal(window.DJ.__fanTelemetryQueue.length, 1);
    const [queued] = window.DJ.__fanTelemetryQueue;
    assert.equal(queued.event, 'web_vitals');
    assert.deepEqual(Object.keys(queued.data).sort(), ['duration', 'kind', 'milestone']);
    assert.equal(queued.data.kind, 'fan-fix-the-five');
    assert.equal(queued.data.milestone, 'game_start');
    assert.ok(Number.isFinite(queued.data.duration) && queued.data.duration >= 0);

    const sent = [];
    window.DJ.trackEvent = (event, data) => sent.push({ event, data });
    window.dispatchEvent({ type: 'dj-analytics-ready' });
    assert.equal(window.DJ.__fanTelemetryQueue.length, 0);
    assert.equal(sent.length, 1);

    milestones.mark('completion');
    assert.equal(sent.length, 2);
    window.DJ.trackEvent = () => { throw new Error('temporary analytics failure'); };
    milestones.mark('reveal');
    assert.equal(window.DJ.__fanTelemetryQueue.length, 1);
    window.DJ.trackEvent = (event, data) => sent.push({ event, data });
    flushFanTelemetryQueue();
    assert.equal(window.DJ.__fanTelemetryQueue.length, 0);
    assert.equal(sent.length, 3);
    milestones.dispose();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('the first-party analytics boundary preserves only bounded milestone fields', () => {
  const source = fs.readFileSync(new URL('../../supabase/functions/analytics-event/index.ts', import.meta.url), 'utf8');
  assert.match(source, /const milestone = safeText\(source\.milestone, 40\)/);
  assert.match(source, /const duration = safeNumber\(source\.duration, 3_600_000\)/);
  assert.match(source, /\.\.\.\(milestone \? \{ milestone \} : \{\}\)/);
  assert.match(source, /\.\.\.\(duration !== undefined \? \{ duration \} : \{\}\)/);
});
