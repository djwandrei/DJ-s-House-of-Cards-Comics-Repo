import assert from "node:assert/strict";
import test from "node:test";

import { pruneLineupLabDatasetCache } from "../lineup-cache.js";

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(String(key), String(value));
  }

  removeItem(key) {
    this.#values.delete(String(key));
  }
}

const family = "djhc-lineup-lab-bref-supabase-";
const activePrefix = `${family}v5:`;

function put(storage, key, cachedAt) {
  storage.setItem(key, JSON.stringify({ cachedAt, dataset: { players: [] } }));
}

test("cache pruning removes obsolete schemas and malformed entries without touching unrelated storage", () => {
  const storage = new MemoryStorage();
  storage.setItem("djhc-lineup-lab-watchlist-v1", "[\"player-1\"]");
  put(storage, `${family}v4:2024:regular:MIN`, 1);
  storage.setItem(`${activePrefix}2025:regular:MIN`, "not-json");
  put(storage, `${activePrefix}2026:regular:MIN`, 3);

  const result = pruneLineupLabDatasetCache(storage, { activePrefix });

  assert.deepEqual(result, { ok: true, kept: 1, removed: 2 });
  assert.equal(storage.getItem("djhc-lineup-lab-watchlist-v1"), "[\"player-1\"]");
  assert.ok(storage.getItem(`${activePrefix}2026:regular:MIN`));
});

test("cache pruning keeps a bounded newest set and preserves the active fallback entry", () => {
  const storage = new MemoryStorage();
  for (let index = 1; index <= 5; index += 1) {
    put(storage, `${activePrefix}202${index}:regular:T${index}`, index);
  }
  const preserved = `${activePrefix}2021:regular:T1`;

  const result = pruneLineupLabDatasetCache(storage, {
    activePrefix,
    maxEntries: 3,
    preserveKey: preserved,
  });

  assert.deepEqual(result, { ok: true, kept: 3, removed: 2 });
  assert.ok(storage.getItem(preserved));
  assert.ok(storage.getItem(`${activePrefix}2025:regular:T5`));
  assert.ok(storage.getItem(`${activePrefix}2024:regular:T4`));
  assert.equal(storage.getItem(`${activePrefix}2023:regular:T3`), null);
});

test("cache pruning fails closed when storage access is unavailable", () => {
  const storage = {
    get length() {
      throw new Error("blocked");
    },
  };

  assert.deepEqual(
    pruneLineupLabDatasetCache(storage, { activePrefix }),
    { ok: false, kept: 0, removed: 0 },
  );
});
