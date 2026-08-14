[CmdletBinding()]
param(
  [switch]$Staged,
  [switch]$TrackedOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$excludedPrefixes = @(".git/", "assets/", "vendor/")
$excludedFiles = @("scripts/audit-secrets.ps1")
$placeholderPattern = "(?i)(replace[_-]?with|your[_-]|example|placeholder|change[_-]?me|from[_-]?stripe|<[^>]+>|\$\{[^}]+\}|%[A-Z0-9_]+%|Deno\.env|process\.env|os\.environ|\`$env:)"

$rules = @(
  [pscustomobject]@{ Name = "Stripe secret or restricted key"; Pattern = "\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b" },
  [pscustomobject]@{ Name = "Stripe webhook secret"; Pattern = "\bwhsec_[A-Za-z0-9]{16,}\b" },
  [pscustomobject]@{ Name = "Supabase secret key"; Pattern = "\bsb_secret_[A-Za-z0-9_-]{16,}\b" },
  [pscustomobject]@{ Name = "JWT or service-role token"; Pattern = "\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b" },
  [pscustomobject]@{ Name = "Private key"; Pattern = "-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----" },
  [pscustomobject]@{ Name = "GitHub token"; Pattern = "\bgh[pousr]_[A-Za-z0-9_]{20,}\b" },
  [pscustomobject]@{ Name = "AWS access key"; Pattern = "\bAKIA[0-9A-Z]{16}\b" },
  [pscustomobject]@{ Name = "Basic-auth URL"; Pattern = "\b(?:https?|ftp|ftps)://[^/\s:@]+:[^/\s@]+@" },
  [pscustomobject]@{ Name = "Sensitive environment assignment"; Pattern = "(?im)^\s*(?:STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE_KEY|CPANEL_FTPS_PASSWORD|CPANEL_PASSWORD|FTP_PASSWORD)\s*=\s*[^\s#]{8,}" },
  [pscustomobject]@{ Name = "Plaintext credential field"; Pattern = "(?i)[`"'](?:password|passwd|serviceRoleKey|service_role_key)[`"']\s*:\s*[`"'][^`"']{4,}[`"']" }
)

function Convert-ToRelativePath {
  param([string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $rootPrefix = $repoRoot.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  return ($fullPath.Substring($rootPrefix.Length) -replace "\\", "/")
}

function Test-IsExcluded {
  param([string]$RelativePath)

  $normalized = $RelativePath -replace "\\", "/"
  if ($excludedFiles -contains $normalized) {
    return $true
  }

  foreach ($prefix in $excludedPrefixes) {
    if ($normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }

  return $false
}

function Get-CandidatePaths {
  if ($Staged) {
    return @(& git -C $repoRoot -c core.quotepath=false diff --cached --name-only --diff-filter=ACMR -- . ":!assets/**" ":!vendor/**")
  }

  if ($TrackedOnly) {
    return @(& git -C $repoRoot -c core.quotepath=false ls-files -- . ":!assets/**" ":!vendor/**")
  }

  # Scan every tracked or non-ignored candidate that could enter a commit while
  # skipping machine-local credentials, generated dependencies, and outputs
  # already protected by .gitignore.
  return @(& git -C $repoRoot -c core.quotepath=false ls-files --cached --others --exclude-standard -- . ":!assets/**" ":!vendor/**")
}

function Get-CandidateContent {
  param([string]$RelativePath)

  if ($Staged) {
    $content = & git -C $repoRoot show ":$RelativePath" 2>$null
    if ($LASTEXITCODE -ne 0) {
      return $null
    }
    return ($content -join "`n")
  }

  $path = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return $null
  }

  $file = Get-Item -LiteralPath $path
  if ($file.Length -gt 25MB) {
    return $null
  }

  try {
    return Get-Content -LiteralPath $path -Raw -ErrorAction Stop
  } catch {
    return $null
  }
}

$findings = New-Object System.Collections.Generic.HashSet[string]
foreach ($relativePath in (Get-CandidatePaths | Sort-Object -Unique)) {
  if (-not $relativePath -or (Test-IsExcluded -RelativePath $relativePath)) {
    continue
  }

  $content = Get-CandidateContent -RelativePath $relativePath
  if ([string]::IsNullOrEmpty($content)) {
    continue
  }

  $activeRules = @($rules)
  if ($relativePath -match "(?i)(^|/)(?:\.deploy/|[^/]*(?:cpanel|ftps?|deploy)[^/]*\.(?:json|toml|ya?ml))") {
    $activeRules += [pscustomobject]@{ Name = "Stored deploy username"; Pattern = "(?i)[`"']username[`"']\s*:\s*[`"'][^`"']{3,}[`"']" }
    $activeRules += [pscustomobject]@{ Name = "Insecure FTPS certificate bypass"; Pattern = "(?i)[`"']?allowInsecureCertificate[`"']?\s*:\s*true" }
  }

  foreach ($rule in $activeRules) {
    foreach ($match in [regex]::Matches($content, $rule.Pattern)) {
      if ($match.Value -match $placeholderPattern) {
        continue
      }

      $lineNumber = ([regex]::Matches($content.Substring(0, $match.Index), "`n")).Count + 1
      [void]$findings.Add("${relativePath}:${lineNumber}: $($rule.Name)")
    }
  }
}

if ($findings.Count -gt 0) {
  Write-Error ("Secret audit failed. Values are intentionally redacted.`n" + (($findings | Sort-Object) -join "`n"))
  exit 1
}

Write-Output "Secret audit passed; no blocked credential patterns were found."
