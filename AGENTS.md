# Repository Security Rules

- Never print, quote, summarize, or copy the contents of `.deploy/`, `.env*`,
  credential files, private keys, or secret-store output.
- Use `scripts/audit-secrets.ps1` for audits because it reports locations
  without echoing matched values.
- cPanel credentials must come from the deploy script's secure prompt or from
  one-process secret-store injection. Never store cPanel usernames or passwords
  in this workspace.
- Stripe secrets, webhook secrets, and the Supabase service-role key belong only
  in Supabase-managed secrets. Never put them in browser code, docs, commands,
  screenshots, logs, or Codex messages.
- Never pass passwords or service-role keys as command-line arguments. Use a
  secure prompt or one-process injection from a trusted secret store.
- `backend-config.js` is public browser configuration. It may contain only a
  Supabase publishable/anon key, never a secret or service-role key.
- Before committing or pushing, run:

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\audit-secrets.ps1
  ```

- Treat any discovered real secret as compromised: remove it, rotate it at the
  provider, and audit reachable Git history before pushing again.
