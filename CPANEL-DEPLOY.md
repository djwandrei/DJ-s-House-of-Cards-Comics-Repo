# cPanel Deploy Automation

This project now includes a local FTPS deploy script:

- `scripts/deploy-cpanel-ftps.ps1`

It uploads only the files that changed since the last successful deploy, plus any current uncommitted changes in the working tree. It also attempts remote deletes for files that were removed locally, but asset deletion is blocked unless it is explicitly authorized.

## Why FTPS

The `curl.exe` build available on this machine supports `ftp` and `ftps`, but not `sftp`, so this workflow is built around an FTPS account from cPanel.

## 1. Create the local config

Copy:

- `scripts/cpanel-deploy.example.json`

to:

- `.deploy/cpanel-deploy.local.json`

Then fill in:

- `host`
- `remoteRoot`

If the FTP hostname needs to stay the public certificate name but connect to a
specific server IP, set optional `resolveHost` to that IP. Leave it blank or
omit it for normal DNS resolution.


## 2. First dry run

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -DryRun -Full
```

That shows what would be uploaded without touching the server.

## 3. First full upload

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -Full
```

That uploads the whole current site and saves the deployed commit in:

- `.deploy/cpanel-deploy.state.json`

If this folder is a copied export without a `.git` directory, `-Full` and
`-PathList` still work as manual upload modes. Incremental deploys require the
real Git checkout so the script can compare the last deployed commit with the
current commit.

## 4. Future incremental deploys

After the first full upload, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1
```

That uploads:

- committed changes since the last deploy
- current local modified files
- current local untracked files

It deletes removed non-asset files unless `-SkipDelete` is used. Removed files
under `assets/` stay on cPanel unless `-AllowAssetDelete` is explicitly used.
Whenever deletions are skipped, the deploy checkpoint is not advanced, so the
pending cleanup remains visible for a later audited deploy.

The deploy allow-list intentionally skips local build/source folders and common
workspace noise such as `desktop.ini`, `.pyc`, logs, spreadsheets, CSVs, zips,
and local state files even if those files live under `assets/`.

Removed files under `assets/` are preserved by default because the live
Supabase catalog, cached pages, or older catalog snapshots may still reference
them. Use `-AllowAssetDelete` only after a separate live-reference audit.

The live Supabase media paths can be compared with the deploy-synced static
catalog without making changes:

```powershell
node .\scripts\sync-supabase-image-paths.mjs
```

The script patches only `image` and `image_gallery`, refuses replacements whose
local targets are missing, and requires both `--apply` and a process-scoped
`SUPABASE_SERVICE_ROLE_KEY` before it writes:

```powershell
node .\scripts\sync-supabase-image-paths.mjs --apply
```

To audit whether Supabase contains rows that are absent from `products.json`,
run:

```powershell
node .\scripts\hard-delete-supabase-products-not-in-catalog.mjs
```

After reviewing the generated report, add `--apply` to reconcile local catalog
content and permanently delete remote-only rows. Apply mode writes a complete
remote backup first, preserves live operational sale/reservation metadata, and
uses the authenticated, audited Edge deletion workflow for each removed row.
It does not mirror stale sold state from the static catalog.

## Reviewed static release

To deploy the current reviewed static site files without uploading the large
image tree, use the reviewed path list:

```powershell
node .\scripts\audit-cpanel-release.mjs .\scripts\cpanel-current-static-no-assets-release.txt
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -DryRun -PathList .\scripts\cpanel-current-static-no-assets-release.txt
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1 -PathList .\scripts\cpanel-current-static-no-assets-release.txt
```

Path-list deploys never perform deletes and do not advance the global
`lastDeployedCommit` checkpoint. This keeps later full/incremental deploy
comparisons honest.

## Optional flags

- `-DryRun` : preview actions only
- `-Full` : upload the full current project again
- `-SkipDelete` : do not delete files from the server
- `-AllowAssetDelete` : allow reviewed files under `assets/` to be deleted, including an explicit nondeployable archive in a delete path list; it never permits archive uploads
- `-PathList` : upload only reviewed paths; never delete or update global deploy state
- `-DeletePathList` : permanently delete only reviewed, canonical relative paths; run with `-DryRun` first. This mode never updates the global deploy state.
- `-ListRemote` : read-only FTPS directory listing for `public_html`; pair with `-RemoteListPath <canonical-relative-directory>` to inspect a subdirectory.
- `-BackupRemotePath` plus `-BackupDestination` : backup one canonical remote file to a new absolute local path outside the repository. This is a separate, backup-only mode that does not deploy, delete, or update state.
- `-ConfigPath` : use a different local config file

`-DeletePathList` is for a separately audited cleanup, not routine deployment.
It rejects absolute and traversal paths, still blocks `assets/` unless
`-AllowAssetDelete` is supplied, and does not create a remote backup or trash
copy. Preserve a backup and verify each candidate is unreferenced before
running it without `-DryRun`.

Use the backup-only mode before a live cleanup deletion. It downloads to an
owned temporary file and atomically moves it into a previously unused local
destination only after the FTPS transfer succeeds, then reports the byte count
and SHA-256. It never overwrites an existing local file.

For a cleanup inventory, use `-ListRemote` with the same process-scoped FTPS
credentials used by deployment. It only lists one directory per call; inspect
non-asset directories individually and never treat a directory listing alone
as deletion evidence.

## Recommended cPanel setup

Create a dedicated FTP account in cPanel that points to:

- `public_html`

Then use that account in `.deploy/cpanel-deploy.local.json`.

Keep `allowInsecureCertificate` set to `false`. If the FTPS certificate does
not validate, fix the hostname or certificate with the hosting provider instead
of disabling verification.

For non-interactive automation, inject `CPANEL_FTPS_USERNAME` and
`CPANEL_FTPS_PASSWORD` from a trusted secret store for that one process. Never
put them in this repository, a PowerShell profile, a command line, or a Codex
thread.
