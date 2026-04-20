[CmdletBinding()]
param(
  [string]$ConfigPath = ".deploy/cpanel-deploy.local.json",
  [switch]$Full,
  [switch]$DryRun,
  [switch]$SkipDelete
)

$ErrorActionPreference = "Stop"

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Get-GitExecutable {
  $gitFromPath = $null
  try {
    $command = Get-Command git.exe -ErrorAction Stop
    if ($command -and $command.Source) {
      $gitFromPath = $command.Source
    }
  } catch {
    $gitFromPath = $null
  }

  $candidates = @((
    $gitFromPath,
    "C:\Users\djwan\AppData\Local\GitHubDesktop\app-3.5.8\resources\app\git\cmd\git.exe",
    "C:\Program Files\Git\cmd\git.exe"
  ) | Where-Object { $_ -and (Test-Path $_) })

  if (-not $candidates) {
    throw "Git executable not found. Install Git or GitHub Desktop first."
  }

  return [string]($candidates | Select-Object -First 1)
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $output = & $script:GitExe -C $script:RepoRoot -c core.quotepath=off @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed.`n$output"
  }
  return @($output)
}

function Load-DeployConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    throw "Deploy config not found at '$Path'. Copy scripts/cpanel-deploy.example.json to .deploy/cpanel-deploy.local.json and fill in your FTPS details."
  }

  $config = Get-Content -Raw -Path $Path | ConvertFrom-Json
  $required = @("host", "username", "password", "remoteRoot")
  foreach ($name in $required) {
    if (-not $config.$name) {
      throw "Deploy config is missing required field '$name'."
    }
  }

  if (-not $config.protocol) {
    $config | Add-Member -NotePropertyName protocol -NotePropertyValue "ftps"
  }

  if ($config.protocol -ne "ftps") {
    throw "This deploy script currently supports FTPS only. The curl build on this machine does not include SFTP."
  }

  if (-not $config.port) {
    $config | Add-Member -NotePropertyName port -NotePropertyValue 21
  }

  if ($null -eq $config.passive) {
    $config | Add-Member -NotePropertyName passive -NotePropertyValue $true
  }

  if ($null -eq $config.allowInsecureCertificate) {
    $config | Add-Member -NotePropertyName allowInsecureCertificate -NotePropertyValue $false
  }

  return $config
}

function Test-DeployablePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $normalizedPath = ($RelativePath -replace "\\", "/").Trim()
  if (-not $normalizedPath) {
    return $false
  }

  $excludedRoots = @(
    ".git/",
    ".deploy/",
    ".codex/",
    "scripts/",
    "_unused-review/"
  )

  foreach ($root in $excludedRoots) {
    if ($normalizedPath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }

  $excludedFiles = @(
    ".gitattributes",
    ".gitignore",
    "CPANEL-DEPLOY.md",
    "README.md",
    ".Rhistory",
    "desktop.ini"
  )

  foreach ($fileName in $excludedFiles) {
    if ($normalizedPath.Equals($fileName, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }

  if ($normalizedPath.StartsWith("assets/", [System.StringComparison]::OrdinalIgnoreCase) -or
      $normalizedPath.StartsWith("vendor/", [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $allowedRootFiles = @(
    ".htaccess",
    "about.html",
    "admin.html",
    "admin.js",
    "backend-admin.js",
    "backend-config.js",
    "baseball-cards.html",
    "basketball-cards.html",
    "catalog.js",
    "collectibles.html",
    "comics.html",
    "contact.html",
    "contact.js",
    "core.js",
    "football-cards.html",
    "index.html",
    "nav.js",
    "offline.html",
    "offline.js",
    "products-baseball.json",
    "products-basketball.json",
    "products-collectibles.json",
    "products-comics.json",
    "products-data-baseball.js",
    "products-data-basketball.js",
    "products-data-collectibles.js",
    "products-data-comics.js",
    "products-data-featured.js",
    "products-data-football.js",
    "products-data-full.js",
    "products-data-sports.js",
    "products-featured.json",
    "products-football.json",
    "products-sports.json",
    "products.json",
    "robots.txt",
    "shop.html",
    "site.webmanifest",
    "sitemap.xml",
    "sports-cards.html",
    "styles.css",
    "supabase-client.js",
    "sw.js",
    "wishlist.html"
  )

  return $allowedRootFiles -icontains $normalizedPath
}

function Get-StatePath {
  return Join-Path $script:RepoRoot ".deploy/cpanel-deploy.state.json"
}

function Get-CurlUrlScheme {
  if ($script:DeployConfig.protocol -eq "ftps") {
    # cPanel advertises this account as explicit FTPS on port 21. For curl that
    # means ftp:// plus --ssl-reqd, not implicit FTPS on port 990.
    return "ftp"
  }

  return $script:DeployConfig.protocol
}

function Get-RemotePathSegments {
  param(
    [string]$RelativePath = ""
  )

  $segments = New-Object System.Collections.Generic.List[string]
  $remoteRoot = $script:DeployConfig.remoteRoot.Trim("/")
  if ($remoteRoot) {
    $segments.Add($remoteRoot)
  }

  foreach ($segment in ($RelativePath -replace "\\", "/" -split "/" | Where-Object { $_ })) {
    $segments.Add($segment)
  }

  return @($segments)
}

function Load-DeployState {
  $statePath = Get-StatePath
  if (-not (Test-Path $statePath)) {
    return [pscustomobject]@{
      lastDeployedCommit = $null
      deployedAt = $null
    }
  }

  try {
    return Get-Content -Raw -Path $statePath | ConvertFrom-Json
  } catch {
    return [pscustomobject]@{
      lastDeployedCommit = $null
      deployedAt = $null
    }
  }
}

function Save-DeployState {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Commit
  )

  $statePath = Get-StatePath
  $stateDir = Split-Path -Parent $statePath
  if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir | Out-Null
  }

  [pscustomobject]@{
    lastDeployedCommit = $Commit
    deployedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8
}

function Convert-ToRemoteUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $segments = Get-RemotePathSegments -RelativePath $RelativePath
  $encodedSegments = $segments | ForEach-Object { [System.Uri]::EscapeDataString($_) }
  $pathSuffix = if ($encodedSegments.Count) { $encodedSegments -join "/" } else { "" }
  return "{0}://{1}:{2}/{3}" -f (Get-CurlUrlScheme), $script:DeployConfig.host, $script:DeployConfig.port, $pathSuffix
}

function Get-CurlCommonArguments {
  $args = @(
    "--fail",
    "--silent",
    "--show-error",
    "--ssl-reqd",
    "--user", "$($script:DeployConfig.username):$($script:DeployConfig.password)"
  )

  if ($script:DeployConfig.passive) {
    $args += "--ftp-pasv"
  }

  if ($script:DeployConfig.allowInsecureCertificate) {
    $args += "--insecure"
  }

  return $args
}

function Invoke-Upload {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $localPath = Join-Path $script:RepoRoot $RelativePath
  if (-not (Test-Path $localPath)) {
    throw "Cannot upload missing file '$RelativePath'."
  }

  $remoteUrl = Convert-ToRemoteUrl -RelativePath $RelativePath
  if ($DryRun) {
    Write-Host "[dry-run] upload $RelativePath -> $remoteUrl"
    return
  }

  $args = Get-CurlCommonArguments
  $args += @("--ftp-create-dirs", "-T", $localPath, $remoteUrl)
  & curl.exe @args
  if ($LASTEXITCODE -ne 0) {
    throw "Upload failed for '$RelativePath'."
  }
}

function Invoke-Delete {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $remotePath = "/" + ((Get-RemotePathSegments -RelativePath $RelativePath) -join "/")

  if ($DryRun) {
    Write-Host "[dry-run] delete $remotePath"
    return
  }

  $args = Get-CurlCommonArguments
  $args += @(
    "--quote", "DELE $remotePath",
    "{0}://{1}:{2}/" -f (Get-CurlUrlScheme), $script:DeployConfig.host, $script:DeployConfig.port
  )

  & curl.exe @args
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Remote delete failed for '$RelativePath'. You may need to remove it manually in cPanel."
  }
}

function Get-FullUploadList {
  $tracked = Invoke-Git -Arguments @("ls-files")
  $untracked = Invoke-Git -Arguments @("ls-files", "--others", "--exclude-standard")
  return @($tracked + $untracked |
    Where-Object { $_ -and (Test-DeployablePath -RelativePath $_) } |
    Sort-Object -Unique)
}

function Get-ChangedFiles {
  $state = Load-DeployState
  $uploads = New-Object System.Collections.Generic.HashSet[string]
  $deletes = New-Object System.Collections.Generic.HashSet[string]

  if ($Full -or -not $state.lastDeployedCommit) {
    foreach ($path in (Get-FullUploadList)) {
      [void]$uploads.Add($path)
    }

    return [pscustomobject]@{
      uploads = @($uploads)
      deletes = @($deletes)
    }
  }

  $currentHead = (@(Invoke-Git -Arguments @("rev-parse", "HEAD"))[0]).Trim()
  if ($state.lastDeployedCommit -ne $currentHead) {
    foreach ($line in (Invoke-Git -Arguments @("diff", "--name-status", "$($state.lastDeployedCommit)..HEAD"))) {
      if (-not $line) { continue }
      $parts = $line -split "`t"
      $status = $parts[0]

      if ($status.StartsWith("R")) {
        if ($parts.Count -ge 3) {
          if (Test-DeployablePath -RelativePath $parts[1]) {
            [void]$deletes.Add($parts[1])
          }
          if (Test-DeployablePath -RelativePath $parts[2]) {
            [void]$uploads.Add($parts[2])
          }
        }
        continue
      }

      if ($status.StartsWith("D")) {
        if ($parts.Count -ge 2 -and (Test-DeployablePath -RelativePath $parts[1])) {
          [void]$deletes.Add($parts[1])
        }
        continue
      }

      if ($parts.Count -ge 2 -and (Test-DeployablePath -RelativePath $parts[1])) {
        [void]$uploads.Add($parts[1])
      }
    }
  }

  foreach ($line in (Invoke-Git -Arguments @("status", "--porcelain"))) {
    if (-not $line) { continue }
    $status = $line.Substring(0, 2)
    $path = $line.Substring(3).Trim()

    if ($status -like "R*") {
      $renameParts = $path -split " -> "
      if ($renameParts.Count -eq 2) {
        if (Test-DeployablePath -RelativePath $renameParts[0]) {
          [void]$deletes.Add($renameParts[0])
        }
        if (Test-DeployablePath -RelativePath $renameParts[1]) {
          [void]$uploads.Add($renameParts[1])
        }
      }
      continue
    }

    if ($status.Contains("D")) {
      if (Test-DeployablePath -RelativePath $path) {
        [void]$deletes.Add($path)
      }
      continue
    }

    if (Test-DeployablePath -RelativePath $path) {
      [void]$uploads.Add($path)
    }
  }

  foreach ($path in (Invoke-Git -Arguments @("ls-files", "--others", "--exclude-standard"))) {
    if ($path -and (Test-DeployablePath -RelativePath $path)) {
      [void]$uploads.Add($path)
    }
  }

  return [pscustomobject]@{
    uploads = @($uploads | Sort-Object)
    deletes = @($deletes | Sort-Object)
  }
}

