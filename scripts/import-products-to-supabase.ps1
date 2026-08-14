param(
  [string]$Root = (Get-Location).Path,
  [string]$ProductsFile = 'products.json',
  [string]$FeaturedFile = 'products-featured.json',
  [string]$SupabaseUrl = '',
  [string]$SupabaseKey = '',
  [string]$ProductsTable = '',
  [string]$AdminEmail = '',
  [SecureString]$AdminPassword,
  [int]$ChunkSize = 200,
  [switch]$LegacySchema,
  [switch]$IncludeOperationalState,
  [switch]$Apply,
  [switch]$SkipVerify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ServerUserAgent = 'DJHC-Catalog-Importer/1.0'
$OperationalMetadataKeys = @(
  'sold_via',
  'stripe_session_id',
  'last_quantity_sold',
  'last_sold_at',
  'last_inventory_source',
  'last_shopify_webhook_id',
  'last_shopify_inventory_at',
  'last_shopify_source_updated_at'
)

function Get-ConfigValue {
  param(
    [string]$Content,
    [string]$Key
  )

  if ([string]::IsNullOrWhiteSpace($Content)) {
    return ''
  }

  $match = [regex]::Match($Content, [regex]::Escape($Key) + "\s*:\s*'([^']*)'")
  if ($match.Success) {
    return $match.Groups[1].Value.Trim()
  }

  return ''
}

function Test-IsPrivilegedSupabaseKey {
  param([string]$Key)

  if ([string]::IsNullOrWhiteSpace($Key)) {
    return $false
  }

  if ($Key.StartsWith('sb_secret_', [System.StringComparison]::OrdinalIgnoreCase)) {
    return $true
  }

  $parts = $Key.Split('.')
  if ($parts.Count -ne 3) {
    return $false
  }

  try {
    $payload = $parts[1].Replace('-', '+').Replace('_', '/')
    $payload = $payload.PadRight($payload.Length + ((4 - ($payload.Length % 4)) % 4), '=')
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
    $claims = $json | ConvertFrom-Json
    return ([string]$claims.role).Equals('service_role', [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function ConvertFrom-SecurePassword {
  param([SecureString]$Password)

  if ($null -eq $Password) {
    return ''
  }

  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Get-PropertyValue {
  param(
    $Object,
    [string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }

  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) {
      return $Object[$Name]
    }
    return $null
  }

  $property = $Object.PSObject.Properties[$Name]
  if ($null -ne $property) {
    return $property.Value
  }

  return $null
}

function Convert-ToBoolean {
  param($Value)

  if ($Value -is [bool]) {
    return $Value
  }

  $text = [string]$Value
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $false
  }

  switch ($text.Trim().ToLowerInvariant()) {
    'true' { return $true }
    '1' { return $true }
    'yes' { return $true }
    'y' { return $true }
    default { return $false }
  }
}

function Convert-ToNullableNumber {
  param($Value)

  if ($null -eq $Value -or $Value -eq '') {
    return $null
  }

  $number = 0.0
  if ([double]::TryParse([string]$Value, [ref]$number)) {
    return $number
  }

  return $null
}

function Convert-ToNullableInteger {
  param($Value)

  if ($null -eq $Value -or $Value -eq '') {
    return $null
  }

  $number = 0
  if ([int]::TryParse([string]$Value, [ref]$number)) {
    return $number
  }

  return $null
}

function Get-StringArray {
  param(
    $Value,
    [switch]$PreserveDuplicates
  )

  $items = New-Object System.Collections.ArrayList

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [string]) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
      return @()
    }
    $trimmed = ([string]$Value).Trim()
    if (-not $items.Contains($trimmed)) {
      [void]$items.Add($trimmed)
    }
    return @($items.ToArray())
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string]) -and -not ($Value -is [System.Collections.IDictionary])) {
    foreach ($item in $Value) {
      $trimmed = ([string]$item).Trim()
      if ([string]::IsNullOrWhiteSpace($trimmed)) {
        continue
      }
      if ($PreserveDuplicates -or -not $items.Contains($trimmed)) {
        [void]$items.Add($trimmed)
      }
    }

    return @($items.ToArray())
  }

  return @()
}

function Normalize-Object {
  param($Value)

  if ($null -eq $Value) {
    return [ordered]@{}
  }

  if ($Value -is [System.Collections.IDictionary]) {
    return $Value
  }

  if ($Value -is [pscustomobject]) {
    return $Value
  }

  return [ordered]@{}
}

