param(
  [string]$Root = (Get-Location).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Web.Extensions
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = [int]::MaxValue

$jsonFiles = @(
  'products.json',
  'products-baseball.json',
  'products-basketball.json',
  'products-football.json',
  'products-comics.json',
  'products-collectibles.json',
  'products-sports.json',
  'products-featured.json'
)

$bundleMap = [ordered]@{
  'products.json' = 'products-data-full.js'
  'products-baseball.json' = 'products-data-baseball.js'
  'products-basketball.json' = 'products-data-basketball.js'
  'products-football.json' = 'products-data-football.js'
  'products-comics.json' = 'products-data-comics.js'
  'products-collectibles.json' = 'products-data-collectibles.js'
  'products-sports.json' = 'products-data-sports.js'
  'products-featured.json' = 'products-data-featured.js'
}

function Read-JsonFile {
  param([string]$Path)

  $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
  return $serializer.DeserializeObject($text)
}

function Write-JsonFile {
  param(
    [string]$Path,
    $Data
  )

  $json = $serializer.Serialize($Data)
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-RelativeAssetPath {
  param([System.IO.FileInfo]$File)

  return $File.FullName.Substring($Root.Length + 1).Replace('\', '/')
}

function Decode-AssetReference {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path)) {
    return ''
  }

  $parts = $Path.Replace('\', '/') -split '/'
  if ($parts.Length -le 1) {
    return $Path.Replace('\', '/')
  }

  $decoded = New-Object System.Collections.ArrayList
  [void]$decoded.Add($parts[0])
  foreach ($segment in $parts[1..($parts.Length - 1)]) {
    try {
      [void]$decoded.Add([System.Uri]::UnescapeDataString($segment))
    } catch {
      [void]$decoded.Add($segment)
    }
  }

  return (($decoded.ToArray()) -join '/').TrimEnd('/')
}

function Get-OptionalValue {
  param(
    $Object,
    [string]$Key
  )

  if ($null -eq $Object) {
    return $null
  }

  if ($Object -is [System.Collections.IDictionary]) {
    $containsKeyMethod = $Object.PSObject.Methods['ContainsKey']
    if ($null -ne $containsKeyMethod) {
      if ($Object.ContainsKey($Key)) {
        return $Object[$Key]
      }
      return $null
    }

    $containsMethod = $Object.PSObject.Methods['Contains']
    if ($null -ne $containsMethod -and $Object.Contains($Key)) {
      return $Object[$Key]
    }
  }

  return $null
}

function Get-StringArray {
  param($Value)

  if ($null -eq $Value) {
    return @()
  }

  if ($Value -is [string]) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
      return @()
    }
    return @([string]$Value)
  }

  if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [System.Collections.IDictionary])) {
    return @($Value | Where-Object { $_ -is [string] -and -not [string]::IsNullOrWhiteSpace($_) })
  }

  return @()
}

function Get-ItemFolders {
  param($Item)

  $folders = New-Object System.Collections.ArrayList
  $metadata = Get-OptionalValue $Item 'metadata'
  $sources = @(
    (Get-OptionalValue $Item 'localAssetFolder'),
    (Get-OptionalValue $Item 'localAssetFoldersInGallery'),
    (Get-OptionalValue $metadata 'localAssetFolder'),
    (Get-OptionalValue $metadata 'localAssetFoldersInGallery')
  )

  foreach ($source in $sources) {
    foreach ($folder in (Get-StringArray $source)) {
      $decoded = Decode-AssetReference $folder
      if ([string]::IsNullOrWhiteSpace($decoded)) {
        continue
      }
      if ($decoded -notlike 'assets/*') {
        $decoded = "assets/$decoded"
      }
      if (-not $folders.Contains($decoded)) {
        [void]$folders.Add($decoded)
      }
    }
  }

  return @($folders.ToArray())
}

function Get-RemotePhotoUrls {
  param($Item)

  $urls = New-Object System.Collections.ArrayList
  $metadata = Get-OptionalValue $Item 'metadata'
  $sources = @(
    (Get-OptionalValue $Item 'itemPhotoUrls'),
    (Get-OptionalValue $Item 'htmlImageUrls'),
    (Get-OptionalValue $metadata 'itemPhotoUrls'),
    (Get-OptionalValue $metadata 'htmlImageUrls')
  )

  foreach ($source in $sources) {
    foreach ($url in (Get-StringArray $source)) {
      if (-not $urls.Contains($url)) {
        [void]$urls.Add($url)
      }
    }
  }

  return @($urls.ToArray())
}

function Get-PrimaryBucket {
  param([string]$Path)

  $parts = $Path -split '/'
  if ($parts.Length -ge 3) {
    return ($parts[0..2] -join '/')
  }
  return $Path
}

