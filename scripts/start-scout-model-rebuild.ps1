param(
  [Parameter(Mandatory = $true)][string]$Manifest,
  [Parameter(Mandatory = $true)][string]$PackageValidation,
  [Parameter(Mandatory = $true)][string]$SourceValidation,
  [Parameter(Mandatory = $true)][string]$ArchiveDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$SummaryOverlay,
  [string]$Seasons = '2022,2023,2024,2025',
  [switch]$Offline,
  [ValidateRange(1, 2147483647)][int]$RequestBudget
)

$ErrorActionPreference = 'Stop'
if ($Offline -and $PSBoundParameters.ContainsKey('RequestBudget')) { throw 'Offline builds make no requests; omit RequestBudget.' }
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskPrivateRoot = [IO.Path]::GetFullPath((Join-Path $taskRoot 'outputs')).TrimEnd('\')
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$taskOverlay = [IO.Path]::GetFullPath($SummaryOverlay)
foreach ($taskTarget in @($taskOutput, $taskOverlay)) {
  if (-not $taskTarget.StartsWith("$taskPrivateRoot\", [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output and Summary overlay must be inside the private outputs directory.'
  }
}
if (Test-Path -LiteralPath $taskOutput) { throw 'Output already exists; choose a new package version.' }
if (-not $Offline -and [string]::IsNullOrWhiteSpace($env:SPORTRADAR_NBA_API_KEY)) {
  throw 'Set SPORTRADAR_NBA_API_KEY in the launcher process; no credential is saved by this script.'
}

$taskLogs = Join-Path (Split-Path -Parent $taskOutput) 'rebuild-logs'
New-Item -ItemType Directory -Path $taskLogs -Force | Out-Null
$taskRun = 'model-evidence-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$taskStdout = Join-Path $taskLogs "$taskRun.stdout.log"
$taskStderr = Join-Path $taskLogs "$taskRun.stderr.log"
# Offline is an explicit, network-free entry point. It reuses only existing
# source/overlay files and exposes incomplete official coverage in the new
# manifest. It cannot retry a rate-limited provider or claim the refresh ended.
$taskEntry = if ($Offline) { 'rebuild-scout-model-evidence.mjs' } else { 'refresh-scout-model-summaries.mjs' }
$taskArguments = @(
  '--max-old-space-size=8192', (Join-Path $PSScriptRoot $taskEntry),
  '--manifest', (Resolve-Path -LiteralPath $Manifest).Path,
  '--package-validation', (Resolve-Path -LiteralPath $PackageValidation).Path,
  '--source-validation', (Resolve-Path -LiteralPath $SourceValidation).Path,
  '--archive-dir', (Resolve-Path -LiteralPath $ArchiveDirectory).Path,
  '--output-dir', $taskOutput,
  '--summary-overlay', $taskOverlay,
  '--seasons', $Seasons
)
if ($PSBoundParameters.ContainsKey('RequestBudget')) { $taskArguments += @('--request-budget', [string]$RequestBudget) }
# Credentials are inherited in the process environment, never command-line
# arguments, printed output, files, or source. Closing the assistant turn does
# not terminate this hidden worker; downloads/checkpoints support resumption.
$taskArgumentString = ($taskArguments | ForEach-Object {
  if ($_ -match '"') { throw 'Arguments must not contain a double quote.' }
  '"' + $_ + '"'
}) -join ' '
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskWorker = Start-Process -FilePath $taskNode -ArgumentList $taskArgumentString -WorkingDirectory $taskRoot `
  -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr -PassThru
[pscustomobject]@{
  status = 'started'
  mode = $(if ($Offline) { 'offline-additive-build' } else { 'summary-import-only' })
  processId = $taskWorker.Id
  outputDirectory = $taskOutput
  summaryOverlay = $taskOverlay
  stdoutLog = $taskStdout
  stderrLog = $taskStderr
  credentials = 'process-environment-only'
  liveWrites = 'none'
} | ConvertTo-Json
