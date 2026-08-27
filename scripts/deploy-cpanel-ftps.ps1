[CmdletBinding()]
param(
  [string]$ConfigPath = ".deploy/cpanel-deploy.local.json",
  [PSCredential]$Credential,
  [string]$PathList,
  [switch]$Full,
  [switch]$DryRun,
  [switch]$SkipDelete,
  [switch]$AllowAssetDelete,
  [string]$DeletePathList
)

$ErrorActionPreference = "Stop"
$script:ResolvedDeployCredential = $null

function Get-RepoRoot {
  return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Convert-ToRepoRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FullPath
  )

  $root = $script:RepoRoot.TrimEnd([char[]]@(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  ))
  $normalizedFullPath = [System.IO.Path]::GetFullPath($FullPath)
  $rootPrefix = $root + [System.IO.Path]::DirectorySeparatorChar

  if ($normalizedFullPath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return ($normalizedFullPath.Substring($rootPrefix.Length) -replace "\\", "/")
  }

  if ($normalizedFullPath.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return ""
  }

  throw "Path '$FullPath' is not inside the project root."
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

  $githubDesktopGit = Get-ChildItem "$env:LOCALAPPDATA\GitHubDesktop" -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "app-*" } |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "resources\app\git\cmd\git.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1

  $candidates = @((
    $gitFromPath,
    "$env:LOCALAPPDATA\GitHubDesktop\bin\git.exe",
    "$env:LOCALAPPDATA\GitHubDesktop\bin\git.cmd",
    $githubDesktopGit,
    "C:\Program Files\Git\cmd\git.exe"
  ) | Where-Object { $_ -and (Test-Path $_) })

  if (-not $candidates) {
    return $null
  }

  return [string]($candidates | Select-Object -First 1)
}