$script:RepoRoot = Get-RepoRoot
$script:GitExe = Get-GitExecutable
$resolvedConfigPath = if ([System.IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath } else { Join-Path $script:RepoRoot $ConfigPath }
$script:DeployConfig = Load-DeployConfig -Path $resolvedConfigPath

$changeSet = Get-ChangedFiles
$uploadList = @($changeSet.uploads | Where-Object { $_ })
$deleteList = if ($SkipDelete) { @() } else { @($changeSet.deletes | Where-Object { $_ }) }

if (-not $uploadList.Count -and -not $deleteList.Count) {
  if (-not $DryRun) {
    $headCommit = (@(Invoke-Git -Arguments @("rev-parse", "HEAD"))[0]).Trim()
    Save-DeployState -Commit $headCommit
  }

  Write-Host "No cPanel deploy changes detected."
  exit 0
}

Write-Host ("Deploy target: {0}://{1}:{2}{3}" -f $script:DeployConfig.protocol, $script:DeployConfig.host, $script:DeployConfig.port, $script:DeployConfig.remoteRoot)
Write-Host ("Files to upload: {0}" -f $uploadList.Count)
Write-Host ("Files to delete: {0}" -f $deleteList.Count)

foreach ($relativePath in $uploadList) {
  Invoke-Upload -RelativePath $relativePath
}

foreach ($relativePath in $deleteList) {
  Invoke-Delete -RelativePath $relativePath
}

if (-not $DryRun) {
  $headCommit = (@(Invoke-Git -Arguments @("rev-parse", "HEAD"))[0]).Trim()
  Save-DeployState -Commit $headCommit
}

Write-Host "cPanel deploy completed."
