param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$DistDir = "dist"
)

if (-not $env:GH_TOKEN) {
  Write-Error 'Set GH_TOKEN to a GitHub personal access token with repo scope.'
  exit 1
}

$latestSrc = Join-Path $DistDir 'latest-1.0.0.yml'
if (-not (Test-Path $latestSrc)) { $latestSrc = Join-Path $DistDir 'latest.yml' }

$files = @(
  @{ Path = $latestSrc; Name = 'latest.yml' },
  @{ Path = Join-Path $DistDir 'RefBoard-Setup-1.0.0.exe.blockmap'; Name = 'RefBoard-Setup-1.0.0.exe.blockmap' }
)

foreach ($f in $files) {
  if (-not (Test-Path $f.Path)) {
    Write-Error "Missing file: $($f.Path)"
    exit 1
  }
  gh release upload $Tag "$($f.Path)#$($f.Name)" --clobber --repo sounak1125/RefBoard
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "Uploaded $($f.Name) to $Tag"
}
