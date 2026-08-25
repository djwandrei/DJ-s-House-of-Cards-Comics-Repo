[CmdletBinding()]
param(
  [switch]$Apply
)

# Refresh the original commerce project's compact, public-safe NBA product
# cache from the separate analytics project.  The Edge Function owns all data
# selection and validation; this wrapper never reads product, customer, order,
# payment, asset, or service-role data into a local report.

$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$pnpm = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd'
$commerceProjectRef = 'gkqdymnmczabcggvigce'
$functionName = 'sync-nba-product-slab-stats-cache'
$functionUrl = "https://$commerceProjectRef.functions.supabase.co/$functionName"

if (-not $Apply) {
  [pscustomobject]@{
    mode = 'dry-run'
    projectRef = $commerceProjectRef
    function = $functionName
    operation = 'Would rotate the worker-only trigger secret and run a zero-mismatch cache refresh.'
    hint = 'Pass -Apply to perform the server-side cache write.'
  } | ConvertTo-Json -Compress
  return
}

$workerSecret = [guid]::NewGuid().ToString('N')
try {
  # Rotate a worker-only secret for this run.  The value is kept in process
  # memory only and is not included in command output or the result object.
  & $pnpm dlx supabase secrets set "NBA_PRODUCT_SLAB_CACHE_SYNC_SECRET=$workerSecret" --project-ref $commerceProjectRef
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure the NBA product-cache worker secret.' }

  try {
    $body = Invoke-RestMethod -Method Post -Uri $functionUrl -Headers @{
      'x-djhc-analytics-cache-secret' = $workerSecret
      'Content-Type' = 'application/json'
    } -Body '{}'
  } catch {
    $statusCode = 0
    if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
    $reason = [string]$_.Exception.Message
    throw "The NBA product-cache worker request failed with HTTP status ${statusCode}: $reason"
  }
  $summary = [pscustomobject]@{
    mode = 'apply'
    statusCode = 200
    ok = [bool]$body.ok
    mappedProducts = $body.mappedProducts
    cacheUpserts = $body.cacheUpserts
    shadowChecked = $body.shadowChecked
    mismatches = $body.mismatches
  }
  if (-not $summary.ok -or [int]$summary.mismatches -ne 0) {
    throw 'The NBA product-cache worker completed without a zero-mismatch validation result.'
  }
  $summary | ConvertTo-Json -Compress
} finally {
  Remove-Variable workerSecret -ErrorAction SilentlyContinue
}
