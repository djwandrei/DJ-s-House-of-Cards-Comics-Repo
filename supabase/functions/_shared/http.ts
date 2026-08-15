const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_JSON_BODY_BYTES = 64 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body is too large. Maximum size is ${limit} bytes.`);
    this.name = 'RequestBodyTooLargeError';
  }
}

export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
) {
  const timeout = Math.max(1_000, Math.min(60_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  return fetch(input, {
    ...init,
    signal: init.signal || AbortSignal.timeout(timeout)
  });
}

async function readBodyBytes(request: Request, maxBytes: number) {
  const limit = Math.max(1024, Math.floor(Number(maxBytes) || DEFAULT_JSON_BODY_BYTES));
  const lengthHeader = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(lengthHeader) && lengthHeader > limit) {
    throw new RequestBodyTooLargeError(limit);
  }

  if (!request.body) throw new Error('Missing request body.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new RequestBodyTooLargeError(limit);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readTextBody(
  request: Request,
  maxBytes = DEFAULT_JSON_BODY_BYTES
) {
  return new TextDecoder().decode(await readBodyBytes(request, maxBytes));
}

export async function readJsonBody<T = Record<string, unknown>>(
  request: Request,
  maxBytes = DEFAULT_JSON_BODY_BYTES
): Promise<T> {
  const text = (await readTextBody(request, maxBytes)).trim();
  if (!text) throw new Error('Missing request body.');
  return JSON.parse(text) as T;
}