function Get-ObjectEntries {
  param($Value)

  if ($Value -is [System.Collections.IDictionary]) {
    return @($Value.GetEnumerator() | ForEach-Object {
      [pscustomobject]@{ Name = [string]$_.Key; Value = $_.Value }
    })
  }
  if ($Value -is [pscustomobject]) {
    return @($Value.PSObject.Properties | ForEach-Object {
      [pscustomobject]@{ Name = [string]$_.Name; Value = $_.Value }
    })
  }
  return @()
}

function Test-OperationalMetadataKey {
  param([string]$Name)
  $normalized = ([string]$Name).Trim().ToLowerInvariant()
  return $OperationalMetadataKeys -contains $normalized -or
    $normalized.StartsWith('stripe_') -or
    $normalized.StartsWith('last_shopify_')
}

function Get-CatalogMetadata {
  param(
    $Value,
    [bool]$IncludeOperational = $false
  )
  $metadata = [ordered]@{}
  foreach ($entry in @(Get-ObjectEntries (Normalize-Object $Value))) {
    if ($IncludeOperational -or -not (Test-OperationalMetadataKey $entry.Name)) {
      $metadata[$entry.Name] = $entry.Value
    }
  }
  return $metadata
}

function Read-JsonArrayFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Could not find $Path."
  }

  $content = Get-Content -LiteralPath $Path -Raw -Encoding utf8
  $data = ConvertFrom-Json -InputObject $content
  return @($data)
}

function Get-FeaturedRankMap {
  param($FeaturedProducts)

  $rankMap = @{}
  $nextRank = 1

  foreach ($product in @($FeaturedProducts)) {
    $id = Convert-ToNullableInteger (Get-PropertyValue $product 'id')
    if ($null -eq $id -or $rankMap.ContainsKey($id)) {
      continue
    }

    $rankMap[$id] = $nextRank
    $nextRank++
  }

  return $rankMap
}

