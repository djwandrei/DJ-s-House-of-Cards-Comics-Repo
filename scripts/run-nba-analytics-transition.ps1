[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$VerifyOnly,
  [switch]$SkipHash,
  [string]$ReportDirectory = ''
)

$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$pnpm = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$node = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$sourceProjectRef = 'gkqdymnmczabcggvigce'
$targetProjectRef = 'fbbmuqbdpgsmvnezowwn'
$analyticsWorkdir = Join-Path $workspaceRoot 'supabase-analytics'
$copier = Join-Path $PSScriptRoot 'migrate-nba-analytics-data.mjs'
if ([string]::IsNullOrWhiteSpace($ReportDirectory)) {
  $ReportDirectory = Join-Path $workspaceRoot 'outputs\nba-analytics-transition'
}

function Get-ProjectServiceRoleKey([string]$ProjectRef) {
  $keys = (& $pnpm dlx supabase projects api-keys --project-ref $ProjectRef --reveal --output json) | ConvertFrom-Json
  $serviceRole = @($keys | Where-Object { $_.name -eq 'service_role' -and $_.type -eq 'legacy' }) | Select-Object -First 1
  if (-not $serviceRole -or [string]::IsNullOrWhiteSpace([string]$serviceRole.api_key)) {
    throw "The Supabase service-role key for $ProjectRef could not be resolved."
  }
  return [string]$serviceRole.api_key
}

if ($Apply) {
  & $pnpm dlx supabase db push --workdir $analyticsWorkdir --project-ref $targetProjectRef --include-all --yes
  if ($LASTEXITCODE -ne 0) { throw 'The dedicated NBA Analytics schema did not apply successfully.' }
}

$env:DJHC_NBA_ANALYTICS_SOURCE_SERVICE_ROLE_KEY = Get-ProjectServiceRoleKey $sourceProjectRef
$env:DJHC_NBA_ANALYTICS_TARGET_SERVICE_ROLE_KEY = Get-ProjectServiceRoleKey $targetProjectRef
try {
  $arguments = @($copier, '--report-directory', $ReportDirectory)
  if ($Apply) { $arguments += '--apply' }
  if ($VerifyOnly) { $arguments += '--verify-only' }
  if ($SkipHash) { $arguments += '--skip-hash' }
  & $node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'NBA analytics copy or verification did not complete successfully.' }
} finally {
  Remove-Item Env:DJHC_NBA_ANALYTICS_SOURCE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:DJHC_NBA_ANALYTICS_TARGET_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue
}
