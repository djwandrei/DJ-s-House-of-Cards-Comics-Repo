[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('mlb', 'nfl')]
  [string]$Sport,

  [ValidateRange(1876, 2200)]
  [int]$SeasonStart = (Get-Date).ToUniversalTime().Year,

  [ValidateRange(1876, 2200)]
  [int]$SeasonEnd = (Get-Date).ToUniversalTime().Year,

  [ValidateRange(3000, 600000)]
  [int]$RequestDelayMs = 4000,

  [ValidateRange(1, 8)]
  [int]$MaxAttempts = 3,

  [ValidateRange(10, 3600)]
  [int]$RetryDelaySeconds = 300,

  [string]$StatGroup = '',

  [switch]$Apply,
  [switch]$AllowSourceAccess
)

$ErrorActionPreference = 'Stop'

if ($SeasonEnd -lt $SeasonStart) {
  throw 'SeasonEnd must be greater than or equal to SeasonStart.'
}
if (-not $Apply) {
  throw 'This runner is write-gated. First run audit-pro-sports-analytics-health.mjs; pass -Apply only after the specific backfill is approved.'
}
if (-not $AllowSourceAccess) {
  throw 'This runner can contact an upstream source. Pass -AllowSourceAccess only after that source access is approved and its current robots policy is acceptable.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$importerPath = Join-Path $PSScriptRoot 'import-sports-reference-history.mjs'
$allStatGroups = if ($Sport -eq 'mlb') {
  @('batting', 'pitching')
} else {
  @('passing', 'rushing', 'receiving', 'defense', 'kicking', 'returns', 'scoring')
}
$StatGroup = $StatGroup.Trim().ToLowerInvariant()
if ($StatGroup -and $allStatGroups -notcontains $StatGroup) {
  throw "StatGroup must be one of: $($allStatGroups -join ', ')."
}
$selectedStatGroups = if ($StatGroup) { @($StatGroup) } else { $allStatGroups }
$checkpointSuffix = if ($StatGroup) { "-$Sport-$StatGroup" } else { '' }
$outputRoot = Join-Path $repoRoot 'outputs\sports-reference-history'
$checkpointPath = Join-Path $outputRoot ("checkpoint-{0}-{1}-{2}{3}.json" -f $Sport, $SeasonStart, $SeasonEnd, $checkpointSuffix)
$runnerRoot = Join-Path $outputRoot 'resumable-runner'
$runnerStem = "{0}-{1}-{2}{3}" -f $Sport, $SeasonStart, $SeasonEnd, $checkpointSuffix
$statusPath = Join-Path $runnerRoot "$runnerStem.status.json"
$logPath = Join-Path $runnerRoot "$runnerStem.log"
$targetUrl = if ($Sport -eq 'mlb') {
  'https://sptahazcjnorayjkltdx.supabase.co'
} else {
  'https://iuhjjwqfkohrrjqgpahh.supabase.co'
}

New-Item -ItemType Directory -Force -Path $runnerRoot | Out-Null

# The importer checkpoint is a whole JSON document. A named mutex keeps an
# interactive continuation and a scheduled retry from racing to replace it.
$runnerMutex = [System.Threading.Mutex]::new($false, ("Local\DJHCProSportsHistoryBackfill-{0}" -f $runnerStem))
$ownsMutex = $false

function Read-Checkpoint {
  if (-not (Test-Path -LiteralPath $checkpointPath)) { return $null }
  try { return Get-Content -Raw -LiteralPath $checkpointPath | ConvertFrom-Json }
  catch { return $null }
}

function Write-RunnerStatus {
  param(
    [Parameter(Mandatory)] [string]$State,
    [string]$Message = '',
    [int]$Attempt = 0,
    [int]$ExitCode = 0
  )

  $checkpoint = Read-Checkpoint
  $payload = [ordered]@{
    state = $State
    message = $Message
    updated_at = (Get-Date).ToUniversalTime().ToString('o')
    process_id = $PID
    sport = $Sport
    season_start = $SeasonStart
    season_end = $SeasonEnd
    stat_groups = $selectedStatGroups
    target_url = $targetUrl
    attempt = $Attempt
    exit_code = $ExitCode
    checkpoint_status = if ($checkpoint) { [string]$checkpoint.status } else { '' }
    checkpoint_updated_at = if ($checkpoint) { [string]$checkpoint.updatedAt } else { '' }
    completed_season_groups = if ($checkpoint) { @($checkpoint.completed.PSObject.Properties).Count } else { 0 }
    blocked_sports = if ($checkpoint) { @($checkpoint.blockedSources.PSObject.Properties.Name) } else { @() }
  }
  $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statusPath -Encoding utf8
  ('[{0}] {1}: {2}' -f $payload.updated_at, $State, $Message) | Add-Content -LiteralPath $logPath -Encoding utf8
}

function Test-CompleteCheckpoint {
  param([object]$Checkpoint)

  if ($null -eq $Checkpoint -or [int]$Checkpoint.version -ne 2) { return $false }
  if ([int]$Checkpoint.seasonStart -ne $SeasonStart -or [int]$Checkpoint.seasonEnd -ne $SeasonEnd) { return $false }
  if (@($Checkpoint.sports).Count -ne 1 -or [string]$Checkpoint.sports[0] -ne $Sport) { return $false }
  $targetRef = if ($Sport -eq 'mlb') { 'sptahazcjnorayjkltdx' } else { 'iuhjjwqfkohrrjqgpahh' }
  $targetProperty = $Checkpoint.targetProjectRefs.PSObject.Properties[$Sport]
  if ($null -eq $targetProperty -or [string]$targetProperty.Value -ne $targetRef) { return $false }
  if ($Checkpoint.statGroups) {
    $groupsProperty = $Checkpoint.statGroups.PSObject.Properties[$Sport]
    if ($null -eq $groupsProperty) { return $false }
    $checkpointGroups = @($groupsProperty.Value)
    if (($checkpointGroups -join ',') -ne ($selectedStatGroups -join ',')) { return $false }
  } elseif ($StatGroup) {
    # Legacy checkpoints did not record group selection, so they are valid
    # only for a full-range resume and must never satisfy a narrow repair.
    return $false
  }
  if ([string]$Checkpoint.status -ne 'completed') { return $false }
  $blockedProperties = if ($Checkpoint.blockedSources) { @($Checkpoint.blockedSources.PSObject.Properties) } else { @() }
  if ($blockedProperties.Count -ne 0) { return $false }
  $expectedGroupCount = ($SeasonEnd - $SeasonStart + 1) * $selectedStatGroups.Count
  $completedProperties = if ($Checkpoint.completed) { @($Checkpoint.completed.PSObject.Properties) } else { @() }
  return $completedProperties.Count -eq $expectedGroupCount
}

$previousSourceConfirmation = $env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED
$previousWriteConfirmation = $env:SPORTS_ANALYTICS_ALLOW_WRITE
$previousTarget = $env:SPORTS_ANALYTICS_SUPABASE_URL

try {
  $ownsMutex = $runnerMutex.WaitOne(0)
  if (-not $ownsMutex) {
    # Never overwrite the active worker's status file just to say that its
    # mutex is held; the live status remains the authoritative one.
    Write-Output 'Another process owns this sport and checkpoint range.'
    exit 0
  }

  $existingCheckpoint = Read-Checkpoint
  if (Test-CompleteCheckpoint $existingCheckpoint) {
    Write-RunnerStatus -State 'completed' -Message 'The matching checkpoint is already complete; no source request or database write was started.'
    exit 0
  }

  Set-Location -LiteralPath $repoRoot
  $env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED = 'confirmed'
  $env:SPORTS_ANALYTICS_ALLOW_WRITE = 'confirmed'
  $env:SPORTS_ANALYTICS_SUPABASE_URL = $targetUrl

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    Write-RunnerStatus -State 'running' -Message "Starting resumable import attempt $attempt of $MaxAttempts." -Attempt $attempt
    $stdoutPath = Join-Path $runnerRoot "$runnerStem.importer.stdout.log"
    $stderrPath = Join-Path $runnerRoot "$runnerStem.importer.stderr.log"
    $arguments = @(
      $importerPath,
      '--sport', $Sport,
      '--season-start', [string]$SeasonStart,
      '--season-end', [string]$SeasonEnd,
      '--request-delay-ms', [string]$RequestDelayMs,
      '--apply',
      '--analytics'
    )
    if ($StatGroup) { $arguments += @('--stat-group', $StatGroup) }
    $process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $repoRoot `
      -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait -PassThru
    $exitCode = $process.ExitCode
    foreach ($streamPath in @($stdoutPath, $stderrPath)) {
      if (-not (Test-Path -LiteralPath $streamPath)) { continue }
      $streamText = Get-Content -Raw -LiteralPath $streamPath
      if ($streamText) { Add-Content -LiteralPath $logPath -Value $streamText -Encoding utf8 }
    }

    $checkpoint = Read-Checkpoint
    if ($exitCode -eq 0 -and (Test-CompleteCheckpoint $checkpoint)) {
      Write-RunnerStatus -State 'completed' -Message 'The requested backfill range completed from its checkpoint.' -Attempt $attempt
      exit 0
    }
    if ($exitCode -eq 0 -and $checkpoint -and $checkpoint.status -eq 'completed_with_blocked_sources') {
      Write-RunnerStatus -State 'blocked-source' -Message 'The importer stopped at its robots/source/cache boundary. It did not bypass the source policy.' -Attempt $attempt
      exit 0
    }
    if ($exitCode -eq 0 -and $checkpoint -and $checkpoint.status -eq 'completed') {
      Write-RunnerStatus -State 'incomplete-range' -Message 'The importer ended without every expected season/group checkpoint. This may be current-season availability; inspect health output before resuming.' -Attempt $attempt
      exit 0
    }
    $failureExitCode = if ($exitCode -eq 0) { 1 } else { $exitCode }
    if ($attempt -lt $MaxAttempts) {
      Write-RunnerStatus -State 'retry-wait' -Message "Importer exited $exitCode without a terminal checkpoint; retrying from the same checkpoint in $RetryDelaySeconds seconds." -Attempt $attempt -ExitCode $failureExitCode
      Start-Sleep -Seconds $RetryDelaySeconds
      continue
    }
    Write-RunnerStatus -State 'needs-attention' -Message "Importer exited $exitCode without a terminal checkpoint after $MaxAttempts attempts; inspect the runner log and checkpoint before another run." -Attempt $attempt -ExitCode $failureExitCode
    exit $failureExitCode
  }
}
catch {
  Write-RunnerStatus -State 'failed' -Message ([string]$_.Exception.Message) -ExitCode 1
  throw
}
finally {
  if ($null -eq $previousSourceConfirmation) { Remove-Item Env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED -ErrorAction SilentlyContinue } else { $env:SPORTS_REFERENCE_AUTOMATION_CONFIRMED = $previousSourceConfirmation }
  if ($null -eq $previousWriteConfirmation) { Remove-Item Env:SPORTS_ANALYTICS_ALLOW_WRITE -ErrorAction SilentlyContinue } else { $env:SPORTS_ANALYTICS_ALLOW_WRITE = $previousWriteConfirmation }
  if ($null -eq $previousTarget) { Remove-Item Env:SPORTS_ANALYTICS_SUPABASE_URL -ErrorAction SilentlyContinue } else { $env:SPORTS_ANALYTICS_SUPABASE_URL = $previousTarget }
  if ($ownsMutex) { $runnerMutex.ReleaseMutex() }
  $runnerMutex.Dispose()
}