function Convert-ToRemoteProduct {
  param(
    $Product,
    [hashtable]$FeaturedRankMap,
    [bool]$UseLegacySchema = $false,
    [bool]$IncludeLiveState = $false
  )

  $id = Convert-ToNullableInteger (Get-PropertyValue $Product 'id')
  if ($null -eq $id) {
    return $null
  }

  $name = [string](Get-PropertyValue $Product 'name')
  if ([string]::IsNullOrWhiteSpace($name)) {
    return $null
  }

  $rawSortRankValue = Get-PropertyValue $Product 'sortRank'
  $rawSortRank = Convert-ToNullableInteger $rawSortRankValue
  $hasExplicitSortRank = $null -ne $rawSortRankValue -and $rawSortRankValue -ne '' -and $null -ne $rawSortRank
  $featuredRank = if ($FeaturedRankMap.ContainsKey($id)) { [int]$FeaturedRankMap[$id] } else { $null }
  $sortRank =
    if ($null -ne $featuredRank -and (-not $hasExplicitSortRank -or $rawSortRank -eq 0)) {
      $featuredRank
    } elseif ($hasExplicitSortRank) {
      $rawSortRank
    } else {
      0
    }

  $year = Convert-ToNullableInteger (Get-PropertyValue $Product 'year')
  $price = Convert-ToNullableNumber (Get-PropertyValue $Product 'price')
  $copyCount = Convert-ToNullableInteger (Get-PropertyValue $Product 'copyCount')
  $isFeatured = (Convert-ToBoolean (Get-PropertyValue $Product 'isFeatured')) -or $FeaturedRankMap.ContainsKey($id)
  $isDeleted = Convert-ToBoolean (Get-PropertyValue $Product 'isDeleted')
  $category = ([string](Get-PropertyValue $Product 'category')).Trim()
  if ([string]::IsNullOrWhiteSpace($category)) {
    $category = 'Other'
  }

  $remoteProduct = [ordered]@{
    id = $id
    name = $name.Trim()
    category = $category
    team = ([string](Get-PropertyValue $Product 'team')).Trim()
    year = $year
    condition = ([string](Get-PropertyValue $Product 'condition')).Trim()
    price = $price
    price_label = ([string](Get-PropertyValue $Product 'priceLabel')).Trim()
    display_price = ([string](Get-PropertyValue $Product 'displayPrice')).Trim()
    image = ([string](Get-PropertyValue $Product 'image')).Trim()
    image_gallery = @(Get-StringArray (Get-PropertyValue $Product 'imageGallery') -PreserveDuplicates)
    description = ([string](Get-PropertyValue $Product 'description')).Trim()
    photo_host_page_url = ([string](Get-PropertyValue $Product 'photoHostPageUrl')).Trim()
    legacy_image_label = ([string](Get-PropertyValue $Product 'legacyImageLabel')).Trim()
    source_page = ([string](Get-PropertyValue $Product 'sourcePage')).Trim()
    league = ([string](Get-PropertyValue $Product 'league')).Trim()
    sport = ([string](Get-PropertyValue $Product 'sport')).Trim()
    player_athlete = ([string](Get-PropertyValue $Product 'playerAthlete')).Trim()
    is_featured = $isFeatured
    sort_rank = $sortRank
  }

  if (-not $UseLegacySchema) {
    $remoteProduct['display_price'] = ([string](Get-PropertyValue $Product 'displayPrice')).Trim()
    $remoteProduct['checkout_price'] = Convert-ToNullableNumber (Get-PropertyValue $Product 'checkoutPrice')
    $remoteProduct['item_photo_url'] = ([string](Get-PropertyValue $Product 'itemPhotoUrl')).Trim()
    $remoteProduct['item_photo_urls'] = @(Get-StringArray (Get-PropertyValue $Product 'itemPhotoUrls'))
    $remoteProduct['html_full_link'] = ([string](Get-PropertyValue $Product 'htmlFullLink')).Trim()
    $remoteProduct['html_image_urls'] = @(Get-StringArray (Get-PropertyValue $Product 'htmlImageUrls'))
    $remoteProduct['metadata'] = Get-CatalogMetadata `
      -Value (Get-PropertyValue $Product 'metadata') `
      -IncludeOperational:$IncludeLiveState
  }

  if ($IncludeLiveState) {
    $quantityAvailable = Convert-ToNullableInteger (Get-PropertyValue $Product 'quantityAvailable')
    $remoteProduct['copy_count'] = $copyCount
    $remoteProduct['quantity_available'] = if ($null -ne $quantityAvailable) { $quantityAvailable } elseif ($null -ne $copyCount) { $copyCount } else { 1 }
    $remoteProduct['checkout_enabled'] = Convert-ToBoolean (Get-PropertyValue $Product 'checkoutEnabled')
    $remoteProduct['sale_status'] = ([string](Get-PropertyValue $Product 'saleStatus')).Trim()
    $remoteProduct['sold_at'] = Get-PropertyValue $Product 'soldAt'
    $remoteProduct['hidden_reason'] = ([string](Get-PropertyValue $Product 'hiddenReason')).Trim()
    $remoteProduct['archived_at'] = Get-PropertyValue $Product 'archivedAt'
    $remoteProduct['is_deleted'] = $isDeleted
  }

  return $remoteProduct
}

function Get-AccessToken {
  param(
    [string]$ProjectUrl,
    [string]$ApiKey,
    [string]$Email,
    [SecureString]$Password
  )

  if ([string]::IsNullOrWhiteSpace($Email) -and $null -eq $Password) {
    return $ApiKey
  }

  if ([string]::IsNullOrWhiteSpace($Email) -or $null -eq $Password) {
    throw 'Provide -AdminEmail and enter the admin password at the secure prompt, or inject SUPABASE_SERVICE_ROLE_KEY for this process.'
  }

  $plainPassword = ConvertFrom-SecurePassword -Password $Password
  $headers = @{
    apikey = $ApiKey
  }
  $bodyJson = @{
    email = $Email
    password = $plainPassword
  } | ConvertTo-Json -Compress
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
  $plainPassword = $null

  $response = Invoke-RestMethod `
    -Uri ($ProjectUrl.TrimEnd('/') + '/auth/v1/token?grant_type=password') `
    -Method Post `
    -Headers $headers `
    -UserAgent $ServerUserAgent `
    -ContentType 'application/json; charset=utf-8' `
    -Body $bodyBytes

  if ([string]::IsNullOrWhiteSpace([string]$response.access_token)) {
    throw 'Supabase auth succeeded but no access token was returned.'
  }

  return [string]$response.access_token
}

function Get-CommonHeaders {
  param(
    [string]$ApiKey,
    [string]$AccessToken
  )

  return @{
    apikey = $ApiKey
    Authorization = "Bearer $AccessToken"
  }
}