function Score-Candidate {
  param(
    [string]$Reference,
    [string]$Candidate,
    $Item,
    [string[]]$Folders
  )

  $score = 0
  $referenceDir = (Split-Path $Reference).ToLowerInvariant()
  $candidateDir = (Split-Path $Candidate).ToLowerInvariant()
  $referenceExt = [System.IO.Path]::GetExtension($Reference).ToLowerInvariant()
  $candidateExt = [System.IO.Path]::GetExtension($Candidate).ToLowerInvariant()

  if ($referenceExt -eq $candidateExt) {
    $score += 30
  }

  if ((Get-PrimaryBucket $Reference).ToLowerInvariant() -eq (Get-PrimaryBucket $Candidate).ToLowerInvariant()) {
    $score += 120
  }

  foreach ($folder in $Folders) {
    if ($Candidate.ToLowerInvariant().StartsWith($folder.ToLowerInvariant())) {
      $score += 220
    }
  }

  $referenceTokens = $referenceDir -split '/'
  $candidateTokens = $candidateDir -split '/'
  $sharedTokens = @($referenceTokens | Where-Object { $candidateTokens -contains $_ }).Count
  $score += ($sharedTokens * 10)

  if ($Reference.ToLowerInvariant().Contains('placeholder-') -and $Candidate -match '^assets/placeholder-') {
    $score += 500
  }

  $category = Get-OptionalValue $Item 'category'
  if ($category -and $Candidate.ToLowerInvariant().Contains($category.ToString().ToLowerInvariant())) {
    $score += 20
  }

  $playerAthlete = Get-OptionalValue $Item 'playerAthlete'
  if ($playerAthlete) {
    $playerTokens = $playerAthlete.ToString().ToLowerInvariant() -split '\s+'
    foreach ($token in $playerTokens) {
      if ($token.Length -ge 3 -and $Candidate.ToLowerInvariant().Contains($token)) {
        $score += 4
      }
    }
  }

  return $score
}

function Select-BestCandidate {
  param(
    [string[]]$Candidates,
    [string]$Reference,
    $Item,
    [string[]]$Folders
  )

  $bestCandidate = ''
  $bestScore = [int]::MinValue

  foreach ($candidate in $Candidates) {
    $score = Score-Candidate -Reference $Reference -Candidate $candidate -Item $Item -Folders $Folders
    if ($score -gt $bestScore) {
      $bestScore = $score
      $bestCandidate = $candidate
    }
  }

  return $bestCandidate
}

function Add-AssetToIndexes {
  param(
    [string]$RelativePath,
    [hashtable]$StemDirMap,
    [hashtable]$StemMap
  )

  $script:ExactMap[$RelativePath] = $RelativePath

  $dirKey = (Split-Path $RelativePath).ToLowerInvariant() + '|' + [System.IO.Path]::GetFileNameWithoutExtension($RelativePath).ToLowerInvariant()
  if (-not $StemDirMap.ContainsKey($dirKey)) {
    $StemDirMap[$dirKey] = New-Object System.Collections.ArrayList
  }
  if (-not $StemDirMap[$dirKey].Contains($RelativePath)) {
    [void]$StemDirMap[$dirKey].Add($RelativePath)
  }

  $stemKey = [System.IO.Path]::GetFileNameWithoutExtension($RelativePath).ToLowerInvariant()
  if (-not $StemMap.ContainsKey($stemKey)) {
    $StemMap[$stemKey] = New-Object System.Collections.ArrayList
  }
  if (-not $StemMap[$stemKey].Contains($RelativePath)) {
    [void]$StemMap[$stemKey].Add($RelativePath)
  }
}

function Resolve-ImagePath {
  param(
    [string]$Reference,
    $Item,
    [hashtable]$StemDirMap,
    [hashtable]$StemMap
  )

  $decoded = Decode-AssetReference $Reference
  if ([string]::IsNullOrWhiteSpace($decoded)) {
    return ''
  }

  if ($script:ExactMap.ContainsKey($decoded)) {
    return $script:ExactMap[$decoded]
  }

  $referenceDir = (Split-Path $decoded).ToLowerInvariant()
  $referenceStem = [System.IO.Path]::GetFileNameWithoutExtension($decoded).ToLowerInvariant()
  $sameDirKey = "$referenceDir|$referenceStem"
  if ($StemDirMap.ContainsKey($sameDirKey)) {
    $candidates = @($StemDirMap[$sameDirKey].ToArray())
    if ($candidates.Count -eq 1) {
      return $candidates[0]
    }
    $folders = Get-ItemFolders $Item
    return Select-BestCandidate -Candidates $candidates -Reference $decoded -Item $Item -Folders $folders
  }

  if ($StemMap.ContainsKey($referenceStem)) {
    $candidates = @($StemMap[$referenceStem].ToArray())
    if ($candidates.Count -eq 1) {
      return $candidates[0]
    }
    $folders = Get-ItemFolders $Item
    return Select-BestCandidate -Candidates $candidates -Reference $decoded -Item $Item -Folders $folders
  }

  return ''
}

