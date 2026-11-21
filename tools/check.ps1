# 一键校验：JS 语法、manifest 可解析、版本号一致、图标齐全、HTML 引用完整
#
# 用法：pwsh tools/check.ps1
# 退出码：0 = 通过；1 = 有失败项（CI 依赖此退出码）

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$failures = 0
$checked = 0

function Fail([string]$msg) {
  $script:failures++
  Write-Host "  ✗ $msg" -ForegroundColor Red
}
function Ok([string]$msg) {
  Write-Host "  ✓ $msg" -ForegroundColor Green
}
function Section([string]$name) {
  Write-Host "`n[$name]" -ForegroundColor Cyan
}

Section '环境'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail '未找到 node，无法做语法检查（安装 Node 18+ 后重试）'
} else {
  Ok ("node " + (node -v))
}

Section 'manifest.json'
$manifestPath = Join-Path $root 'manifest.json'
try {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Ok ("清单可解析，版本 " + $manifest.version)
} catch {
  Fail "manifest.json 解析失败：$($_.Exception.Message)"
  exit 1
}

# 版本一致性：manifest.version 必须与 constants.js 的 APP.version 相同
$constPath = Join-Path $root 'src/shared/constants.js'
if (Test-Path -LiteralPath $constPath) {
  $constText = Get-Content -LiteralPath $constPath -Raw
  if ($constText -match "version:\s*'([^']+)'") {
    if ($Matches[1] -eq $manifest.version) { Ok "版本号一致：$($manifest.version)" }
    else { Fail "版本号不一致：manifest=$($manifest.version) constants=$($Matches[1])" }
  } else {
    Fail 'constants.js 中找不到 APP.version'
  }
} else {
  Fail '缺少 src/shared/constants.js'
}

Section '图标'
$iconPaths = @($manifest.icons.PSObject.Properties.Value)
foreach ($p in $iconPaths) {
  $full = Join-Path $root $p
  if (Test-Path -LiteralPath $full) { Ok "$p" } else { Fail "图标缺失：$p" }
}

Section '入口文件'
$entries = @($manifest.background.service_worker, $manifest.action.default_popup, $manifest.options_ui.page)
foreach ($p in $entries) {
  if ($p -and (Test-Path -LiteralPath (Join-Path $root $p))) { Ok $p } else { Fail "入口缺失：$p" }
}
foreach ($script in $manifest.content_scripts[0].js) {
  if (Test-Path -LiteralPath (Join-Path $root $script)) { Ok $script } else { Fail "内容脚本缺失：$script" }
}

Section 'JS 语法'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mvcheck-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$jsFiles = Get-ChildItem -Path (Join-Path $root 'src') -Recurse -Filter *.js -File
foreach ($file in $jsFiles) {
  $checked++
  $text = Get-Content -LiteralPath $file.FullName -Raw
  $isModule = ($text -match '(?m)^import\s') -or ($text -match '(?m)^export\s')
  if ($isModule) {
    $copy = Join-Path $tmp (($file.BaseName) + '-' + $checked + '.mjs')
    Set-Content -LiteralPath $copy -Value $text -NoNewline
    $output = & node --check $copy 2>&1
  } else {
    $output = & node --check $file.FullName 2>&1
  }
  if ($LASTEXITCODE -ne 0) {
    Fail ("语法错误：" + $file.FullName.Substring($root.Length + 1))
    Write-Host ($output -join "`n") -ForegroundColor DarkRed
  }
}
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "检查了 $checked 个 JS 文件"

Section 'HTML 本地资源引用'
$htmlFiles = Get-ChildItem -Path (Join-Path $root 'src') -Recurse -Filter *.html -File
$refPattern = '(?:src|href)="([^"#]+)"'
foreach ($html in $htmlFiles) {
  $content = Get-Content -LiteralPath $html.FullName -Raw
  $matches2 = [regex]::Matches($content, $refPattern)
  foreach ($m in $matches2) {
    $ref = $m.Groups[1].Value
    if ($ref -match '^(http|https|data:|mailto:|\/\/)') { continue }
    $target = Join-Path $html.DirectoryName $ref
    if (-not (Test-Path -LiteralPath $target)) {
      Fail ("$($html.Name) 引用了不存在的资源：" + $ref)
    }
  }
}
Ok "HTML 引用检查完成（$($htmlFiles.Count) 个文件）"

Section '结果'
if ($failures -eq 0) {
  Write-Host "全部通过（$checked 个 JS 文件）" -ForegroundColor Green
  exit 0
} else {
  Write-Host "共 $failures 项失败，请修复后重试" -ForegroundColor Red
  exit 1
}
