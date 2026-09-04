[CmdletBinding()]
param(
  [ValidateSet('mlb', 'nfl', 'both')]
  [string]$Sport = 'both',

  [ValidateRange(1876, 2200)]
  [int]$SeasonStart = 1980,

  [ValidateRange(1876, 2200)]
  [int]$SeasonEnd = (Get-Date).ToUniversalTime().Year
)

$ErrorActionPreference = 'Stop'
if ($SeasonEnd -lt $SeasonStart) {
  throw 'SeasonEnd must be greater than or equal to SeasonStart.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$auditScript = Join-Path $PSScriptRoot 'audit-pro-sports-analytics-health.mjs'
$outputRoot = Join-Path $repoRoot 'outputs\sports-reference-history\health'
$reportPath = Join-Path $outputRoot 'latest.json'
$statusPath = Join-Path $outputRoot 'status.json'
$stdoutPath = Join-Path $outputRoot 'current-audit.stdout.json'
$stderrPath = Join-Path $outputRoot 'current-audit.stderr.log'

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

# The scheduled task and an interactive check share one compact report. Do not
# let a second process interleave output or replace the status mid-run.
$runnerMutex = [System.Threading.Mutex]::new($false, 'Local\DJHCProSportsAnalyticsHealth')
$ownsMutex = $false

function Write-AtomicText {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Text
  )

  $temporaryPath = "$Path.$PID.tmp"
  [System.IO.File]::WriteAllText($temporaryPath, $Text, [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-RunnerStatus {
  param(
    [Parameter(Mandatory)] [string]$State,
    [string]$Message = '',
    [int]$ExitCode = 0,
    [object]$Report = $null
  )

  $payload = [ordered]@{
    state = $State
    message = $Message
    checked_at = (Get-Date).ToUniversalTime().ToString('o')
    process_id = $PID
    sport = $Sport
    season_start = $SeasonStart
    season_end = $SeasonEnd
    exit_code = $ExitCode
    report_status = if ($Report) { [string]$Report.status } else { '' }
  }
  Write-AtomicText -Path $statusPath -Text ($payload | ConvertTo-Json -Depth 4)
}

try {
  $ownsMutex = $runnerMutex.WaitOne(0)
  if (-not $ownsMutex) {
    # Preserve the active runner's status/report rather than replacing it.
    Write-Output 'Another pro-sports health check is already running.'
    exit 0
  }

  Set-Location -LiteralPath $repoRoot
  Write-RunnerStatus -State 'running' -Message 'Starting read-only Baseball/Football health audit.'
  $arguments = @(
    $auditScript,
    '--sport', $Sport,
    '--season-start', [string]$SeasonStart,
    '--season-end', [string]$SeasonEnd
  )
  $process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $repoRoot `
    -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Write-RunnerStatus -State 'failed' -Message "Read-only health audit exited $($process.ExitCode). See current-audit.stderr.log." -ExitCode $process.ExitCode
    exit $process.ExitCode
  }

  $rawReport = Get-Content -Raw -LiteralPath $stdoutPath
  $report = $rawReport | ConvertFrom-Json
  if ($report.mode -ne 'read-only' -or -not $report.sports) {
    throw 'Health audit returned an invalid report.'
  }
  Write-AtomicText -Path $reportPath -Text $rawReport
  Write-RunnerStatus -State ([string]$report.status) -Message 'Read-only health audit completed.' -Report $report
  Write-Output $rawReport
}
catch {
  Write-RunnerStatus -State 'failed' -Message ([string]$_.Exception.Message) -ExitCode 1
  throw
}
finally {
  if ($ownsMutex) { $runnerMutex.ReleaseMutex() }
  $runnerMutex.Dispose()
}
