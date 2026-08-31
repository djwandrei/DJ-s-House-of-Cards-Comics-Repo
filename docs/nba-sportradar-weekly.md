# Weekly Sportradar NBA updater

`scripts/download-nba-sportradar-weekly.mjs` is the local script equivalent of
the Basketball Reference weekly updater. It keeps a resumable per-game gzip
checkpoint under `outputs/nba-sportradar-weekly`, defaults to 200 new games per
run, and never writes Supabase.

The Windows launcher is:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-nba-sportradar-weekly.ps1
```

Before scheduling it, provide the following only to the process or scheduled
task environment; never put a key in this document, a command committed to Git,
or a report:

```text
SPORTRADAR_WEEKLY_ALLOW_NETWORK=confirmed
SPORTRADAR_NBA_LICENSE_CONFIRMED=confirmed
SPORTRADAR_NBA_LICENSE_REFERENCE=<non-secret approval reference>
SPORTRADAR_NBA_API_KEY=<provider key>
SPORTRADAR_NBA_ACCESS_LEVEL=production
```

The script reuses completed game files, rate-limits requests, records source
metadata and failures in `manifest.json`/`report.json`, and stops on provider
authorization, quota, or throttling responses. A scheduler entry is not
registered automatically; create one only after confirming the provider plan,
rights, and credential storage on the host that will run it.
