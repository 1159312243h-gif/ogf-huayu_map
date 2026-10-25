param([Parameter(Mandatory=$true)][string]$ArchivePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$brandRoot = Split-Path $PSScriptRoot -Parent
$brandOutput = Join-Path $brandRoot 'site/brand-catalog.json'
$brandArchive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $ArchivePath).Path)
try {
  $brandFiles = @{}
  foreach ($brandFile in @('meta', 'brands', 'operators')) {
    $brandEntry = $brandArchive.GetEntry("ogf-brand-index/web/data/$brandFile.json")
    if (!$brandEntry -or $brandEntry.Length -gt 16MB) { throw "Missing or oversized brand data: $brandFile" }
    $brandReader = [IO.StreamReader]::new($brandEntry.Open())
    try { $brandFiles[$brandFile] = $brandReader.ReadToEnd() | ConvertFrom-Json }
    finally { $brandReader.Dispose() }
  }
  if ($brandFiles.brands.Count -ne $brandFiles.meta.stats.brands -or $brandFiles.operators.Count -ne $brandFiles.meta.stats.operators) { throw 'Catalog count mismatch' }
  $brandCatalog = [ordered]@{
    schema = 'huayu-brand-catalog-v1'
    generatedAt = $brandFiles.meta.generatedAt
    dbTimestamp = $brandFiles.meta.dbTimestamp
    source = $brandFiles.meta.source
    provenance = '用户提供的 ogf-sites.zip / ogf-brand-index；保留原始快照日期。'
    coverage = '原包品牌索引；运营者采用原包部分设施类型索引。计数为地图要素，非核实门店总量。名称、分店和城市为原包样本。'
    attribution = '© OpenGeofiction contributors · ODbL'
    brands = $brandFiles.brands
    operators = $brandFiles.operators
  }
  $brandTemporary = "$brandOutput.importing"
  [IO.File]::WriteAllText($brandTemporary, ($brandCatalog | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $brandTemporary -Destination $brandOutput -Force
  Write-Output "Imported $($brandFiles.brands.Count) brands and $($brandFiles.operators.Count) operators; source date $($brandFiles.meta.dbTimestamp)"
} finally { $brandArchive.Dispose() }
