import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NBA_STATS_API_BASE_URL,
  NBA_STATS_PROXY_PATH,
  NBA_TEAMS,
} from "./nba-stats-api.js";

const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = path.resolve(SERVER_DIRECTORY, "..", "..");
const TEAM_CODES = new Set(NBA_TEAMS.map(({ code }) => code));
const ALLOWED_STATIC_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".png",
  ".svg",
  ".webp",
  ".woff2",
]);
const CONTENT_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});
const MAX_UPSTREAM_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;

function commonHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function sendJson(response, status, body) {
  response.writeHead(status, commonHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function parseProxyRequest(url) {
  const team = String(url.searchParams.get("team") || "").trim().toUpperCase();
  const season = Number(url.searchParams.get("season"));
  const page = Number(url.searchParams.get("page") || 1);
  if (!TEAM_CODES.has(team)) throw new RangeError("Choose a supported NBA team.");
  if (!Number.isInteger(season) || season < 1947 || season > 2100) {
    throw new RangeError("Choose a valid NBA season ending year.");
  }
  if (!Number.isInteger(page) || page < 1 || page > 5) {
    throw new RangeError("NBA Stats API page must be between 1 and 5.");
  }
  return { team, season, page };
}

function validateUpstreamPayload(payload, request) {
  if (!payload || !Array.isArray(payload.data) || !payload.pagination) {
    throw new TypeError("The upstream NBA service returned an unexpected response.");
  }
  if (payload.data.length > 50) throw new RangeError("The upstream NBA response exceeded 50 player rows.");
  const pages = Number(payload.pagination.pages ?? 0);
  if (!Number.isInteger(pages) || pages < 0 || pages > 5) {
    throw new RangeError("The upstream NBA response reported unsafe pagination.");
  }
  for (const row of payload.data) {
    if (
      String(row?.team || "").toUpperCase() !== request.team
      || Number(row?.season) !== request.season
      || row?.isPlayoff === true
      || String(row?.isPlayoff).toLowerCase() === "true"
    ) {
      throw new RangeError("The upstream NBA response did not match the requested team-season.");
    }
  }
  return payload;
}

async function proxyPlayerTotals(response, url, fetchImpl) {
  let request;
  try {
    request = parseProxyRequest(url);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
    return;
  }

  const upstream = new URL("/api/playertotals", NBA_STATS_API_BASE_URL);
  upstream.searchParams.set("team", request.team);
  upstream.searchParams.set("season", String(request.season));
  upstream.searchParams.set("isPlayoff", "false");
  upstream.searchParams.set("page", String(request.page));
  upstream.searchParams.set("pageSize", "50");
  upstream.searchParams.set("sortBy", "points");
  upstream.searchParams.set("ascending", "false");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetchImpl(upstream, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!upstreamResponse.ok) {
      sendJson(response, 502, { error: `The upstream NBA service returned ${upstreamResponse.status}.` });
      return;
    }
    const text = await upstreamResponse.text();
    if (Buffer.byteLength(text, "utf8") > MAX_UPSTREAM_BYTES) {
      sendJson(response, 502, { error: "The upstream NBA response was unexpectedly large." });
      return;
    }
    const payload = validateUpstreamPayload(JSON.parse(text), request);
    sendJson(response, 200, payload);
  } catch (error) {
    const message = controller.signal.aborted
      ? "The upstream NBA service timed out."
      : "The upstream NBA service could not be read.";
    sendJson(response, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}

function safeStaticPath(workspaceRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.split("/").some((segment) => segment.startsWith("."))) return null;
  const relative = decoded.replace(/^\/+/, "") || "index.html";
  const resolved = path.resolve(workspaceRoot, relative);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) return null;
  return resolved;
}

async function serveStatic(request, response, workspaceRoot, url) {
  let target = safeStaticPath(workspaceRoot, url.pathname);
  if (!target) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = path.join(target, "index.html");
    const extension = path.extname(target).toLowerCase();
    if (!ALLOWED_STATIC_EXTENSIONS.has(extension)) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    const body = await readFile(target);
    response.writeHead(200, commonHeaders(CONTENT_TYPES[extension] || "application/octet-stream"));
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    sendJson(response, 404, { error: "Not found." });
  }
}

export function createLineupLabServer(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot || DEFAULT_WORKSPACE_ROOT);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (url.pathname === NBA_STATS_PROXY_PATH) {
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      await proxyPlayerTotals(response, url, fetchImpl);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    await serveStatic(request, response, workspaceRoot, url);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  const port = Number(process.env.LINEUP_LAB_PORT || 4173);
  const host = process.env.LINEUP_LAB_HOST || "127.0.0.1";
  const server = createLineupLabServer();
  server.listen(port, host, () => {
    process.stdout.write(
      `DJ's Lineup Lab is available at http://${host}:${port}/prototypes/basketball-lineup-optimizer/\n`,
    );
  });
}
