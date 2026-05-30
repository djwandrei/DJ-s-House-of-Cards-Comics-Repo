param(
  [string]$Root = (Get-Location).Path,
  [string]$ProductsFile = 'products.json',
  [string]$FeaturedFile = 'products-featured.json',
  [string]$SupabaseUrl = '',
  [string]$SupabaseKey = '',
  [string]$ProductsTable = '',
  [string]$AdminEmail = '',
  [string]$AdminPassword = '',
  [int]$ChunkSize = 200,
  [switch]$LegacySchema,
  [switch]$SkipVerify
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
  param($Value)

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
      if (-not $items.Contains($trimmed)) {
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
    [bool]$UseLegacySchema = $false
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
    image_gallery = @(Get-StringArray (Get-PropertyValue $Product 'imageGallery'))
    description = ([string](Get-PropertyValue $Product 'description')).Trim()
    photo_host_page_url = ([string](Get-PropertyValue $Product 'photoHostPageUrl')).Trim()
    legacy_image_label = ([string](Get-PropertyValue $Product 'legacyImageLabel')).Trim()
    source_page = ([string](Get-PropertyValue $Product 'sourcePage')).Trim()
    league = ([string](Get-PropertyValue $Product 'league')).Trim()
    sport = ([string](Get-PropertyValue $Product 'sport')).Trim()
    player_athlete = ([string](Get-PropertyValue $Product 'playerAthlete')).Trim()
    is_featured = $isFeatured
    is_deleted = $isDeleted
    sort_rank = $sortRank
  }

  if (-not $UseLegacySchema) {
    $remoteProduct['display_price'] = ([string](Get-PropertyValue $Product 'displayPrice')).Trim()
    $remoteProduct['copy_count'] = $copyCount
    $remoteProduct['item_photo_url'] = ([string](Get-PropertyValue $Product 'itemPhotoUrl')).Trim()
    $remoteProduct['item_photo_urls'] = @(Get-StringArray (Get-PropertyValue $Product 'itemPhotoUrls'))
    $remoteProduct['html_full_link'] = ([string](Get-PropertyValue $Product 'htmlFullLink')).Trim()
    $remoteProduct['html_image_urls'] = @(Get-StringArray (Get-PropertyValue $Product 'htmlImageUrls'))
    $remoteProduct['metadata'] = Normalize-Object (Get-PropertyValue $Product 'metadata')
  }

  return $remoteProduct
}

function Get-AccessToken {
  param(
    [string]$ProjectUrl,
    [string]$ApiKey,
    [string]$Email,
    [string]$Password
  )

  if ([string]::IsNullOrWhiteSpace($Email) -and [string]::IsNullOrWhiteSpace($Password)) {
    return $ApiKey
  }

  if ([string]::IsNullOrWhiteSpace($Email) -or [string]::IsNullOrWhiteSpace($Password)) {
    throw 'Provide both -AdminEmail and -AdminPassword, or provide neither and use a service-role key as -SupabaseKey.'
  }

  $headers = @{
    apikey = $ApiKey
  }
  $body = @{
    email = $Email
    password = $Password
  } | ConvertTo-Json -Compress

  $response = Invoke-RestMethod `
    -Uri ($ProjectUrl.TrimEnd('/') + '/auth/v1/token?grant_type=password') `
    -Method Post `
    -Headers $headers `
    -ContentType 'application/json' `
    -Body $body

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
    [hashtable]$Headers
  )

  $requestHeaders = @{}
  foreach ($key in $Headers.Keys) {
    $requestHeaders[$key] = $Headers[$key]
  }
  $requestHeaders['Prefer'] = 'count=exact'

  $response = Invoke-WebRequest `
    -Uri ($ProjectUrl.TrimEnd('/') + "/rest/v1/${Table}?select=id&limit=1") `
    -Method Get `
    -Headers $requestHeaders

  $contentRange = [string]$response.Headers['Content-Range']
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

  $body = ConvertTo-Json -InputObject $Rows -Depth 40 -Compress

  Invoke-RestMethod `
    -Uri ($ProjectUrl.TrimEnd('/') + "/rest/v1/${Table}?on_conflict=id") `
    -Method Post `
    -Headers $requestHeaders `
    -ContentType 'application/json' `
    -Body $body | Out-Null
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
if ([string]::IsNullOrWhiteSpace($SupabaseKey)) {
  throw 'Supabase key is required. Pass -SupabaseKey or set it in backend-config.js.'
}
if ($SupabaseUrl -notmatch '^https://[a-z0-9-]+\.supabase\.co/?$') {
  throw "Supabase URL '$SupabaseUrl' is not in the expected project format."
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
  $remoteProduct = Convert-ToRemoteProduct -Product $product -FeaturedRankMap $featuredRankMap -UseLegacySchema:$LegacySchema
  if ($null -ne $remoteProduct) {
    [void]$remoteProducts.Add($remoteProduct)
  }
}

if ($remoteProducts.Count -eq 0) {
  throw "No valid products were found in $ProductsFile."
}

$accessToken = Get-AccessToken -ProjectUrl $SupabaseUrl -ApiKey $SupabaseKey -Email $AdminEmail -Password $AdminPassword
$headers = Get-CommonHeaders -ApiKey $SupabaseKey -AccessToken $accessToken

Write-Output ("Prepared {0} product rows for upsert." -f $remoteProducts.Count)
Write-Output ("Featured listings preserved: {0}" -f $featuredRankMap.Count)
Write-Output ("Target table: {0}" -f $ProductsTable)
Write-Output ("Schema mode: {0}" -f ($(if ($LegacySchema) { 'legacy-compatible' } else { 'extended' })))

$uploaded = 0
for ($index = 0; $index -lt $remoteProducts.Count; $index += $ChunkSize) {
  $slice = @($remoteProducts[$index..([Math]::Min($index + $ChunkSize - 1, $remoteProducts.Count - 1))])
  Invoke-ChunkUpsert -ProjectUrl $SupabaseUrl -Table $ProductsTable -Headers $headers -Rows $slice
  $uploaded += $slice.Count
  Write-Output ("Upserted {0}/{1} rows..." -f $uploaded, $remoteProducts.Count)
}

if (-not $SkipVerify) {
  try {
    $remoteCount = Get-RemoteCount -ProjectUrl $SupabaseUrl -Table $ProductsTable -Headers $headers
    if ($null -ne $remoteCount) {
      Write-Output ("Remote table now reports {0} row(s)." -f $remoteCount)
    }
  } catch {
    Write-Output ("Verification count skipped: {0}" -f $_.Exception.Message)
  }
}

Write-Output 'Supabase product import completed.'
