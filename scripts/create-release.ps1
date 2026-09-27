param(
  [string]$Version,
  [string]$DestinationRoot = "releases"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Metadata = Get-Content -LiteralPath (Join-Path $ProjectRoot "release.json") -Raw | ConvertFrom-Json
if (-not $Version) { $Version = [string]$Metadata.releaseVersion }

& node (Join-Path $PSScriptRoot "verify-package.mjs")
if ($LASTEXITCODE -ne 0) { throw "发布前校验失败" }

$DestinationBase = Join-Path $ProjectRoot $DestinationRoot
$Destination = Join-Path $DestinationBase $Version
if (Test-Path -LiteralPath $Destination) { throw "发布存档已存在，不会覆盖：$Destination" }

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "site") -Force | Copy-Item -Destination $Destination -Recurse
Copy-Item -LiteralPath (Join-Path $ProjectRoot "release/SHA256.txt") -Destination (Join-Path $Destination "SHA256.txt")

[pscustomobject]@{
  Version = $Version
  Archive = $Destination
  ProductionFiles = (Get-ChildItem -LiteralPath $Destination -File -Recurse | Where-Object Name -ne "SHA256.txt").Count
} | Format-List

