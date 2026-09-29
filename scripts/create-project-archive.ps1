param(
  [string]$Version,
  [string]$DestinationRoot = "../../work"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Metadata = Get-Content -LiteralPath (Join-Path $ProjectRoot "release.json") -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$Metadata.releaseVersion }

& node (Join-Path $PSScriptRoot "verify-package.mjs")
if ($LASTEXITCODE -ne 0) { throw "存档前校验失败" }

$DestinationBase = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $DestinationRoot))
$Destination = Join-Path $DestinationBase "ogf-huayu-map-$Version-full"
$ProjectPath = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$DestinationPath = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar)

if ($DestinationPath.StartsWith("$ProjectPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
  throw "完整存档目录不能位于项目目录内部：$DestinationPath"
}
if (Test-Path -LiteralPath $DestinationPath) {
  throw "完整存档已存在，不会覆盖：$DestinationPath"
}

New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
$ExcludedNames = @(".git", ".wrangler", "node_modules", "data-freshness-report.json")
Get-ChildItem -LiteralPath $ProjectRoot -Force |
  Where-Object { $_.Name -notin $ExcludedNames -and $_.Name -notlike ".env*" -and $_.Name -notlike "*.log" } |
  Copy-Item -Destination $DestinationPath -Recurse

$ManifestPath = Join-Path $DestinationPath "SHA256.txt"
$ManifestLines = Get-ChildItem -LiteralPath $DestinationPath -File -Recurse |
  Where-Object { $_.FullName -ne $ManifestPath } |
  Sort-Object FullName |
  ForEach-Object {
    $RelativePath = $_.FullName.Substring($DestinationPath.Length + 1).Replace("\", "/")
    $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$Hash  $RelativePath"
  }
$ManifestLines | Set-Content -LiteralPath $ManifestPath -Encoding utf8

[pscustomobject]@{
  Version = $Version
  Archive = $DestinationPath
  Files = $ManifestLines.Count
  ManifestSha256 = (Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash
} | Format-List
