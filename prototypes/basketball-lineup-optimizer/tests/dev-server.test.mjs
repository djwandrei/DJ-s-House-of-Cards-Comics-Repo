import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createLineupLabServer } from "../dev-server.mjs";

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function withServer(fetchImpl, callback) {
  const server = createLineupLabServer({ fetchImpl, workspaceRoot: WORKSPACE_ROOT });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("same-origin proxy fixes the upstream request shape and returns only validated JSON", async () => {
  const upstreamRequests = [];
  const payload = {
    data: [{ team: "MIN", season: 2026, isPlayoff: false }],
    pagination: { total: 1, page: 1, pageSize: 50, pages: 1 },
  };
  await withServer(async (url, options) => {
    upstreamRequests.push({ url: new URL(url), options });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify(payload);
      },
    };
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/__lineup-api/playertotals?team=MIN&season=2026&page=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), payload);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  assert.equal(upstreamRequests.length, 1);
  const upstream = upstreamRequests[0].url;
  assert.equal(upstream.origin, "https://api.server.nbaapi.com");
  assert.equal(upstream.pathname, "/api/playertotals");
  assert.equal(upstream.searchParams.get("team"), "MIN");
  assert.equal(upstream.searchParams.get("season"), "2026");
  assert.equal(upstream.searchParams.get("isPlayoff"), "false");
  assert.equal(upstream.searchParams.get("pageSize"), "50");
});

test("proxy rejects unapproved teams before contacting the provider", async () => {
  let upstreamCalls = 0;
  await withServer(async () => {
    upstreamCalls += 1;
    throw new Error("should not run");
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/__lineup-api/playertotals?team=2TM&season=2026`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /supported NBA team/);
  });
  assert.equal(upstreamCalls, 0);
});

test("server serves the prototype but blocks non-web workspace files", async () => {
  await withServer(async () => {
    throw new Error("not used");
  }, async (baseUrl) => {
    const page = await fetch(`${baseUrl}/prototypes/basketball-lineup-optimizer/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DJ's Lineup Lab/);

    const protectedFile = await fetch(`${baseUrl}/Stripe%20Key.docx`);
    assert.equal(protectedFile.status, 404);
  });
});

test("proxy converts malformed or mismatched upstream data into a safe failure", async () => {
  await withServer(async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        data: [{ team: "BOS", season: 2026, isPlayoff: false }],
        pagination: { total: 1, page: 1, pageSize: 50, pages: 1 },
      });
    },
  }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/__lineup-api/playertotals?team=MIN&season=2026`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not be read/);
  });
});