function Ensure-DownloadedAsset {
  param(
    [string]$RelativePath,
    [string]$RemoteUrl
  )

  if ([string]::IsNullOrWhiteSpace($RelativePath) -or [string]::IsNullOrWhiteSpace($RemoteUrl)) {
    return $false
  }

  $absolutePath = Join-Path $Root $RelativePath.Replace('/', '\')
  $directory = Split-Path $absolutePath -Parent
  if (-not (Test-Path $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  if (-not (Test-Path $absolutePath)) {
    Invoke-WebRequest -Uri $RemoteUrl -OutFile $absolutePath | Out-Null
  }

  return (Test-Path $absolutePath)
}

$script:ExactMap = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
$stemDirMap = @{}
$stemMap = @{}

$assetFiles = Get-ChildItem (Join-Path $Root 'assets') -Recurse -File
foreach ($assetFile in $assetFiles) {
  Add-AssetToIndexes -RelativePath (Get-RelativeAssetPath $assetFile) -StemDirMap $stemDirMap -StemMap $stemMap
}

$totals = [ordered]@{
  MainUpdated = 0
  GalleryUpdated = 0
  Downloads = 0
  UnresolvedMain = 0
  UnresolvedGallery = 0
}

foreach ($jsonFile in $jsonFiles) {
  $path = Join-Path $Root $jsonFile
  $items = @(Read-JsonFile $path)
  $updatedItems = New-Object System.Collections.ArrayList

  foreach ($item in $items) {
    $originalImage = [string](Get-OptionalValue $item 'image')
    $resolvedImage = Resolve-ImagePath -Reference $originalImage -Item $item -StemDirMap $stemDirMap -StemMap $stemMap
    $decodedOriginalImage = Decode-AssetReference $originalImage

    if ([string]::IsNullOrWhiteSpace($resolvedImage)) {
      $remoteUrls = @(Get-RemotePhotoUrls $item)
      if ($decodedOriginalImage -like 'assets/*' -and $remoteUrls.Count -gt 0) {
        if (Ensure-DownloadedAsset -RelativePath $decodedOriginalImage -RemoteUrl $remoteUrls[0]) {
          Add-AssetToIndexes -RelativePath $decodedOriginalImage -StemDirMap $stemDirMap -StemMap $stemMap
          $resolvedImage = $decodedOriginalImage
          $totals.Downloads++
        }
      }
    }

    if ([string]::IsNullOrWhiteSpace($resolvedImage)) {
      $resolvedImage = $decodedOriginalImage
      $totals.UnresolvedMain++
    } elseif ($resolvedImage -ne $decodedOriginalImage) {
      $totals.MainUpdated++
    }

    $item['image'] = $resolvedImage

    $galleryRefs = @(Get-StringArray (Get-OptionalValue $item 'imageGallery'))
    $remoteUrls = @(Get-RemotePhotoUrls $item)
    $updatedGallery = New-Object System.Collections.ArrayList

    for ($index = 0; $index -lt $galleryRefs.Count; $index++) {
      $galleryRef = [string]$galleryRefs[$index]
      $decodedGalleryRef = Decode-AssetReference $galleryRef
      $resolvedGalleryRef = Resolve-ImagePath -Reference $galleryRef -Item $item -StemDirMap $stemDirMap -StemMap $stemMap

      if ([string]::IsNullOrWhiteSpace($resolvedGalleryRef)) {
        if ($decodedGalleryRef -like 'assets/*' -and $index -lt $remoteUrls.Count) {
          if (Ensure-DownloadedAsset -RelativePath $decodedGalleryRef -RemoteUrl $remoteUrls[$index]) {
            Add-AssetToIndexes -RelativePath $decodedGalleryRef -StemDirMap $stemDirMap -StemMap $stemMap
            $resolvedGalleryRef = $decodedGalleryRef
            $totals.Downloads++
          }
        }
      }

      if ([string]::IsNullOrWhiteSpace($resolvedGalleryRef)) {
        $resolvedGalleryRef = $decodedGalleryRef
        $totals.UnresolvedGallery++
      } elseif ($resolvedGalleryRef -ne $decodedGalleryRef) {
        $totals.GalleryUpdated++
      }

      if (-not [string]::IsNullOrWhiteSpace($resolvedGalleryRef) -and -not $updatedGallery.Contains($resolvedGalleryRef)) {
        [void]$updatedGallery.Add($resolvedGalleryRef)
      }
    }

    $item['imageGallery'] = [object[]]$updatedGallery.ToArray()
    [void]$updatedItems.Add($item)
  }

  Write-JsonFile -Path $path -Data ([object[]]$updatedItems.ToArray())
}

foreach ($entry in $bundleMap.GetEnumerator()) {
  $sourcePath = Join-Path $Root $entry.Key
  $targetPath = Join-Path $Root $entry.Value
  $json = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
  $content = 'window.DJ_PRELOADED_SOURCE = "' + $entry.Key + '";' + "`r`n" +
    'window.DJ_PRELOADED_PRODUCTS = ' + $json + ';' + "`r`n"
  [System.IO.File]::WriteAllText($targetPath, $content, [System.Text.UTF8Encoding]::new($false))
}

$totals.GetEnumerator() | ForEach-Object {
  '{0}: {1}' -f $_.Key, $_.Value
}
