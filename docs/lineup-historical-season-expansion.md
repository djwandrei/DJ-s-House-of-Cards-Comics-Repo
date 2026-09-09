# Lineup Lab: historical-season expansion framework

This framework extends the current six-season 2020-26 base build with the
2017-18, 2018-19, and 2019-20 raw archives once each one is complete. It does
not append new fitted values to an existing package: additional seasons change
the historical sample, priors, calibration, uncertainty, and validation scope.
The correct result is therefore a new private `2017-26` package that preserves
the current `2020-26` package as a comparison baseline until promotion gates
pass.

## Storage model

`scripts/prepare-expanded-scout-archive.mjs` creates a small linked archive
view, not a second raw archive. Game files are hard-linked to the validated
source archives (the filtered manifests and composition plan are written into
the view):

```
data-2017-2025-trial-linked/
  2017/  # game files hard-linked from data-2017-2019-trial/2017/games
  2018/  # game files hard-linked from data-2017-2019-trial/2018/games
  2019/  # game files hard-linked from data-2017-2019-trial/2019/games
  2020/  # game files hard-linked from data-2020-2025-trial-composed-20260906-v1-six-season/2020/games
  ...
  2025/  # game files hard-linked from data-2020-2025-trial-composed-20260906-v1-six-season/2025/games
```

The game payload is not copied; hard-link verification binds each selected file
to its source bytes. The script refuses incomplete, duplicate, unverified-inventory, or
non-trial source seasons, and never overwrites an existing output directory.

## Promotion sequence

Do not run this sequence while the historical downloader is still writing.
After all three added seasons are complete, validate the new raw archive with
the full v4 source validator first. Then build the linked view:

```powershell
$root = '.\outputs\01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e\nba-last-five-seasons'
node .\scripts\prepare-expanded-scout-archive.mjs `
  --source-root "$root\data-2017-2019-trial" `
  --source-root "$root\data-2020-2025-trial-composed-20260906-v1-six-season" `
  --expect-seasons 2017,2018,2019,2020,2021,2022,2023,2024,2025 `
  --reference-package "$root\scout-analytics\2020-26-final-20260907-v2-comprehensive-model-evidence\nba-scout-analytics-2020-26.json" `
  --output-dir "$root\data-2017-2025-trial-linked"
```

Next, use `scripts/attest-composed-scout-source.mjs` with the newly passed
2017-19 source-validation report and the existing 2020-25 source-attestation
report. Its hash binding is mandatory before deriving the expanded package.
Finally run the normal derivation and package validator with all season start
years `2017,2018,2019,2020,2021,2022,2023,2024,2025`, writing a new
`2017-26` directory. Summary/box-score reconciliation must also cover the
added years before the package is promoted to Lineup Lab or deployed.

Before promotion, compare the rebuilt package directly with the completed
`2020-26` package. The checker requires the same schema/metrics version,
metric definitions, analytic tables, available analytic families, trial-source
provenance, and per-season source-file integrity. It fails closed if any
existing analytic surface is omitted; historical coverage may still be marked
as unavailable or partial only where the provider data genuinely lacks it.

```powershell
node .\scripts\check-scout-package-metric-contract.mjs `
  --reference-package "$root\scout-analytics\2020-26-final-20260907-v2-comprehensive-model-evidence\nba-scout-analytics-2020-26.json" `
  --candidate-package "$root\scout-analytics\2017-26-final-YYYYMMDD-v1\nba-scout-analytics-2017-26.json" `
  --expect-seasons 2017,2018,2019,2020,2021,2022,2023,2024,2025 `
  --output-report "$root\scout-analytics\2017-26-final-YYYYMMDD-v1\metric-contract-report.json"
```

The active `2020-26` reference is the validated
`2020-26-final-20260907-v2-comprehensive-model-evidence` output. The expanded
`2017-26` package remains private and a comparison candidate until its source,
metric-contract, and integration gates pass; this framework deliberately leaves
the active public package untouched.
