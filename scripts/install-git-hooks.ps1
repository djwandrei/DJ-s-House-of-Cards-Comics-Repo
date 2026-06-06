[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
& git -C $repoRoot config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) {
  throw "Could not configure Git hooks."
}

Write-Output "Configured repository Git hooks from .githooks."