function Test-GitRepository {
  if (-not $script:GitExe) {
    return $false
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $script:GitExe -C $script:RepoRoot rev-parse --is-inside-work-tree 2>$null
    return ($LASTEXITCODE -eq 0 -and ([string]$output).Trim() -eq "true")
  } catch {
    return $false
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  if (-not $script:IsGitRepository) {
    throw "This operation requires a Git checkout. Run from the real repository, or use -Full/-PathList for a manual upload from this folder."
  }

  $output = & $script:GitExe -C $script:RepoRoot -c core.quotepath=off @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed.`n$output"
  }
  return @($output)
}

function Get-GitStatusEntries {
  $rawOutput = -join (Invoke-Git -Arguments @("status", "--porcelain=v1", "-z"))
  $records = @($rawOutput -split "`0" | Where-Object { $_ })
  $entries = @()

  for ($index = 0; $index -lt $records.Count; $index++) {
    $record = [string]$records[$index]
    if ($record.Length -lt 4) {
      continue
    }

    $status = $record.Substring(0, 2)
    $path = $record.Substring(3)

    if ($status -like "R*" -or $status -like "C*") {
      $sourcePath = if ($index + 1 -lt $records.Count) { [string]$records[++$index] } else { "" }
      $entries += [pscustomobject]@{
        Status = $status
        Path = $path
        SourcePath = $sourcePath
      }
      continue
    }

    $entries += [pscustomobject]@{
      Status = $status
      Path = $path
      SourcePath = ""
    }
  }

  return @($entries)
}

function Load-DeployConfig {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    throw "Deploy config not found at '$Path'. Copy scripts/cpanel-deploy.example.json to .deploy/cpanel-deploy.local.json and fill in the non-secret FTPS endpoint details."
  }

  $config = Get-Content -Raw -Path $Path | ConvertFrom-Json
  $required = @("host", "remoteRoot")
  foreach ($name in $required) {
    if (-not $config.$name) {
      throw "Deploy config is missing required field '$name'."
    }
  }

  foreach ($name in @("username", "password")) {
    if ($config.PSObject.Properties.Name -contains $name) {
      throw "Deploy config must not contain '$name'. Remove credential fields and use the secure prompt or injected CPANEL_FTPS_USERNAME/CPANEL_FTPS_PASSWORD environment variables."
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

  if ($config.allowInsecureCertificate) {
    throw "Insecure FTPS certificate bypass is disabled. Fix the configured hostname or hosting certificate."
  }

  return $config
}

function Get-DeployCredential {
  if ($script:ResolvedDeployCredential) {
    return $script:ResolvedDeployCredential
  }

  if ($Credential) {
    $script:ResolvedDeployCredential = $Credential
    return $script:ResolvedDeployCredential
  }

  $environmentUsername = [string]$env:CPANEL_FTPS_USERNAME
  $environmentPassword = [string]$env:CPANEL_FTPS_PASSWORD
  if ($environmentPassword -and -not $environmentUsername) {
    throw "CPANEL_FTPS_PASSWORD is set without CPANEL_FTPS_USERNAME."
  }

  if ($environmentUsername -and $environmentPassword) {
    # Avoid relying on Security-module autoloading: background PowerShell
    # sessions can have the cmdlet module available but not loadable.
    $securePassword = New-Object System.Security.SecureString
    foreach ($character in $environmentPassword.ToCharArray()) {
      [void]$securePassword.AppendChar($character)
    }
    $securePassword.MakeReadOnly()
    $script:ResolvedDeployCredential = [PSCredential]::new($environmentUsername, $securePassword)
    return $script:ResolvedDeployCredential
  }

  if ($environmentUsername) {
    $securePassword = Read-Host "FTPS password for $environmentUsername" -AsSecureString
    $script:ResolvedDeployCredential = [PSCredential]::new($environmentUsername, $securePassword)
    return $script:ResolvedDeployCredential
  }

  $script:ResolvedDeployCredential = Get-Credential -Message "Enter the dedicated cPanel FTPS account credentials. They will not be saved in the project."
  if (-not $script:ResolvedDeployCredential) {
    throw "FTPS credentials are required."
  }

  return $script:ResolvedDeployCredential
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

  if ($normalizedPath.Equals("feeds/facebook-products.csv", [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $leafName = Split-Path -Leaf $normalizedPath
  $extension = [System.IO.Path]::GetExtension($normalizedPath).ToLowerInvariant()
  $excludedFileNamesAnywhere = @(
    ".Rhistory",
    ".DS_Store",
    "desktop.ini",
    "Thumbs.db"
  )
  $excludedExtensionsAnywhere = @(
    ".csv",
    ".log",
    ".pid",
    ".pyc",
    ".xls",
    ".xlsx",
    ".zip"
  )

  foreach ($fileName in $excludedFileNamesAnywhere) {
    if ($leafName.Equals($fileName, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }

  if ($excludedExtensionsAnywhere -icontains $extension) {
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

  # The public-beta Lineup Lab remains isolated from primary navigation,
  # sitemap, and the service-worker shell. Keep its deploy allowlist narrow so
  # a future fan-tools workspace cannot be uploaded by accident.
  if ($normalizedPath.StartsWith("lineup-lab/", [System.StringComparison]::OrdinalIgnoreCase)) {
    return @(".html", ".js", ".css", ".json") -contains $extension
  }

  # The public Fan Tools hub is a separate, browser-only surface. Keep its
  # release paths narrow and exclude any future private tool workspaces.
  if ($normalizedPath.StartsWith("tools/", [System.StringComparison]::OrdinalIgnoreCase)) {
    return @(".html", ".js", ".css") -contains $extension
  }

  $allowedRootFiles = @(
    ".htaccess",
    "account.html",
    "account.js",
    "about.html",
    "admin.html",
    "analytics.js",
    "backend-admin.js",
    "backend-config.js",
    "baseball-cards.html",
    "basketball-cards.html",
    "catalog.js",
    "cart.html",
    "checkout-success.html",
    "collectibles.html",
    "comics.html",
    "condition-authenticity.html",
    "contact.html",
    "contact.js",
    "core.js",
    "football-cards.html",
    "index.html",
    "inbox.html",
    "inbox.js",
    "inquiries.js",
    "metrics.html",
    "metrics.js",
    "nav.js",
    "nba-slab-stats.mjs",
    "offline.html",
    "offline.js",
    "offer.html",
    "offers.js",
    "payments.js",
    "privacy.html",
    "policies.html",
    "products-baseball.json",
    "products-basketball.json",
    "products-bootstrap-baseball.json",
    "products-bootstrap-basketball.json",
    "products-bootstrap-collectibles.json",
    "products-bootstrap-comics.json",
    "products-bootstrap-football.json",
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
    "products-public.json",
    "robots.txt",
    "seo.js",
    "shipping.html",
    "shop.html",
    "site.webmanifest",
    "sitemap.xml",
    "sports-cards.html",
    "styles.css",
    "styles-mobile-overrides.css",
    "supabase-client.js",
    "sw.js",
    "terms.html",
    "returns.html",
    "sell-trade-want-list.html",
    "wishlist.html"
  )

  return $allowedRootFiles -icontains $normalizedPath
}

function Test-DeployableFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  if (-not (Test-DeployablePath -RelativePath $RelativePath)) {
    return $false
  }

  # Upload operations must target files only. Git can report newly-created
  # directories while assets are still untracked, so keep folders out of curl.
  $localPath = Join-Path $script:RepoRoot $RelativePath
  return (Test-Path -LiteralPath $localPath -PathType Leaf)
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
    [AllowNull()]
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
    mode = if ($Commit) { "git" } else { "manual" }
  } | ConvertTo-Json | Set-Content -Path $statePath -Encoding UTF8
}

function Get-CurrentCommit {
  if (-not $script:IsGitRepository) {
    return $null
  }

  return (@(Invoke-Git -Arguments @("rev-parse", "HEAD"))[0]).Trim()
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
    "--ssl-reqd"
  )

  if ($script:DeployConfig.passive) {
    $args += "--ftp-pasv"
  }

  if ($script:DeployConfig.resolveHost) {
    $args += @(
      "--resolve",
      ("{0}:{1}:{2}" -f $script:DeployConfig.host, $script:DeployConfig.port, $script:DeployConfig.resolveHost)
    )
  }

  return $args
}

function Convert-ToCurlConfigValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  if ($Value.Contains("`r") -or $Value.Contains("`n")) {
    throw "FTPS credentials must not contain line breaks."
  }

  return ($Value -replace "\\", "\\" -replace '"', '\"')
}

function Invoke-SecureCurl {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  $deployCredential = Get-DeployCredential
  $networkCredential = $deployCredential.GetNetworkCredential()
  $userPassword = Convert-ToCurlConfigValue -Value "$($networkCredential.UserName):$($networkCredential.Password)"

  # Pass credentials through a short-lived config file so they are not exposed
  # in curl's process args. Windows PowerShell can prepend a BOM when piping to
  # native stdin, and older .NET versions lack ProcessStartInfo.ArgumentList.
  $configPath = Join-Path ([System.IO.Path]::GetTempPath()) ("cpanel-curl-{0}.cfg" -f ([guid]::NewGuid().ToString("N")))
  try {
    Set-Content -LiteralPath $configPath -Value "user = `"$userPassword`"" -Encoding Ascii
    & curl.exe --config $configPath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "FTPS curl exited with code $LASTEXITCODE."
    }
  } finally {
    if (Test-Path -LiteralPath $configPath) {
      Remove-Item -LiteralPath $configPath -Force
    }
  }
}

function Invoke-Upload {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RelativePath
  )

  $localPath = Join-Path $script:RepoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $localPath -PathType Leaf)) {
    throw "Cannot upload missing file '$RelativePath'."
  }

  $remoteUrl = Convert-ToRemoteUrl -RelativePath $RelativePath
  if ($DryRun) {
    Write-Host "[dry-run] upload $RelativePath -> $remoteUrl"
    return
  }

  $args = Get-CurlCommonArguments
  # Shared hosting FTP occasionally returns transient 4xx statuses after the
  # data transfer completes. Retrying the individual file is much cheaper than
  # restarting the whole deployment.
  $args += @(
    "--retry", "4",
    "--retry-delay", "2",
    "--retry-all-errors",
    "--connect-timeout", "30",
    "--ftp-create-dirs",
    "-T", $localPath,
    $remoteUrl
  )
  Invoke-SecureCurl -Arguments $args
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

  $remoteRootUrl = "{0}://{1}:{2}/" -f (Get-CurlUrlScheme), $script:DeployConfig.host, $script:DeployConfig.port
  $args = Get-CurlCommonArguments
  $args += @(
    "--quote", "DELE $remotePath",
    $remoteRootUrl
  )

  Invoke-SecureCurl -Arguments $args
}

function Invoke-DeleteBatch {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$RelativePaths
  )

  if (-not $RelativePaths.Count) {
    return
  }

  foreach ($relativePath in $RelativePaths) {
    Write-Host ("delete {0}" -f $relativePath)
  }

  $remoteRootUrl = "{0}://{1}:{2}/" -f (Get-CurlUrlScheme), $script:DeployConfig.host, $script:DeployConfig.port
  $args = Get-CurlCommonArguments
  foreach ($relativePath in $RelativePaths) {
    $remotePath = "/" + ((Get-RemotePathSegments -RelativePath $relativePath) -join "/")
    $args += @("--quote", "DELE $remotePath")
  }
  $args += @("--output", "NUL", $remoteRootUrl)

  Invoke-SecureCurl -Arguments $args
}

function Get-FullUploadList {
  if (-not $script:IsGitRepository) {
    return @(Get-ChildItem -LiteralPath $script:RepoRoot -Recurse -File -Force |
      ForEach-Object {
        Convert-ToRepoRelativePath -FullPath $_.FullName
      } |
      Where-Object { $_ -and (Test-DeployableFile -RelativePath $_) } |
      Sort-Object -Unique)
  }

  $tracked = Invoke-Git -Arguments @("ls-files")
  $untracked = Invoke-Git -Arguments @("ls-files", "--others", "--exclude-standard")
  return @($tracked + $untracked |
    Where-Object { $_ -and (Test-DeployableFile -RelativePath $_) } |
    Sort-Object -Unique)
}

function Get-ChangedFiles {
  $state = Load-DeployState
  $uploads = New-Object System.Collections.Generic.HashSet[string]
  $deletes = New-Object System.Collections.Generic.HashSet[string]

  if (-not $script:IsGitRepository) {
    if (-not $Full) {
      throw "Incremental deploy requires Git metadata. Run from the real repository, or rerun with -Full or -PathList from this folder."
    }

    foreach ($path in (Get-FullUploadList)) {
      [void]$uploads.Add($path)
    }

    return [pscustomobject]@{
      uploads = @($uploads)
      deletes = @($deletes)
    }
  }

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
          if (Test-DeployableFile -RelativePath $parts[2]) {
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

      if ($parts.Count -ge 2 -and (Test-DeployableFile -RelativePath $parts[1])) {
        [void]$uploads.Add($parts[1])
      }
    }
  }

  foreach ($entry in (Get-GitStatusEntries)) {
    $status = $entry.Status
    $path = $entry.Path

    if ($status -like "R*") {
      if ($entry.SourcePath -and (Test-DeployablePath -RelativePath $entry.SourcePath)) {
        [void]$deletes.Add($entry.SourcePath)
      }
      if ($path -and (Test-DeployableFile -RelativePath $path)) {
        [void]$uploads.Add($path)
      }
      continue
    }

    if ($status.Contains("D")) {
      if (Test-DeployablePath -RelativePath $path) {
        [void]$deletes.Add($path)
      }
      continue
    }

    if (Test-DeployableFile -RelativePath $path) {
      [void]$uploads.Add($path)
    }
  }

  foreach ($path in (Invoke-Git -Arguments @("ls-files", "--others", "--exclude-standard"))) {
    if ($path -and (Test-DeployableFile -RelativePath $path)) {
      [void]$uploads.Add($path)
    }
  }

  return [pscustomobject]@{
    uploads = @($uploads | Sort-Object)
    deletes = @($deletes | Sort-Object)
  }
}

function Get-PathListUploadSet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ListPath
  )

  $resolvedListPath = if ([System.IO.Path]::IsPathRooted($ListPath)) { $ListPath } else { Join-Path $script:RepoRoot $ListPath }
  if (-not (Test-Path -LiteralPath $resolvedListPath -PathType Leaf)) {
    throw "Path list not found at '$ListPath'."
  }

  $uploads = New-Object System.Collections.Generic.HashSet[string]
  # Path lists can contain Unicode asset names. Explicit UTF-8 avoids the
  # Windows PowerShell ANSI fallback turning valid filenames into mojibake.
  foreach ($line in (Get-Content -LiteralPath $resolvedListPath -Encoding UTF8)) {
    $path = ($line -replace "\\", "/").Trim()
    if (-not $path -or $path.StartsWith("#")) {
      continue
    }

    if (Test-DeployableFile -RelativePath $path) {
      [void]$uploads.Add($path)
    } else {
      Write-Warning "Skipping non-deployable or missing path from list: $path"
    }
  }

  return [pscustomobject]@{
    uploads = @($uploads | Sort-Object)
    deletes = @()
  }
}

function Get-DeletePathListSet {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ListPath
  )

  $resolvedListPath = if ([System.IO.Path]::IsPathRooted($ListPath)) { $ListPath } else { Join-Path $script:RepoRoot $ListPath }
  if (-not (Test-Path -LiteralPath $resolvedListPath -PathType Leaf)) {
    throw "Delete path list not found at '$ListPath'."
  }

  $deletes = New-Object System.Collections.Generic.HashSet[string]
  foreach ($line in (Get-Content -LiteralPath $resolvedListPath -Encoding UTF8)) {
    $path = ($line -replace "\\", "/").Trim()
    if (-not $path -or $path.StartsWith("#")) {
      continue
    }

    if (Test-DeployablePath -RelativePath $path) {
      [void]$deletes.Add($path)
    } else {
      Write-Warning "Skipping non-deployable delete path from list: $path"
    }
  }

  return [pscustomobject]@{
    uploads = @()
    deletes = @($deletes | Sort-Object)
  }
}

$script:RepoRoot = Get-RepoRoot
$script:GitExe = Get-GitExecutable
$script:IsGitRepository = Test-GitRepository
$resolvedConfigPath = if ([System.IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath } else { Join-Path $script:RepoRoot $ConfigPath }
$script:DeployConfig = Load-DeployConfig -Path $resolvedConfigPath

$changeSet = if ($DeletePathList) {
  Get-DeletePathListSet -ListPath $DeletePathList
} elseif ($PathList) {
  Get-PathListUploadSet -ListPath $PathList
} else {
  Get-ChangedFiles
}
$uploadList = @($changeSet.uploads | Where-Object { $_ })
$pendingDeleteList = @($changeSet.deletes | Where-Object { $_ })
$blockedAssetDeleteList = @($pendingDeleteList | Where-Object {
  $_.StartsWith("assets/", [System.StringComparison]::OrdinalIgnoreCase)
})
$skippedDeleteList = if ($SkipDelete) {
  $pendingDeleteList
} elseif (-not $AllowAssetDelete) {
  $blockedAssetDeleteList
} else {
  @()
}
$deleteList = if ($SkipDelete) {
  @()
} elseif ($AllowAssetDelete) {
  $pendingDeleteList
} else {
  @($pendingDeleteList | Where-Object {
    -not $_.StartsWith("assets/", [System.StringComparison]::OrdinalIgnoreCase)
  })
}

if (-not $SkipDelete -and -not $AllowAssetDelete -and $blockedAssetDeleteList.Count) {
  Write-Warning ("Blocked {0} asset deletion(s). Rerun with -AllowAssetDelete only after verifying the live catalog no longer needs them." -f $blockedAssetDeleteList.Count)
}

if (-not $uploadList.Count -and -not $deleteList.Count) {
  if (-not $DryRun -and -not $PathList -and -not $skippedDeleteList.Count) {
    $headCommit = Get-CurrentCommit
    Save-DeployState -Commit $headCommit
  }

  if ($skippedDeleteList.Count) {
    Write-Warning ("Deploy state was not advanced because {0} deletion(s) were skipped." -f $skippedDeleteList.Count)
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

if ($DeletePathList -and -not $DryRun) {
  $deleteBatchSize = 50
  for ($index = 0; $index -lt $deleteList.Count; $index += $deleteBatchSize) {
    $lastIndex = [Math]::Min($index + $deleteBatchSize - 1, $deleteList.Count - 1)
    Invoke-DeleteBatch -RelativePaths @($deleteList[$index..$lastIndex])
  }
} else {
  foreach ($relativePath in $deleteList) {
    Invoke-Delete -RelativePath $relativePath
  }
}

if (-not $DryRun -and -not $PathList -and -not $skippedDeleteList.Count) {
  $headCommit = Get-CurrentCommit
  Save-DeployState -Commit $headCommit
} elseif (-not $DryRun -and $PathList) {
  Write-Host "Path-list deploy completed without changing the global deploy state."
} elseif (-not $DryRun -and $DeletePathList) {
  Write-Host "Delete path-list deploy completed without changing the global deploy state."
} elseif (-not $DryRun -and $skippedDeleteList.Count) {
  Write-Warning ("Deploy state was not advanced because {0} deletion(s) were skipped." -f $skippedDeleteList.Count)
}

Write-Host "cPanel deploy completed."
