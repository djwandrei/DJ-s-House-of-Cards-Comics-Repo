[CmdletBinding()]
param(
  [ValidateRange(3000, 60000)]
  [int]$RequestDelayMs = 3200,

  [ValidateRange(1, 5000)]
  [int]$MediaRequestLimit = 1000,

  [ValidateRange(1, 500)]
  [int]$MediaBatchSize = 100,

  [ValidateRange(10, 3600)]
  [int]$RetryDelaySeconds = 300
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$checkpointPath = Join-Path $repoRoot 'outputs\nba-basketball-reference-import-checkpoints\media-bref-1980-2026-regular-playoffs-all-teams.json'
$logDirectory = Join-Path $repoRoot 'outputs\nba-media-backfill-runner'
$logPath = Join-Path $logDirectory 'historical-media-backfill.log'
$statusPath = Join-Path $logDirectory 'historical-media-backfill-status.json'
$nodePath = (Get-Command node -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

# A named mutex prevents an interactive Codex run, a scheduled-task restart,
# and a logon trigger from writing the same checkpoint at the same time. The
# importer itself is idempotent, but its checkpoint is a whole JSON document,
# so one writer is the safest and clearest operating contract.
$runnerMutex = [System.Threading.Mutex]::new($false, 'Local\DJHCNBAHistoricalMediaBackfill')
$ownsMutex = $false

function Write-RunnerStatus {
  param(
    [Parameter(Mandatory)] [string]$State,
    [string]$Message = '',
    [int]$Chunk = 0,
    [int]$ExitCode = 0
  )

  $checkpoint = $null
  if (Test-Path -LiteralPath $checkpointPath) {
    try { $checkpoint = Get-Content -Raw -LiteralPath $checkpointPath | ConvertFrom-Json } catch { $checkpoint = $null }
  }
  $payload = [ordered]@{
    state = $State
    message = $Message
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
    process_id = $PID
    chunk = $Chunk
    exit_code = $ExitCode
    checkpoint_status = if ($checkpoint) { [string]$checkpoint.status } else { '' }
    checkpoint_updated_at = if ($checkpoint) { [string]$checkpoint.updatedAt } else { '' }
  }
  $payload | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
  ('[{0}] {1}: {2}' -f $payload.updated_at, $State, $Message) | Add-Content -LiteralPath $logPath -Encoding utf8
}

try {
  $ownsMutex = $runnerMutex.WaitOne(0)
  if (-not $ownsMutex) {
    Write-RunnerStatus -State 'already-running' -Message 'Another historical media backfill process owns the runner mutex.'
    exit 0
  }

  Set-Location -LiteralPath $repoRoot
  $env:BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED = 'confirmed'
  $env:NBA_WEEKLY_UPDATE_ALLOW_WRITE = 'confirmed'

  $chunk = 0
  $consecutiveFailures = 0
  while ($true) {
    $chunk += 1
    Write-RunnerStatus -State 'running' -Message "Starting resumable media chunk $chunk." -Chunk $chunk

    # The importer writes confirmed media in bounded transactions and updates
    # its checkpoint after each terminal decision. If Windows or this process
    # stops between transactions, the next run reuses cached pages and resumes
    # safely without --new-run or --refresh-cache.
    $importArguments = @(
      '.\scripts\import-nba-basketball-reference.mjs',
      '--apply',
      '--media-only',
      '--season-start', '1980',
      '--season-end', '2026',
      '--phase', 'both',
      '--request-delay-ms', [string]$RequestDelayMs,
      '--media-request-limit', [string]$MediaRequestLimit,
      '--media-batch-size', [string]$MediaBatchSize
    )
    $stdoutPath = Join-Path $logDirectory 'current-importer-stdout.log'
    $stderrPath = Join-Path $logDirectory 'current-importer-stderr.log'

    # Windows PowerShell can promote a native process's stderr records to a
    # terminating PowerShell exception when ErrorActionPreference is Stop.
    # Start-Process keeps stdout/stderr as ordinary UTF-8 files, allowing this
    # loop to inspect the real exit code and retry rather than accidentally
    # terminating the scheduled task on a transient provider/CLI problem.
    $importProcess = Start-Process `
      -FilePath $nodePath `
      -ArgumentList $importArguments `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -Wait `
      -PassThru
    $importExitCode = $importProcess.ExitCode

    $utf8 = [System.Text.UTF8Encoding]::new($false)
    foreach ($streamPath in @($stdoutPath, $stderrPath)) {
      if (-not (Test-Path -LiteralPath $streamPath)) { continue }
      $streamText = [System.IO.File]::ReadAllText($streamPath, $utf8)
      if ($streamText) {
        [System.IO.File]::AppendAllText($logPath, $streamText, $utf8)
        if (-not $streamText.EndsWith([Environment]::NewLine)) {
          [System.IO.File]::AppendAllText($logPath, [Environment]::NewLine, $utf8)
        }
      }
    }

    if ($importExitCode -ne 0) {
      $consecutiveFailures += 1
      Write-RunnerStatus -State 'retry-wait' -Message "Importer exited $importExitCode (failure $consecutiveFailures); retrying from checkpoint in $RetryDelaySeconds seconds." -Chunk $chunk -ExitCode $importExitCode
      Start-Sleep -Seconds $RetryDelaySeconds
      continue
    }

    $consecutiveFailures = 0
    if (-not (Test-Path -LiteralPath $checkpointPath)) {
      Write-RunnerStatus -State 'retry-wait' -Message "Checkpoint was not found; retrying in $RetryDelaySeconds seconds." -Chunk $chunk -ExitCode 1
      Start-Sleep -Seconds $RetryDelaySeconds
      continue
    }

    $checkpoint = Get-Content -Raw -LiteralPath $checkpointPath | ConvertFrom-Json
    if ($checkpoint.status -eq 'completed') {
      Write-RunnerStatus -State 'completed' -Message 'Historical NBA media backfill completed.' -Chunk $chunk
      exit 0
    }
    if ($checkpoint.status -ne 'paused') {
      Write-RunnerStatus -State 'retry-wait' -Message "Unexpected checkpoint status '$($checkpoint.status)'; retrying in $RetryDelaySeconds seconds." -Chunk $chunk -ExitCode 1
      Start-Sleep -Seconds $RetryDelaySeconds
    }
  }
}
catch {
  Write-RunnerStatus -State 'failed' -Message ([string]$_.Exception.Message) -ExitCode 1
  throw
}
finally {
  if ($ownsMutex) { $runnerMutex.ReleaseMutex() }
  $runnerMutex.Dispose()
}
