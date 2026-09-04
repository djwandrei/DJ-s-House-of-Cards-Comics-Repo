[CmdletBinding()]
param(
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
  [string]$DailyAt = '06:30',

  [ValidateSet('mlb', 'nfl', 'both')]
  [string]$Sport = 'both',

  [ValidateRange(1876, 2200)]
  [int]$SeasonStart = 1980,

  [Nullable[int]]$SeasonEnd = $null,

  [switch]$Enable,
  [switch]$RunNow
)

$ErrorActionPreference = 'Stop'
if ($null -ne $SeasonEnd -and ($SeasonEnd -lt 1876 -or $SeasonEnd -gt 2200)) {
  throw 'SeasonEnd must be an integer from 1876 through 2200.'
}
if ($null -ne $SeasonEnd -and $SeasonEnd -lt $SeasonStart) {
  throw 'SeasonEnd must be greater than or equal to SeasonStart.'
}
if ($RunNow -and -not $Enable) {
  throw '-RunNow requires -Enable.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-pro-sports-analytics-health.ps1'
$taskName = 'DJHC Pro Sports Analytics Health'
$taskArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Sport $Sport -SeasonStart $SeasonStart"
if ($null -ne $SeasonEnd) { $taskArguments += " -SeasonEnd $SeasonEnd" }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Daily -At (Get-Date $DailyAt)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
if ($Enable) {
  Enable-ScheduledTask -TaskName $taskName | Out-Null
} else {
  # Staged by default so source-free health monitoring can be reviewed before
  # it runs unattended. The task never imports or writes analytics data.
  Disable-ScheduledTask -TaskName $taskName | Out-Null
}
if ($RunNow) { Start-ScheduledTask -TaskName $taskName }
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
