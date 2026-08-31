[CmdletBinding()]
param(
    [int]$SeasonStart,
    [string]$Phase = 'all',
    [ValidateRange(1, 5000)]
    [int]$MaxGames = 200,
    [ValidateRange(1000, 120000)]
    [int]$RequestDelayMs = 3500,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeScript = Join-Path $repoRoot 'scripts\download-nba-sportradar-weekly.mjs'
if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
    throw "Weekly Sportradar script was not found: $nodeScript"
}

$arguments = @($nodeScript, '--resume', '--phase', $Phase, '--max-games', [string]$MaxGames, '--request-delay-ms', [string]$RequestDelayMs)
if ($PSBoundParameters.ContainsKey('SeasonStart')) { $arguments += @('--season-start', [string]$SeasonStart) }
if ($PSBoundParameters.ContainsKey('OutputDir')) { $arguments += @('--output-dir', $OutputDir) }

Write-Output 'Starting the local, resumable Sportradar NBA weekly update.'
Write-Output 'The Node script will fail closed unless the process-only credential and network gates are present.'
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Weekly Sportradar updater exited with code $LASTEXITCODE." }
