/* Lightweight, first-party milestones for the interactive fan tools.
 *
 * The games load before the idle analytics client on purpose. Queue only the
 * aggregate milestone and elapsed time until analytics.js is ready; never add
 * player names, roster IDs, scores, or model inputs to this channel.
 */

const QUEUE_KEY = '__fanTelemetryQueue';
const READY_EVENT = 'dj-analytics-ready';
const MILESTONES = new Set(['game_start', 'first_interaction', 'reveal', 'completion']);

function queueEvent(event, data) {
  window.DJ = window.DJ || {};
  if (!Array.isArray(window.DJ[QUEUE_KEY])) window.DJ[QUEUE_KEY] = [];
  window.DJ[QUEUE_KEY].push({ event, data });
}

function send(event, data) {
  const tracker = window.DJ?.trackEvent;
  if (typeof tracker === 'function') {
    try {
      tracker(event, data);
      return;
    } catch {
      // Analytics must never interrupt a game. Keep the event queued so a
      // later-ready client can make one best-effort attempt.
    }
  }
  queueEvent(event, data);
}

export function flushFanTelemetryQueue() {
  const queue = window.DJ?.[QUEUE_KEY];
  const tracker = window.DJ?.trackEvent;
  if (!Array.isArray(queue) || typeof tracker !== 'function') return;
  const pending = queue.splice(0);
  for (const item of pending) {
    try { tracker(item.event, item.data); } catch { /* measurement stays non-blocking */ }
  }
}

export function createFanMilestones(experience) {
  const safeExperience = String(experience || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 24) || 'unknown';
  const clock = typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();
  const startedAt = clock();
  const sent = new Set();
  const onReady = () => flushFanTelemetryQueue();
  window.addEventListener(READY_EVENT, onReady);
  flushFanTelemetryQueue();

  return {
    mark(milestone) {
      if (!MILESTONES.has(milestone) || sent.has(milestone)) return;
      sent.add(milestone);
      const now = clock();
      const duration = Math.max(0, Math.round((now - startedAt) * 100) / 100);
      send('web_vitals', { kind: `fan-${safeExperience}`, milestone, duration });
    },
    dispose() {
      window.removeEventListener(READY_EVENT, onReady);
    },
  };
}
