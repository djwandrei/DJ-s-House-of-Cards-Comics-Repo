[CmdletBinding()]
param(
  [switch]$Apply
)

# Refresh the original Commerce project's compact, public-safe MLB/NFL
# Slab-to-Stats cache from the isolated pro-sports analytics project. The Edge
# Function owns data selection, mapping validation, and writes; this wrapper
# keeps both service credentials and the per-run worker secret in process
# memory and never writes them to a report.

$ErrorActionPreference = 'Stop'

$pnpm = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$commerceProjectRef = 'gkqdymnmczabcggvigce'
$analyticsProjectRef = 'rioxosivyhczxshhmaen'
$functionName = 'sync-pro-sports-product-slab-stats-cache'
$functionUrl = "https://$commerceProjectRef.functions.supabase.co/$functionName"

function Get-ProjectServiceRoleKey([string]$ProjectRef) {
  $keys = (& $pnpm dlx supabase projects api-keys --project-ref $ProjectRef --reveal --output json) | ConvertFrom-Json
  $serviceRole = @($keys | Where-Object { $_.name -eq 'service_role' -and $_.type -eq 'legacy' }) | Select-Object -First 1
  if (-not $serviceRole -or [string]::IsNullOrWhiteSpace([string]$serviceRole.api_key)) {
    throw "The required service-role key for $ProjectRef could not be resolved."
  }
  return [string]$serviceRole.api_key
}

if (-not $Apply) {
  [pscustomobject]@{
    mode = 'dry-run'
    commerceProjectRef = $commerceProjectRef
    analyticsProjectRef = $analyticsProjectRef
    function = $functionName
    operation = 'Would configure the isolated analytics source credentials, rotate the worker-only trigger secret, and run a zero-mismatch cache refresh.'
    hint = 'Pass -Apply to perform the server-side cache write.'
  } | ConvertTo-Json -Compress
  return
}

$analyticsServiceRoleKey = $null
$workerSecret = [guid]::NewGuid().ToString('N')
try {
  $analyticsServiceRoleKey = Get-ProjectServiceRoleKey $analyticsProjectRef

  # The Commerce function can only reach the dedicated MLB/NFL warehouse with
  # this service credential. Supabase receives it directly; PowerShell never
  # serializes it to disk or the wrapper's JSON result.
  & $pnpm dlx supabase secrets set `
    "PRO_SPORTS_ANALYTICS_SUPABASE_URL=https://$analyticsProjectRef.supabase.co" `
    "PRO_SPORTS_ANALYTICS_SUPABASE_SERVICE_ROLE_KEY=$analyticsServiceRoleKey" `
    "PRO_SPORTS_ANALYTICS_PROJECT_REF=$analyticsProjectRef" `
    "PRO_SPORTS_PRODUCT_SLAB_CACHE_SYNC_SECRET=$workerSecret" `
    --project-ref $commerceProjectRef
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure the pro-sports product-cache worker secrets.' }

  try {
    $body = Invoke-RestMethod -Method Post -Uri $functionUrl -Headers @{
      'x-djhc-pro-sports-cache-secret' = $workerSecret
      'Content-Type' = 'application/json'
    } -Body '{}'
  } catch {
    $statusCode = 0
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    $reason = [string]$_.Exception.Message
    throw "The pro-sports product-cache worker request failed with HTTP status ${statusCode}: $reason"
  }

  $summary = [pscustomobject]@{
    mode = 'apply'
    statusCode = 200
    ok = [bool]$body.ok
    mappedProducts = $body.mappedProducts
    cacheUpserts = $body.cacheUpserts
    cacheChecked = $body.cacheChecked
    staleCacheRows = $body.staleCacheRows
    mismatches = $body.mismatches
  }
  if (-not $summary.ok -or [int]$summary.mismatches -ne 0) {
    throw 'The pro-sports product-cache worker completed without a zero-mismatch validation result.'
  }
  $summary | ConvertTo-Json -Compress
} finally {
  Remove-Variable analyticsServiceRoleKey -ErrorAction SilentlyContinue
  Remove-Variable workerSecret -ErrorAction SilentlyContinue
}
