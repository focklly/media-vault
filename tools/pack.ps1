# 打包扩展为可分发 zip（仅含 manifest.json + src/，不含文档与工具）
#
# 用法：pwsh tools/pack.ps1
# 产出：dist/media-vault-<version>.zip

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw '未找到 manifest.json' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version

$distDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$zipPath = Join-Path $distDir ("media-vault-$version.zip")
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("mvpack-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Copy-Item -LiteralPath $manifestPath -Destination $stage
Copy-Item -LiteralPath (Join-Path $root 'src') -Destination $stage -Recurse
foreach ($extra in @('LICENSE', 'README.md')) {
  $p = Join-Path $root $extra
  if (Test-Path -LiteralPath $p) { Copy-Item -LiteralPath $p -Destination $stage }
}

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stage -Recurse -Force

$size = (Get-Item -LiteralPath $zipPath).Length
Write-Host ("打包完成：$zipPath  ({0:N1} KB)" -f ($size / 1KB)) -ForegroundColor Green
Write-Host '提醒：上架前请再跑一次 tools/check.ps1，并确认版本号与 CHANGELOG 一致。'
