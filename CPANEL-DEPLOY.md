# cPanel Deploy Automation

This project now includes a local FTPS deploy script:

- `scripts/deploy-cpanel-ftps.ps1`

It uploads only the files that changed since the last successful deploy, plus any current uncommitted changes in the working tree. It also attempts remote deletes for files that were removed locally.

## Why FTPS

The `curl.exe` build available on this machine supports `ftp` and `ftps`, but not `sftp`, so this workflow is built around an FTPS account from cPanel.

## 1. Create the local config

Copy:

- `scripts/cpanel-deploy.example.json`

to:

- `.deploy/cpanel-deploy.local.json`

Then fill in:

- `host`
- `username`
- `password`
- `remoteRoot`

`.deploy/` is already ignored by Git, so your credentials stay local.

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

## 4. Future incremental deploys

After the first full upload, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-cpanel-ftps.ps1
```

That only uploads:

- committed changes since the last deploy
- current local modified files
- current local untracked files

and deletes removed files remotely unless `-SkipDelete` is used.

## Optional flags

- `-DryRun` : preview actions only
- `-Full` : upload the full current project again
- `-SkipDelete` : do not delete files from the server
- `-ConfigPath` : use a different local config file

## Recommended cPanel setup

Create a dedicated FTP account in cPanel that points to:

- `public_html`

Then use that account in `.deploy/cpanel-deploy.local.json`.

For this site's current cPanel account, the FTP login is already jailed to the
live web root. That means `remoteRoot` should be:

```json
"/"
```

The cPanel FTP server also presents a shared-host certificate that does not
match `ftp.djshouseofcards-comics.com`. Because of that, this local config uses
explicit FTPS encryption with `allowInsecureCertificate` set to `true`. This
keeps the transfer encrypted, but skips hostname verification for the FTP
certificate.

## Typical local config path

```text
H:\My Drive\djshouseofcards-next-fixes-applied\.deploy\cpanel-deploy.local.json
```
