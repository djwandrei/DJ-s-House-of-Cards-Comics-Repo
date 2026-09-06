import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReadinessArgs } from './audit-lineup-scout-readiness.mjs';
import { createScoutStudioSource } from './lib/scout-studio-source.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const staticFiles = new Map([
  ['/tools/scout-studio/', ['tools/scout-studio/index.html', 'text/html; charset=utf-8']],
  ['/tools/scout-studio/index.html', ['tools/scout-studio/index.html', 'text/html; charset=utf-8']],
  ['/tools/scout-studio/studio.css', ['tools/scout-studio/studio.css', 'text/css']],
  ['/tools/scout-studio/studio.js', ['tools/scout-studio/studio.js', 'text/javascript']],
  ['/tools/scout-studio/studio-model.js', ['tools/scout-studio/studio-model.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/styles-mobile-overrides.css', ['styles-mobile-overrides.css', 'text/css']],
  ['/core.js', ['core.js', 'text/javascript']],
  ['/nav.js', ['nav.js', 'text/javascript']],
  ['/assets/dj-logo.png', ['assets/dj-logo.png', 'image/png']],
  ['/assets/fonts/inter-400.woff2', ['assets/fonts/inter-400.woff2', 'font/woff2']],
  ['/assets/fonts/inter-700.woff2', ['assets/fonts/inter-700.woff2', 'font/woff2']],
  ['/assets/fonts/bebas-neue-400.woff2', ['assets/fonts/bebas-neue-400.woff2', 'font/woff2']],
  ['/assets/fonts/lobster-two-700.woff2', ['assets/fonts/lobster-two-700.woff2', 'font/woff2']],
]);

export function createScoutStudioServer(source) {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const reply = (body, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    const port = server.address()?.port;
    // Exact host + origin rejects DNS rebinding and cross-site archive reads.
    const origin = `http://127.0.0.1:${port}`;
    if (request.headers.host !== `127.0.0.1:${port}`
      || (request.headers.origin && request.headers.origin !== origin)
      || request.headers['sec-fetch-site'] === 'cross-site') return reply({ error: 'Local preview only.' }, 403);
    if (request.method !== 'GET') return reply({ error: 'Read-only preview.' }, 405);
    if ((request.url || '').length > 2048) return reply({ error: 'Request is too large.' }, 414);
    try {
      const url = new URL(request.url, origin);
      if (['/index.html', '/tools/index.html', '/lineup-lab/index.html'].includes(url.pathname)) {
        response.writeHead(302, { Location: `https://www.djshouseofcards-comics.com${url.pathname}` });
        response.end(); return;
      }
      if (url.pathname === '/api/scout-studio/status') return reply(await source.status());
      if (url.pathname === '/api/scout-studio/roster' || url.pathname === '/api/scout-studio/chemistry') {
        const team = url.searchParams.get('team') || '', snapshot = url.searchParams.get('snapshot') || '';
        if (!/^t\d{1,2}$/.test(team) || !/^s[a-f0-9]{24}$/.test(snapshot)) return reply({ error: 'Refresh and choose a listed team.' }, 400);
        if (url.pathname.endsWith('/roster')) return reply(await source.roster(team, snapshot));
        const players = (url.searchParams.get('players') || '').split(',');
        if (players.length < 2 || players.length > 5 || players.some(id => !/^p\d{1,4}$/.test(id))
          || new Set(players).size !== players.length) return reply({ error: 'Choose two through five distinct players.' }, 400);
        return reply(await source.chemistry(team, snapshot, players));
      }
      const asset = staticFiles.get(url.pathname);
      if (!asset) return reply({ error: 'Not part of this isolated preview.' }, 404);
      const stream = createReadStream(path.join(root, asset[0]));
      stream.once('error', () => { if (!response.headersSent) reply({ error: 'Preview asset unavailable.' }, 404); else response.destroy(); });
      stream.once('open', () => { response.writeHead(200, { 'Content-Type': asset[1] }); stream.pipe(response); });
    } catch {
      // No filesystem paths, provider errors, model fields or raw source rows.
      return reply({ error: 'The requested current-package evidence is not ready. Check validation, then refresh the preview.' }, 503);
    }
  });
  return server;
}

export function parseStudioArgs(argv) {
  const args = [...argv];
  const index = args.indexOf('--port');
  let port = 4187;
  if (index !== -1) {
    const value = args[index + 1];
    if (!/^\d+$/.test(value || '')) throw new Error('Port must be an integer.');
    port = Number(value);
    args.splice(index, 2);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535.');
  const options = parseReadinessArgs(args);
  if (options.seasons.join(',') !== '2022,2023,2024,2025') throw new Error('This preview targets the incoming 2022–23 through 2025–26 package only.');
  return { ...options, port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseStudioArgs(process.argv.slice(2));
    const server = createScoutStudioServer(createScoutStudioSource(options));
    server.on('error', () => { process.stderr.write('Scout Studio could not start. Check the local port.\n'); process.exitCode = 1; });
    server.listen(options.port, '127.0.0.1', () => {
      process.stdout.write(`Read-only Scout Studio: http://127.0.0.1:${options.port}/tools/scout-studio/\n`);
      process.stdout.write('Uses only the explicitly selected package. No Supabase calls, uploads, raw archive serving or automatic fallback.\n');
    });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
