param(
  [string]$Tag,
  [string]$DistDir = "dist",
  [string]$Repo = "sounak1125/RefBoard",
  [switch]$ReplaceAssets
)

$ErrorActionPreference = 'Stop'
$token = $env:GH_TOKEN
if (-not $token) { $token = $env:GITHUB_TOKEN }
if (-not $token) {
  try { $token = (gh auth token 2>$null).Trim() } catch {}
}
if (-not $token) {
  Write-Error 'Set GH_TOKEN, or run: gh auth login'
  exit 1
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Tag) { $Tag = "v$version" }

$setup = Join-Path $DistDir "RefBoard-Setup-$version.exe"
$blockmap = Join-Path $DistDir "RefBoard-Setup-$version.exe.blockmap"
$latest = Join-Path $DistDir 'latest.yml'

foreach ($path in @($setup, $blockmap, $latest)) {
  if (-not (Test-Path $path)) {
    Write-Error "Missing build artifact: $path (run npm run dist first)"
    exit 1
  }
}

$wantNames = @('latest.yml', (Split-Path $blockmap -Leaf), (Split-Path $setup -Leaf))

gh release view $Tag --repo $Repo 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Error "Release $Tag not found on GitHub. Run npm run release:ship first."
  exit 1
}

if ($ReplaceAssets) {
  $assetNames = gh release view $Tag --repo $Repo --json assets -q '.assets[].name'
  foreach ($name in $assetNames) {
    if ($wantNames -contains $name) { continue }
    Write-Host "Deleting stray asset: $name"
    gh release delete-asset $Tag $name --repo $Repo --yes 2>$null | Out-Null
  }
}

Write-Host "Uploading $($wantNames -join ', ')..."
gh release upload $Tag $latest $blockmap $setup --repo $Repo --clobber
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$assetNames = gh release view $Tag --repo $Repo --json assets -q '.assets[].name'
Write-Host "Release $Tag assets:"
foreach ($name in $assetNames) { Write-Host " - $name" }
