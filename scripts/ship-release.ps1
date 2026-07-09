param(
  [string]$DistDir = 'dist-release',
  [string]$Tag = '',
  [string]$Repo = 'sounak1125/RefBoard',
  [switch]$Draft,
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'

function Require-GhAuth {
  gh auth status 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host 'GitHub is not logged in. Run this first:' -ForegroundColor Yellow
    Write-Host '  gh auth login' -ForegroundColor Cyan
    Write-Host ''
    Write-Host 'Choose: GitHub.com -> HTTPS -> Login with browser (or paste a token).'
    Write-Host 'Then re-run: npm run release:ship'
    exit 1
  }
}

Require-GhAuth

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Tag) { $Tag = "v$version" }

$setup = Join-Path $DistDir "RefBoard-Setup-$version.exe"
$blockmap = Join-Path $DistDir "RefBoard-Setup-$version.exe.blockmap"
$latest = Join-Path $DistDir 'latest.yml'
foreach ($path in @($setup, $blockmap, $latest)) {
  if (-not (Test-Path $path)) {
    Write-Error "Missing $path - run: npx electron-builder --win --config.directories.output=$DistDir"
    exit 1
  }
}

$changelog = Get-Content changelog.json -Raw | ConvertFrom-Json
$highlights = @($changelog.$version)
if (-not $highlights -or $highlights.Count -eq 0) {
  Write-Error "No changelog.json entry for $version"
  exit 1
}

$heading = "**What is new in $version**"
$notes = @($heading, '') + ($highlights | ForEach-Object { "- $_" })
$notesFile = Join-Path $env:TEMP "refboard-release-$version.md"
$notes -join [Environment]::NewLine | Out-File -FilePath $notesFile -Encoding utf8

$releaseExists = $false
gh release view $Tag --repo $Repo 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { $releaseExists = $true }

if (-not $releaseExists) {
  Write-Host "Creating release $Tag..."
  $ghCreateArgs = @('release', 'create', $Tag, '--repo', $Repo, '--title', "RefBoard $Tag", '--notes-file', $notesFile)
  if ($Draft -and -not $Publish) { $ghCreateArgs += '--draft' }
  & gh @ghCreateArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Host "Updating release $Tag..."
  $ghEditArgs = @('release', 'edit', $Tag, '--repo', $Repo, '--title', "RefBoard $Tag", '--notes-file', $notesFile)
  if ($Draft -and -not $Publish) { $ghEditArgs += '--draft' }
  elseif ($Publish) { $ghEditArgs += '--draft=false' }
  & gh @ghEditArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host 'Uploading auto-update assets (removes old files first)...'
& "$PSScriptRoot\publish-local-dist.ps1" -ReplaceAssets -DistDir $DistDir -Tag $Tag -Repo $Repo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$url = "https://github.com/$Repo/releases/tag/$Tag"
if ($Draft -and -not $Publish) {
  Write-Host ''
  Write-Host "Draft release is ready: $url" -ForegroundColor Green
  Write-Host 'Review on GitHub, then publish so auto-update works:'
  Write-Host "  gh release edit $Tag --draft=false" -ForegroundColor Cyan
  Write-Host 'Or click Publish release on the GitHub page.'
} else {
  Write-Host ''
  Write-Host "Release published: $url" -ForegroundColor Green
  Write-Host "Installed RefBoard 1.0.1 apps will pick this up on the next update check."
}
