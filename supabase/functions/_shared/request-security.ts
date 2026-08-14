type SupabaseAdmin = {
  rpc: (name: string, params: Record<string, unknown>) => PromiseLike<{
    error?: { message?: string } | null;
  }>;
};

export function requestIp(request: Request) {
  const forwarded = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || String(request.headers.get('cf-connecting-ip') || '').trim() || 'unknown';
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function requestFingerprint(request: Request, scope: string, discriminator = '') {
  const normalizedScope = String(scope || 'public-request').trim().toLowerCase();
  const normalizedDiscriminator = String(discriminator || '').trim().toLowerCase();
  return await sha256Hex(normalizedDiscriminator
    ? [normalizedScope, 'request', requestIp(request), normalizedDiscriminator].join(':')
    : [normalizedScope, 'ip', requestIp(request)].join(':'));
}

async function identityFingerprint(scope: string, discriminator: string) {
  return await sha256Hex([
    String(scope || 'public-request').trim().toLowerCase(),
    'identity',
    String(discriminator || '').trim().toLowerCase()
  ].join(':'));
}

async function consumeSlot(
  admin: SupabaseAdmin,
  scope: string,
  fingerprint: string,
  limit: number,
  windowSeconds: number
) {
  const { error } = await admin.rpc('take_public_submission_slot', {
    p_scope: scope,
    p_fingerprint: fingerprint,
    p_limit: Math.max(1, Math.floor(limit)),
    p_window_seconds: Math.max(60, Math.floor(windowSeconds))
  });
  if (error) throw new Error(error.message || 'Public request rate limit failed.');
}

export async function enforcePublicRateLimits(
  admin: SupabaseAdmin,
  request: Request,
  options: {
    scope: string;
    discriminator?: string;
    perIpLimit: number;
    perIdentityLimit?: number;
    windowSeconds?: number;
  }
) {
  const windowSeconds = options.windowSeconds || 3600;
  const ipFingerprint = await requestFingerprint(request, options.scope);
  const normalizedIdentityFingerprint = options.discriminator
    ? await identityFingerprint(options.scope, options.discriminator)
    : ipFingerprint;
  const scopedRequestFingerprint = options.discriminator
    ? await requestFingerprint(request, options.scope, options.discriminator)
    : ipFingerprint;
  const checks = [consumeSlot(
    admin,
    `${options.scope}:ip`,
    ipFingerprint,
    options.perIpLimit,
    windowSeconds
  )];
  if (options.discriminator && options.perIdentityLimit) {
    checks.push(consumeSlot(
      admin,
      `${options.scope}:identity`,
      normalizedIdentityFingerprint,
      options.perIdentityLimit,
      windowSeconds
    ));
  }
  await Promise.all(checks);
  return {
    ipFingerprint,
    identityFingerprint: normalizedIdentityFingerprint,
    requestFingerprint: scopedRequestFingerprint
  };
}
