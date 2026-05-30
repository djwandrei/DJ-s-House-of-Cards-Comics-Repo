param(
  [string]$WorkbookPath,
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$OutputPath = '',
  [switch]$NoBackup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

function Get-FieldMap {
  param($Object)

  $map = @{}
  if ($null -eq $Object) {
    return $map
  }

  if ($Object -is [System.Collections.IDictionary]) {
    foreach ($key in $Object.Keys) {
      $map[[string]$key] = $Object[$key]
    }
    return $map
  }

  foreach ($property in $Object.PSObject.Properties) {
    $map[[string]$property.Name] = $property.Value
  }

  return $map
}

function Normalize-Title {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ''
  }

  $normalized = $Value `
    -replace [char]0xFEFF, '' `
    -replace [char]0x2018, "'" `
    -replace [char]0x2019, "'" `
    -replace [char]0x201C, '"' `
    -replace [char]0x201D, '"'

  $normalized = [regex]::Replace($normalized, '\s+', ' ').Trim().ToLowerInvariant()
  return $normalized
}

function Get-UniqueTextList {
  param($Value)

  $results = New-Object System.Collections.Generic.List[string]
  $seen = @{}

  $appendText = {
    param([string]$Text)

    if ([string]::IsNullOrWhiteSpace($Text)) {
      return
    }

    foreach ($part in ($Text -split '\s*\|\s*')) {
      $clean = [string]$part
      $clean = [regex]::Replace($clean, '\s+', ' ').Trim()
      if (-not $clean) {
        continue
      }

      if (-not $seen.ContainsKey($clean)) {
        $seen[$clean] = $true
        $results.Add($clean)
      }
    }
  }

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [string]) {
    & $appendText $Value
    return $results.ToArray()
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
    foreach ($entry in $Value) {
      if ($entry -is [string]) {
        & $appendText $entry
        continue
      }

      $entryMap = Get-FieldMap $entry
      if ($entryMap.Count) {
        foreach ($fieldValue in $entryMap.Values) {
          if ($fieldValue -is [string]) {
            & $appendText $fieldValue
          }
        }
        continue
      }

      & $appendText ([string]$entry)
    }

    return $results.ToArray()
  }

  $fieldMap = Get-FieldMap $Value
  if ($fieldMap.Count) {
    foreach ($fieldValue in $fieldMap.Values) {
      if ($fieldValue -is [string]) {
        & $appendText $fieldValue
      }
    }

    return $results.ToArray()
  }

  & $appendText ([string]$Value)
  return $results.ToArray()
}

function Invoke-ExcelRetry {
  param(
    [scriptblock]$Script,
    [int]$MaxAttempts = 12,
    [int]$DelayMilliseconds = 250
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
      return & $Script
    } catch [System.Runtime.InteropServices.COMException] {
      $hresult = $_.Exception.HResult
      if (($hresult -ne -2147418111) -and ($hresult -ne -2146777998) -and ($attempt -ge $MaxAttempts)) {
        throw
      }

      if (($hresult -ne -2147418111) -and ($hresult -ne -2146777998)) {
        throw
      }

      Start-Sleep -Milliseconds ($DelayMilliseconds * $attempt)
    }
  }

  throw 'Excel remained busy after repeated retry attempts.'
}

function Get-ExcelCellText {
  param(
    $Worksheet,
    [int]$Row,
    [int]$Column
  )

  return [string](Invoke-ExcelRetry { $Worksheet.Cells.Item($Row, $Column).Text })
}

function Set-ExcelCellValue {
  param(
    $Worksheet,
    [int]$Row,
    [int]$Column,
    $Value
  )

  Invoke-ExcelRetry {
    $Worksheet.Cells.Item($Row, $Column).Value2 = $Value
  } | Out-Null
}

function Join-UniqueTextList {
  param($Value)

  $items = @(Get-UniqueTextList $Value)
  if ($items.Count -eq 0) {
    return ''
  }

  return ($items -join ' | ')
}

function Get-DescriptionField {
  param(
    [string]$Description,
    [string]$Label
  )

  if ([string]::IsNullOrWhiteSpace($Description)) {
    return ''
  }

  $match = [regex]::Match($Description, [regex]::Escape($Label) + ':\s*([^;' + "`r`n" + ']+)', 'IgnoreCase')
  if ($match.Success) {
    return [regex]::Replace($match.Groups[1].Value, '\s+', ' ').Trim()
  }

  return ''
}

function Get-AutographValue {
  param(
    $Product,
    [hashtable]$ExcelFields
  )

  $text = @(
    [string](Get-PropertyValue $Product 'name'),
    [string](Get-PropertyValue $Product 'description'),
    [string]$ExcelFields['C:Features'],
    [string]$ExcelFields['C:Autographed']
  ) -join ' '

  if ($text -match '\b(auto(graph)?|signed|signature|on-card auto|sticker auto)\b') {
    return 'Yes'
  }

  return 'No'
}

function Get-FeatureValue {
  param(
    $Product,
    [hashtable]$ExcelFields
  )

  $description = [string](Get-PropertyValue $Product 'description')
  $featureText = Get-DescriptionField -Description $description -Label 'Features'
  if ($featureText) {
    $featureText = [regex]::Replace($featureText, '\.\s*(Please review|Great for)\b.*$', '', 'IgnoreCase').TrimEnd('.', ';', ' ')
    return ((Get-UniqueTextList $featureText) -join '|')
  }

  $existing = [string]$ExcelFields['C:Features']
  if ($existing) {
    return ((Get-UniqueTextList $existing) -join '|')
  }

  return ''
}

function Get-GradingFields {
  param(
    $Product,
    [hashtable]$ExcelFields,
    [hashtable]$ExistingRow
  )

  $condition = [string](Get-PropertyValue $Product 'condition')
  $condition = [regex]::Replace($condition, '\s+', ' ').Trim()

  $gradingMatch = [regex]::Match($condition, '\b(PSA/DNA|PSA|BGS|BVG|BCCG|SGC|CGC|CSG|HGA|GMA|ISA|TAG|Beckett)\b', 'IgnoreCase')
  if ($gradingMatch.Success) {
    $grader = $gradingMatch.Groups[1].Value
    if ($grader -eq 'BECKETT') {
      $grader = 'Beckett'
    } else {
      $grader = $grader.ToUpperInvariant()
    }

    $grade = $condition.Substring($gradingMatch.Index + $gradingMatch.Length).Trim()
    return @{
      'Condition ID' = '2750-Graded'
      'CD:Professional Grader - (ID: 27501)' = $grader
      'CD:Grade - (ID: 27502)' = $grade
      'CD:Card Condition - (ID: 40001)' = ''
    }
  }

  $cardCondition = [string]$ExcelFields['CD:Card Condition - (ID: 40001)']
  if (-not $cardCondition) {
    $cardCondition = [string]$ExistingRow['CD:Card Condition - (ID: 40001)']
  }
  if (-not $cardCondition -and $condition -eq 'Near mint or better') {
    $cardCondition = 'Near mint or better - (ID: 400010)'
  }

  return @{
    'Condition ID' = '4000-Ungraded'
    'CD:Professional Grader - (ID: 27501)' = ''
    'CD:Grade - (ID: 27502)' = ''
    'CD:Card Condition - (ID: 40001)' = $cardCondition
  }
}

function Get-YearManufacturedValue {
  param(
    $Product,
    [string]$Description,
    [hashtable]$ExcelFields,
    [hashtable]$ExistingRow
  )

  $yearValue = Get-PropertyValue $Product 'year'
  if ($null -ne $yearValue -and [string]$yearValue -ne '') {
    $number = 0
    if ([int]::TryParse([string]$yearValue, [ref]$number)) {
      return $number
    }
    return [string]$yearValue
  }

  $detailYear = Get-DescriptionField -Description $Description -Label 'Year'
  if ($detailYear) {
    $number = 0
    if ([int]::TryParse($detailYear, [ref]$number)) {
      return $number
    }
    return $detailYear
  }

  if ($ExcelFields.ContainsKey('C:Year Manufactured') -and $ExcelFields['C:Year Manufactured'] -ne $null -and [string]$ExcelFields['C:Year Manufactured'] -ne '') {
    return $ExcelFields['C:Year Manufactured']
  }

  return [string]$ExistingRow['C:Year Manufactured']
}

function Get-PreferredDescription {
  param(
    $Product,
    [hashtable]$ExcelFields,
    [hashtable]$ExistingRow
  )

  $description = [string](Get-PropertyValue $Product 'description')
  if ($description -and $description -notmatch '^Imported from the legacy') {
    return $description
  }

  if ([string]$ExcelFields['Description']) {
    return [string]$ExcelFields['Description']
  }

  return [string]$ExistingRow['Description']
}

function Get-ProductUpdateMap {
  param(
    $Product,
    [hashtable]$ExistingRow
  )

  $metadata = Get-PropertyValue $Product 'metadata'
  $excelFields = Get-FieldMap (Get-PropertyValue $metadata 'excelFields')

  $description = Get-PreferredDescription -Product $Product -ExcelFields $excelFields -ExistingRow $ExistingRow
  $itemPhotoUrl = Join-UniqueTextList @(
    (Get-PropertyValue $Product 'itemPhotoUrls'),
    (Get-PropertyValue $Product 'itemPhotoUrl'),
    $excelFields['Item photo URL'],
    $ExistingRow['Item photo URL']
  )
  $htmlFullLink = Join-UniqueTextList @(
    (Get-PropertyValue $Product 'htmlFullLink'),
    $excelFields['HTML Full Link'],
    $ExistingRow['HTML Full Link']
  )
  $sport = [string](Get-PropertyValue $Product 'sport')
  if (-not $sport) {
    $sport = [string](Get-PropertyValue $Product 'category')
  }
  if (-not $sport) {
    $sport = [string]$excelFields['C:Sport']
  }

  $team = [string](Get-PropertyValue $Product 'team')
  if (-not $team) {
    $team = [string]$excelFields['C:Team']
  }

  $league = [string](Get-PropertyValue $Product 'league')
  if (-not $league) {
    $league = [string]$excelFields['C:League']
  }

  $player = [string](Get-PropertyValue $Product 'playerAthlete')
  if (-not $player) {
    $player = [string]$excelFields['C:Player/Athlete']
  }

  $featureValue = Get-FeatureValue -Product $Product -ExcelFields $excelFields
  $autographValue = Get-AutographValue -Product $Product -ExcelFields $excelFields
  $setValue = Get-DescriptionField -Description $description -Label 'Set'
  if (-not $setValue) {
    $setValue = [string]$excelFields['C:Set']
  }
  $seasonValue = Get-DescriptionField -Description $description -Label 'Season'
  if (-not $seasonValue) {
    $seasonValue = [string]$excelFields['C:Season']
  }
  $yearManufactured = Get-YearManufacturedValue -Product $Product -Description $description -ExcelFields $excelFields -ExistingRow $ExistingRow

  $updates = @{
    'Title' = [string](Get-PropertyValue $Product 'name')
    'Item photo URL' = $itemPhotoUrl
    'HTML Full Link' = $htmlFullLink
    'Description' = $description
    'C:Player/Athlete' = $player
    'C:Sport' = $sport
    'C:Features' = $featureValue
    'C:League' = $league
    'C:Team' = $team
    'C:Autographed' = $autographValue
    'C:Set' = $setValue
    'C:Season' = $seasonValue
    'C:Year Manufactured' = $yearManufactured
  }

  foreach ($entry in (Get-GradingFields -Product $Product -ExcelFields $excelFields -ExistingRow $ExistingRow).GetEnumerator()) {
    $updates[$entry.Key] = $entry.Value
  }

  return $updates
}

function Get-UpdateSignature {
  param([hashtable]$UpdateMap)

  return (
    $UpdateMap.Keys |
      Sort-Object |
      ForEach-Object { "{0}={1}" -f $_, [string]$UpdateMap[$_] }
  ) -join ';'
}

if (-not $WorkbookPath) {
  throw 'WorkbookPath is required.'
}

$resolvedWorkbook = (Resolve-Path -LiteralPath $WorkbookPath).Path
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path

$productFiles = @(
  'products-baseball.json',
  'products-basketball.json',
  'products-football.json',
  'products-collectibles.json'
)

$allProducts = New-Object System.Collections.Generic.List[object]
foreach ($file in $productFiles) {
  $path = Join-Path $resolvedRoot $file
  $rows = Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json
  foreach ($row in $rows) {
    $allProducts.Add($row)
  }
}

$productMap = @{}
foreach ($product in $allProducts) {
  $candidateTitles = New-Object System.Collections.Generic.List[string]
  $name = [string](Get-PropertyValue $product 'name')
  if ($name) {
    $candidateTitles.Add($name)
  }

  $excelFields = Get-FieldMap (Get-PropertyValue (Get-PropertyValue $product 'metadata') 'excelFields')
  $excelTitle = [string]$excelFields['Title']
  if ($excelTitle -and $excelTitle -ne $name) {
    $candidateTitles.Add($excelTitle)
  }

  foreach ($title in $candidateTitles) {
    $key = Normalize-Title $title
    if (-not $key) {
      continue
    }

    if (-not $productMap.ContainsKey($key)) {
      $productMap[$key] = New-Object System.Collections.Generic.List[object]
    }

    $productMap[$key].Add($product)
  }
}

$backupPath = ''
if (-not $NoBackup) {
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupPath = [System.IO.Path]::Combine(
    [System.IO.Path]::GetDirectoryName($resolvedWorkbook),
    ([System.IO.Path]::GetFileNameWithoutExtension($resolvedWorkbook) + ".backup-$timestamp" + [System.IO.Path]::GetExtension($resolvedWorkbook))
  )
  Copy-Item -LiteralPath $resolvedWorkbook -Destination $backupPath -Force
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false

$workbook = $excel.Workbooks.Open($resolvedWorkbook)
$worksheet = $workbook.Worksheets.Item(1)
$usedRange = $worksheet.UsedRange

$headerMap = @{}
for ($column = 1; $column -le $usedRange.Columns.Count; $column++) {
  $header = Get-ExcelCellText -Worksheet $worksheet -Row 1 -Column $column
  if ($header) {
    $headerMap[$header] = $column
  }
}

$targetHeaders = @(
  'Title',
  'Item photo URL',
  'HTML Full Link',
  'Description',
  'Condition ID',
  'CD:Professional Grader - (ID: 27501)',
  'CD:Grade - (ID: 27502)',
  'CD:Card Condition - (ID: 40001)',
  'C:Player/Athlete',
  'C:Sport',
  'C:Features',
  'C:League',
  'C:Team',
  'C:Autographed',
  'C:Set',
  'C:Season',
  'C:Year Manufactured'
)

$rowsMatched = 0
$rowsUpdated = 0
$cellsUpdated = 0
$rowsNoMatch = 0
$rowsAmbiguous = 0
$touchedHeaders = @{}

for ($rowIndex = 2; $rowIndex -le $usedRange.Rows.Count; $rowIndex++) {
  $title = Get-ExcelCellText -Worksheet $worksheet -Row $rowIndex -Column $headerMap['Title']
  if ([string]::IsNullOrWhiteSpace($title)) {
    continue
  }

  $key = Normalize-Title $title
  if (-not $productMap.ContainsKey($key)) {
    $rowsNoMatch++
    continue
  }

  $existingRow = @{}
  foreach ($header in $targetHeaders) {
    if ($headerMap.ContainsKey($header)) {
      $existingRow[$header] = Get-ExcelCellText -Worksheet $worksheet -Row $rowIndex -Column $headerMap[$header]
    }
  }

  $candidateUpdates = New-Object System.Collections.Generic.List[hashtable]
  foreach ($candidate in $productMap[$key]) {
    $candidateUpdates.Add((Get-ProductUpdateMap -Product $candidate -ExistingRow $existingRow))
  }

  $signatures = @($candidateUpdates | ForEach-Object { Get-UpdateSignature $_ } | Select-Object -Unique)
  if ($signatures.Count -gt 1) {
    $rowsAmbiguous++
    continue
  }

  $updateMap = $candidateUpdates[0]
  $rowsMatched++
  $rowChanged = $false

  foreach ($header in $targetHeaders) {
    if (-not $headerMap.ContainsKey($header) -or -not $updateMap.ContainsKey($header)) {
      continue
    }

    $columnIndex = $headerMap[$header]
    $newValue = $updateMap[$header]
    if ($null -eq $newValue) {
      $newValue = ''
    }

    $oldValue = Get-ExcelCellText -Worksheet $worksheet -Row $rowIndex -Column $columnIndex
    $newText = [string]$newValue
    if ($oldValue -ceq $newText) {
      continue
    }

    Set-ExcelCellValue -Worksheet $worksheet -Row $rowIndex -Column $columnIndex -Value $newValue
    $cellsUpdated++
    $rowChanged = $true
    if (-not $touchedHeaders.ContainsKey($header)) {
      $touchedHeaders[$header] = 0
    }
    $touchedHeaders[$header]++
  }

  if ($rowChanged) {
    $rowsUpdated++
  }
}

if ($OutputPath) {
  $resolvedOutput = $OutputPath
  $workbook.SaveAs($resolvedOutput)
} else {
  $workbook.Save()
  $resolvedOutput = $resolvedWorkbook
}

$workbook.Close($true)
$excel.Quit()

[System.Runtime.Interopservices.Marshal]::ReleaseComObject($usedRange) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($worksheet) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($workbook) | Out-Null
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

Write-Output "Workbook update complete."
Write-Output "Workbook: $resolvedOutput"
if ($backupPath) {
  Write-Output "Backup: $backupPath"
}
Write-Output "Rows matched: $rowsMatched"
Write-Output "Rows updated: $rowsUpdated"
Write-Output "Rows skipped (no match): $rowsNoMatch"
Write-Output "Rows skipped (ambiguous): $rowsAmbiguous"
Write-Output "Cells updated: $cellsUpdated"
foreach ($header in ($touchedHeaders.Keys | Sort-Object)) {
  Write-Output ("  {0}: {1}" -f $header, $touchedHeaders[$header])
}
