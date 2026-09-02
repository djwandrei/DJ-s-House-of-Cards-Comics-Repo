[CmdletBinding()]
param(
  [ValidateRange(1, 100)]
  [int]$Limit = 50,
  [ValidateRange(1, 2)]
  [int]$Concurrency = 2,
  [switch]$Headless,
  [switch]$ResumeAfterChallenge
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node)) { throw "Node.js was not found at $node." }
$worker = Join-Path $PSScriptRoot 'capture-pro-football-reference-headshots.mjs'
$logDirectory = Join-Path $repoRoot 'outputs\sports-reference-media-cache\nfl\scheduler-logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdoutLog = Join-Path $logDirectory "capture-$timestamp.stdout.log"
$stderrLog = Join-Path $logDirectory "capture-$timestamp.stderr.log"
Push-Location $repoRoot
try {
  # Node may emit deprecation notices to stderr even on success. Keep those in
  # the task log without letting PowerShell's Stop preference turn them into a
  # failed Scheduled Task result.
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $workerArguments = @($worker, '--limit', $Limit, '--concurrency', $Concurrency)
    if ($Headless) { $workerArguments += '--headless' }
    if ($ResumeAfterChallenge) { $workerArguments += '--resume-after-challenge' }
    & $node @workerArguments 1>> $stdoutLog 2>> $stderrLog
    $workerExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($workerExitCode -ne 0) { exit $workerExitCode }
} finally {
  Pop-Location
}
