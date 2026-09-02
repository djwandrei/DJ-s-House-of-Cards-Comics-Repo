[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$profileDirectory = Join-Path $repoRoot 'outputs\sports-reference-media-cache\nfl\browser-profiles\normal-session'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chrome)) { throw "Chrome was not found at $chrome." }

New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
$arguments = @(
  '--new-window', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$profileDirectory",
  'https://www.pro-football-reference.com/'
)

# This intentionally opens a standard, visible browser window. It neither
# reads nor exports profile data; it lets the source perform its normal
# browser verification before the scheduled capture worker reuses the profile.
Start-Process -FilePath $chrome -ArgumentList $arguments -WorkingDirectory $repoRoot

