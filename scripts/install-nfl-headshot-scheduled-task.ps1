[CmdletBinding()]
param(
  [ValidateRange(1, 15)]
  [int]$IntervalMinutes = 1,
  [ValidateRange(1, 100)]
  [int]$Limit = 50,
  [ValidateRange(1, 2)]
  [int]$Concurrency = 2,
  [switch]$Start
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'run-nfl-headshot-capture.ps1'
$taskName = "DJHC NFL Headshot Backfill"
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Limit $Limit -Concurrency $Concurrency"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
# Stage safely by default. A blocked source must be explicitly cleared before
# an unattended task starts making normal browser requests again.
Disable-ScheduledTask -TaskName $taskName | Out-Null
if ($Start) {
  Enable-ScheduledTask -TaskName $taskName | Out-Null
  Start-ScheduledTask -TaskName $taskName
}
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
