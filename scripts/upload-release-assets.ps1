param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$DistDir = "dist",
  [string]$Repo = "sounak1125/RefBoard"
)

if (-not $env:GH_TOKEN) {
  Write-Error 'Set GH_TOKEN to a GitHub personal access token with repo scope.'
  exit 1
}

$latestSrc = Join-Path $DistDir 'latest-1.0.0.yml'
if (-not (Test-Path $latestSrc)) {
  $exe = Join-Path $DistDir 'RefBoard-Setup-1.0.0.exe'
  if (-not (Test-Path $exe)) {
    Write-Error "Missing $exe — build v1.0.0 installer or run: npm run gen:latest-yml -- dist/RefBoard-Setup-1.0.0.exe"
    exit 1
  }
  node scripts/gen-latest-yml.js $exe | Out-Null
}

$headers = @{
  Authorization = "Bearer $env:GH_TOKEN"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers

function Upload-ReleaseAsset {
  param([int]$ReleaseId, [string]$FilePath, [string]$AssetName)
  $uploadHeaders = @{
    Authorization = "Bearer $env:GH_TOKEN"
    Accept = 'application/vnd.github+json'
    'Content-Type' = 'application/octet-stream'
  }
  $uri = "https://uploads.github.com/repos/$Repo/releases/$ReleaseId/assets?name=$AssetName"
  Invoke-RestMethod -Method Post -Uri $uri -Headers $uploadHeaders -InFile $FilePath | Out-Null
  Write-Host "Uploaded $AssetName"
}

$blockmap = Join-Path $DistDir 'RefBoard-Setup-1.0.0.exe.blockmap'
if (-not (Test-Path $blockmap)) {
  Write-Error "Missing $blockmap"
  exit 1
}

Upload-ReleaseAsset -ReleaseId $release.id -FilePath $latestSrc -AssetName 'latest.yml'
Upload-ReleaseAsset -ReleaseId $release.id -FilePath $blockmap -AssetName 'RefBoard-Setup-1.0.0.exe.blockmap'
