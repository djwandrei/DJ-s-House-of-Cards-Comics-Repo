export type SiteAdminIdentity = {
  id: string;
  email: string;
};

export class SiteAdminError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SiteAdminError';
    this.status = status;
  }
}

export async function requireSiteAdmin(
  request: Request,
  admin: {
    auth: { getUser: (jwt: string) => Promise<{ data?: { user?: { id?: string; email?: string } | null }; error?: unknown }> };
    from: (table: string) => any;
  }
): Promise<SiteAdminIdentity> {
  const jwt = String(request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new SiteAdminError('Sign in as a site administrator to continue.', 401);
  const { data, error } = await admin.auth.getUser(jwt);
  const id = String(data?.user?.id || '').trim();
  const email = String(data?.user?.email || '').trim().toLowerCase();
  if (error || !id || !email) throw new SiteAdminError('Your administrator session is invalid or expired.', 401);
  const { data: registryEntry, error: registryError } = await admin
    .from('site_admins')
    .select('id')
    .eq('email', email)
    .eq('enabled', true)
    .maybeSingle();
  if (registryError) throw new SiteAdminError('Administrator authorization could not be verified.', 503);
  if (!registryEntry) throw new SiteAdminError('This account is not authorized to administer the site.', 403);
  return { id, email };
}