function Get-RemoteCount {
  param(
    [string]$ProjectUrl,
    [string]$Table,
    [hashtable]$Headers,
    [bool]$ActiveOnly = $true
  )

  $requestHeaders = @{}
  foreach ($key in $Headers.Keys) {
    $requestHeaders[$key] = $Headers[$key]
  }
  $requestHeaders['Prefer'] = 'count=exact'

  $activeFilter = if ($ActiveOnly) { '&is_deleted=eq.false' } else { '' }
  $response = Invoke-WebRequest `
    -Uri ($ProjectUrl.TrimEnd('/') + "/rest/v1/${Table}?select=id&limit=1${activeFilter}") `
    -Method Head `
    -Headers $requestHeaders `
    -UserAgent $ServerUserAgent `
    -UseBasicParsing

  $contentRange = if ($response.Headers) { [string]$response.Headers['Content-Range'] } else { '' }
  if ($contentRange -match '/(?<count>\d+)$') {
    return [int]$matches['count']
  }

  return $null
}

function Invoke-ChunkUpsert {
  param(
    [string]$ProjectUrl,
    [string]$Table,
    [hashtable]$Headers,
    [object[]]$Rows
  )

  $requestHeaders = @{}
  foreach ($key in $Headers.Keys) {
    $requestHeaders[$key] = $Headers[$key]
  }
  $requestHeaders['Prefer'] = 'resolution=merge-duplicates,return=minimal'

  $bodyJson = ConvertTo-Json -InputObject $Rows -Depth 40 -Compress
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)

  Invoke-RestMethod `
    -Uri ($ProjectUrl.TrimEnd('/') + "/rest/v1/${Table}?on_conflict=id") `
    -Method Post `
    -Headers $requestHeaders `
    -UserAgent $ServerUserAgent `
    -ContentType 'application/json; charset=utf-8' `
    -Body $bodyBytes | Out-Null
}

function Merge-RemoteOperationalMetadata {
  param(
    [string]$ProjectUrl,
    [string]$Table,
    [hashtable]$Headers,
    [object[]]$Rows
  )
  $metadataRows = @($Rows | Where-Object {
    $_ -is [System.Collections.IDictionary] -and $_.Contains('metadata')
  })
  if (-not $metadataRows.Count) { return }

  $ids = @($metadataRows | ForEach-Object { [int](Get-PropertyValue $_ 'id') })
  $uri = $ProjectUrl.TrimEnd('/') + "/rest/v1/${Table}?select=id,metadata&id=in.($($ids -join ','))"
  $actualRows = @(Invoke-RestMethod -Uri $uri -Method Get -Headers $Headers -UserAgent $ServerUserAgent)
  $actualById = @{}
  foreach ($actual in $actualRows) { $actualById[[int](Get-PropertyValue $actual 'id')] = $actual }

  foreach ($row in $metadataRows) {
    $id = [int](Get-PropertyValue $row 'id')
    $merged = Get-CatalogMetadata -Value (Get-PropertyValue $row 'metadata')
    $remoteMetadata = Get-PropertyValue $actualById[$id] 'metadata'
    foreach ($entry in @(Get-ObjectEntries $remoteMetadata)) {
      if (Test-OperationalMetadataKey $entry.Name) {
        $merged[$entry.Name] = $entry.Value
      }
    }
    $row['metadata'] = $merged
  }
}

function Test-IsNumber {
  param($Value)
  return $Value -is [byte] -or $Value -is [sbyte] -or $Value -is [int16] -or
    $Value -is [uint16] -or $Value -is [int32] -or $Value -is [uint32] -or
    $Value -is [int64] -or $Value -is [uint64] -or $Value -is [single] -or
    $Value -is [double] -or $Value -is [decimal]
}

function Get-ComparablePropertyNames {
  param($Value)
  if ($Value -is [System.Collections.IDictionary]) {
    return @($Value.Keys | ForEach-Object { [string]$_ } | Sort-Object)
  }
  if ($Value -is [pscustomobject]) {
    return @($Value.PSObject.Properties.Name | Sort-Object)
  }
  return @()
}

function Test-DeepEquivalent {
  param($Left, $Right)
  if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
  if ((Test-IsNumber $Left) -and (Test-IsNumber $Right)) {
    return [decimal]$Left -eq [decimal]$Right
  }
  if ($Left -is [bool] -or $Right -is [bool]) { return [bool]$Left -eq [bool]$Right }

  $leftKeys = @(Get-ComparablePropertyNames $Left)
  $rightKeys = @(Get-ComparablePropertyNames $Right)
  if ($leftKeys.Count -or $rightKeys.Count) {
    if (($leftKeys -join "`n") -ne ($rightKeys -join "`n")) { return $false }
    foreach ($key in $leftKeys) {
      if (-not (Test-DeepEquivalent (Get-PropertyValue $Left $key) (Get-PropertyValue $Right $key))) { return $false }
    }
    return $true
  }

  $leftEnumerable = $Left -is [System.Collections.IEnumerable] -and -not ($Left -is [string])
  $rightEnumerable = $Right -is [System.Collections.IEnumerable] -and -not ($Right -is [string])
  if ($leftEnumerable -or $rightEnumerable) {
    if (-not ($leftEnumerable -and $rightEnumerable)) { return $false }
    $leftItems = @($Left)
    $rightItems = @($Right)
    if ($leftItems.Count -ne $rightItems.Count) { return $false }
    for ($index = 0; $index -lt $leftItems.Count; $index++) {
      if (-not (Test-DeepEquivalent $leftItems[$index] $rightItems[$index])) { return $false }
    }
    return $true
  }
  return [string]$Left -ceq [string]$Right
}

function Assert-RemoteRowsMatch {
  param(
    [string]$ProjectUrl,
    [string]$Table,
    [hashtable]$Headers,
    [object[]]$Rows
  )
  if (-not $Rows.Count) { return }
  $fields = @($Rows[0].Keys | ForEach-Object { [string]$_ })
  $ids = @($Rows | ForEach-Object { [int](Get-PropertyValue $_ 'id') })
  $select = [uri]::EscapeDataString(($fields -join ','))
  $idFilter = $ids -join ','
  $uri = $ProjectUrl.TrimEnd('/') + "/rest/v1/${Table}?select=${select}&id=in.(${idFilter})"
  $actualRows = @(Invoke-RestMethod -Uri $uri -Method Get -Headers $Headers -UserAgent $ServerUserAgent)
  $actualById = @{}
  foreach ($actual in $actualRows) { $actualById[[int](Get-PropertyValue $actual 'id')] = $actual }

  $mismatches = New-Object System.Collections.ArrayList
  foreach ($expected in $Rows) {
    $id = [int](Get-PropertyValue $expected 'id')
    $actual = $actualById[$id]
    if ($null -eq $actual) {
      [void]$mismatches.Add("${id}: missing remote row")
      continue
    }
    foreach ($field in $fields) {
      if (-not (Test-DeepEquivalent (Get-PropertyValue $expected $field) (Get-PropertyValue $actual $field))) {
        [void]$mismatches.Add("${id}.${field}")
        if ($mismatches.Count -ge 20) { break }
      }
    }
    if ($mismatches.Count -ge 20) { break }
  }
  if ($mismatches.Count) {
    throw "Field-level verification failed: $($mismatches -join ', ')"
  }
}

$backendConfigPath = Join-Path $Root 'backend-config.js'
$backendConfig = if (Test-Path -LiteralPath $backendConfigPath) {
  Get-Content -LiteralPath $backendConfigPath -Raw -Encoding utf8
} else {
  ''
}

if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) {
  $SupabaseUrl = Get-ConfigValue -Content $backendConfig -Key 'supabaseUrl'
}
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) {
  $SupabaseKey = Get-ConfigValue -Content $backendConfig -Key 'supabasePublishableKey'
}
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) {
  $SupabaseKey = Get-ConfigValue -Content $backendConfig -Key 'supabaseAnonKey'
}
if ([string]::IsNullOrWhiteSpace($ProductsTable)) {
  $ProductsTable = Get-ConfigValue -Content $backendConfig -Key 'productsTable'
}
if ([string]::IsNullOrWhiteSpace($ProductsTable)) {
  $ProductsTable = 'products'
}

if ([string]::IsNullOrWhiteSpace($SupabaseUrl)) {
  throw 'Supabase URL is required. Pass -SupabaseUrl or set it in backend-config.js.'
}
if (Test-IsPrivilegedSupabaseKey -Key $SupabaseKey) {
  throw 'Do not pass a Supabase service-role key through -SupabaseKey or browser config. Inject SUPABASE_SERVICE_ROLE_KEY for this process instead.'
}
if ($SupabaseUrl -notmatch '^https://[a-z0-9-]+\.supabase\.co/?$') {
  throw "Supabase URL '$SupabaseUrl' is not in the expected project format."
}

$serviceRoleKey = [string]$env:SUPABASE_SERVICE_ROLE_KEY
if ($Apply -and [string]::IsNullOrWhiteSpace($SupabaseKey) -and [string]::IsNullOrWhiteSpace($serviceRoleKey)) {
  throw 'A Supabase publishable key or injected SUPABASE_SERVICE_ROLE_KEY is required.'
}
if ($Apply -and -not [string]::IsNullOrWhiteSpace($serviceRoleKey) -and
    (-not [string]::IsNullOrWhiteSpace($AdminEmail) -or $null -ne $AdminPassword)) {
  throw 'Choose one privileged authentication method: injected SUPABASE_SERVICE_ROLE_KEY or the admin secure-prompt flow.'
}

$apiKey = if ([string]::IsNullOrWhiteSpace($serviceRoleKey)) { $SupabaseKey } else { $serviceRoleKey }
if ($Apply -and [string]::IsNullOrWhiteSpace($serviceRoleKey) -and
    -not [string]::IsNullOrWhiteSpace($AdminEmail) -and
    $null -eq $AdminPassword) {
  $AdminPassword = Read-Host "Supabase admin password" -AsSecureString
}
if ($Apply -and [string]::IsNullOrWhiteSpace($serviceRoleKey) -and [string]::IsNullOrWhiteSpace($AdminEmail)) {
  throw 'Provide -AdminEmail and use the secure password prompt, or inject SUPABASE_SERVICE_ROLE_KEY for this process.'
}

$productsPath = Join-Path $Root $ProductsFile
$featuredPath = Join-Path $Root $FeaturedFile

$products = Read-JsonArrayFile -Path $productsPath
$featuredProducts = if (Test-Path -LiteralPath $featuredPath) {
  Read-JsonArrayFile -Path $featuredPath
} else {
  @()
}

$featuredRankMap = Get-FeaturedRankMap -FeaturedProducts $featuredProducts
$remoteProducts = New-Object System.Collections.ArrayList

foreach ($product in $products) {
  $remoteProduct = Convert-ToRemoteProduct -Product $product -FeaturedRankMap $featuredRankMap -UseLegacySchema:$LegacySchema -IncludeLiveState:$IncludeOperationalState
  if ($null -ne $remoteProduct) {
    [void]$remoteProducts.Add($remoteProduct)
  }
}

if ($remoteProducts.Count -eq 0) {
  throw "No valid products were found in $ProductsFile."
}

Write-Output ("Prepared {0} product rows for upsert." -f $remoteProducts.Count)
Write-Output ("Featured listings preserved: {0}" -f $featuredRankMap.Count)
Write-Output ("Target table: {0}" -f $ProductsTable)
Write-Output ("Schema mode: {0}" -f ($(if ($LegacySchema) { 'legacy-compatible' } else { 'extended' })))
Write-Output ("Operational state: {0}" -f ($(if ($IncludeOperationalState) { 'included by explicit request' } else { 'preserved remotely' })))

if (-not $Apply) {
  Write-Output 'Audit only: no Supabase authentication or writes were performed. Re-run with -Apply to execute this reviewed import.'
  return
}

$accessToken = Get-AccessToken -ProjectUrl $SupabaseUrl -ApiKey $apiKey -Email $AdminEmail -Password $AdminPassword
$headers = Get-CommonHeaders -ApiKey $apiKey -AccessToken $accessToken

$uploaded = 0
for ($index = 0; $index -lt $remoteProducts.Count; $index += $ChunkSize) {
  $slice = @($remoteProducts[$index..([Math]::Min($index + $ChunkSize - 1, $remoteProducts.Count - 1))])
  if (-not $IncludeOperationalState -and -not $LegacySchema) {
    Merge-RemoteOperationalMetadata -ProjectUrl $SupabaseUrl -Table $ProductsTable -Headers $headers -Rows $slice
  }
  Invoke-ChunkUpsert -ProjectUrl $SupabaseUrl -Table $ProductsTable -Headers $headers -Rows $slice
  if (-not $SkipVerify) {
    Assert-RemoteRowsMatch -ProjectUrl $SupabaseUrl -Table $ProductsTable -Headers $headers -Rows $slice
  }
  $uploaded += $slice.Count
  Write-Output ("Upserted {0}/{1} rows..." -f $uploaded, $remoteProducts.Count)
}

if (-not $SkipVerify) {
  $remoteCount = Get-RemoteCount -ProjectUrl $SupabaseUrl -Table $ProductsTable -Headers $headers -ActiveOnly:(-not $LegacySchema)
  if ($null -ne $remoteCount) {
    Write-Output ("Remote table now reports {0} row(s); every imported field was read back and verified." -f $remoteCount)
  }
}

Write-Output 'Supabase product import completed.'
