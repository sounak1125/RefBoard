param(
  [string]$Tag,
  [string]$DistDir = "dist",
  [string]$Repo = "sounak1125/RefBoard"
)

if (-not $env:GH_TOKEN) {
  Write-Error 'Set GH_TOKEN to a GitHub personal access token with repo scope.'
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

$headers = @{
  Authorization = "Bearer $env:GH_TOKEN"
  Accept = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -ErrorAction SilentlyContinue
if (-not $release) {
  $body = @{ tag_name = $Tag; name = "RefBoard $Tag"; generate_release_notes = $true } | ConvertTo-Json
  $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body $body -ContentType 'application/json'
}

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

Upload-ReleaseAsset -ReleaseId $release.id -FilePath $latest -AssetName 'latest.yml'
Upload-ReleaseAsset -ReleaseId $release.id -FilePath $blockmap -AssetName (Split-Path $blockmap -Leaf)
Upload-ReleaseAsset -ReleaseId $release.id -FilePath $setup -AssetName (Split-Path $setup -Leaf)

$assets = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers).assets.name
Write-Host "Release $Tag assets:"
$assets | ForEach-Object { Write-Host " - $_" }
