[CmdletBinding()]
param(
  [ValidateSet('mlb', 'nfl', 'both')]
  [string]$Sport = 'both',
  [ValidateRange(1920, 2200)]
  [int]$SeasonStart = 1980,
  [ValidateRange(1920, 2200)]
  [int]$SeasonEnd = (Get-Date).Year,
  [switch]$Apply,
  [switch]$CacheOnly,
  [switch]$Background
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeRuntime = (Get-Command node -ErrorAction Stop).Source
$worker = Join-Path $PSScriptRoot 'import-sports-reference-history.mjs'
$outputRoot = Join-Path $repoRoot 'outputs\sports-reference-history'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

$arguments = @(
  $worker,
  '--sport', $Sport,
  '--season-start', [string]$SeasonStart,
  '--season-end', [string]$SeasonEnd
)
if ($Apply) { $arguments += @('--apply', '--analytics') }
if ($CacheOnly) { $arguments += @('--cache-only') }

$previousSourceConfirmation = $env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED
$previousSourcePermission = $env:SPORTS_REFERENCE_SOURCE_PERMISSION_CONFIRMED
$previousWriteConfirmation = $env:SPORTS_ANALYTICS_ALLOW_WRITE
$previousTarget = $env:SPORTS_ANALYTICS_SUPABASE_URL
try {
  $env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED = 'confirmed'
  if ($CacheOnly) { $env:SPORTS_REFERENCE_SOURCE_PERMISSION_CONFIRMED = 'confirmed' }
  if ($Apply) {
    $env:SPORTS_ANALYTICS_ALLOW_WRITE = 'confirmed'
    $env:SPORTS_ANALYTICS_SUPABASE_URL = 'https://rioxosivyhczxshhmaen.supabase.co'
  }
  if ($Background) {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdout = Join-Path $outputRoot "worker-$timestamp.stdout.log"
    $stderr = Join-Path $outputRoot "worker-$timestamp.stderr.log"
    $process = Start-Process -FilePath $nodeRuntime -ArgumentList $arguments -WorkingDirectory $repoRoot `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    [pscustomobject]@{
      ProcessId = $process.Id
      Sport = $Sport
      SeasonStart = $SeasonStart
      SeasonEnd = $SeasonEnd
      Apply = [bool]$Apply
      CacheOnly = [bool]$CacheOnly
      StandardOutput = $stdout
      StandardError = $stderr
    }
    return
  }
  & $nodeRuntime @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if ($null -eq $previousSourceConfirmation) { Remove-Item Env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED -ErrorAction SilentlyContinue } else { $env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED = $previousSourceConfirmation }
  if ($null -eq $previousSourcePermission) { Remove-Item Env:SPORTS_REFERENCE_SOURCE_PERMISSION_CONFIRMED -ErrorAction SilentlyContinue } else { $env:SPORTS_REFERENCE_SOURCE_PERMISSION_CONFIRMED = $previousSourcePermission }
  if ($null -eq $previousWriteConfirmation) { Remove-Item Env:SPORTS_ANALYTICS_ALLOW_WRITE -ErrorAction SilentlyContinue } else { $env:SPORTS_ANALYTICS_ALLOW_WRITE = $previousWriteConfirmation }
  if ($null -eq $previousTarget) { Remove-Item Env:SPORTS_ANALYTICS_SUPABASE_URL -ErrorAction SilentlyContinue } else { $env:SPORTS_ANALYTICS_SUPABASE_URL = $previousTarget }
}
