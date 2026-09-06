# Lineup Lab cPanel release — 20260905i

Completed September 5, 2026; final source snapshot check at 22:37 CDT.
Public page: https://www.djshouseofcards-comics.com/lineup-lab/

## Scope and deployment

- Uploaded exactly 27 generated Lineup Lab files from a frozen local copy:
  26 assets first, followed by `lineup-lab/index.html` only after asset parity
  passed. The separate manifests are
  `scripts/cpanel-lineup-lab-20260905i-assets.txt` and
  `scripts/cpanel-lineup-lab-20260905i-pages.txt`.
- Includes historical model v7 and the tested generated guided workflow and
  analytical-panel dependencies. Private Scout packages are not included.
- Used the established certificate-verified FTPS deployment script and the
  existing environment-file credentials. Credentials were not printed or
  included in the release copy.
- Zero server deletes. No Git commit/push, Supabase write, storefront/catalog
  upload, shared-cache modification, or global deployment-state advancement.
- The builder's independent Lineup Lab revision is `20260905i`; all 27 files
  matched generated source again after deployment. No released local file had
  changed since the copy was frozen.

## Verification

- All 301 focused tests passed before deployment.
- Site integrity: zero issues. Secret audit passed.
- Both upload manifests received a dry run and remote audit.
- All 26 assets and the HTML page matched the release bytes over public HTTPS,
  including cache-busted verification; no missing release files remained.
- Live Chromium loaded the Minnesota Timberwolves 2025–26 roster (21 players)
  through the existing public data connection and completed a starting-five
  exact solve. This was live data, not a mocked backend.
- Live checks passed for locks, invalid rules, restored drafts, keyboard focus,
  rotation-minute validation/cancellation, back/forward navigation, and reduced
  motion. Desktop 1440px and mobile 390px screenshots were inspected; additional
  overflow checks passed at 320, 760, 900, and 1024px.
- No browser runtime exceptions or failed required Lineup Lab assets were
  observed. The in-app browser connector failed to initialize, so the existing
  Chromium workflow harness was adapted in the release copy for live checks.
- Private Scout authorization, payments, account writes, and a complete live
  rotation search were not exercised. Existing model tests cover rotation
  calculation; this deployment does not certify a new private Scout package.

## Retained rollback and evidence

Frozen files, pre-release public response backups, SHA-256 comparison reports,
the live check script/report, and screenshots remain outside the repository:

`C:\Users\djwan\AppData\Local\Temp\djhc-lineup-release-20260905i-96cfd315ac274fc383bba96f682e6eda`

Twenty previously existing public files were backed up under `remote-before/`;
seven assets were new. A rollback should restore the reviewed earlier bytes,
assets before HTML, without deleting the newly added assets. Temporary-folder
retention depends on the operating system; these are not a permanent archive.
