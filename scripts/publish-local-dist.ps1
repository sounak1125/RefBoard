param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$DistDir = "dist"
)

if (-not $env:GH_TOKEN) {
  Write-Error 'Set GH_TOKEN to a GitHub personal access token with repo scope.'
  exit 1
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$setup = Join-Path $DistDir "RefBoard-Setup-$version.exe"
$blockmap = Join-Path $DistDir "RefBoard-Setup-$version.exe.blockmap"
$latest = Join-Path $DistDir 'latest.yml'

foreach ($path in @($setup, $blockmap, $latest)) {
  if (-not (Test-Path $path)) {
    Write-Error "Missing build artifact: $path (run npm run dist first)"
    exit 1
  }
}

gh release view $Tag 2>$null
if ($LASTEXITCODE -ne 0) {
  gh release create $Tag --title "RefBoard $Tag" --generate-notes --repo sounak1125/RefBoard
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

gh release upload $Tag $latest $blockmap $setup --clobber --repo sounak1125/RefBoard
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Published $Tag to GitHub Releases:"
gh release view $Tag --json assets --jq '.assets[].name' --repo sounak1125/RefBoard
