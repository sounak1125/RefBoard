param(
  [string]$DistDir = 'dist-release',
  [string]$Tag = '',
  [string]$Repo = 'sounak1125/RefBoard',
  [switch]$Draft,
  [switch]$Publish,
  [switch]$DryRun
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

function ConvertTo-ReleaseNoteText {
  param([object]$Value)
  if ($null -eq $Value) { return '' }
  return (([string]$Value).Trim() -replace '\r?\n', ' ').Replace([string][char]0x2014, '-')
}

function New-StructuredReleaseNotes {
  param(
    [object]$Entry,
    [string]$Version
  )

  $headline = ConvertTo-ReleaseNoteText $Entry.headline
  $summary = ConvertTo-ReleaseNoteText $Entry.summary
  if (-not $headline) { $headline = "What is new in $Version" }
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("# $headline")
  if ($summary) {
    $lines.Add('')
    $lines.Add($summary)
  }

  $sectionTitles = [ordered]@{
    new = 'New'
    improved = 'Improved'
    fixed = 'Fixed'
  }
  foreach ($sectionName in $sectionTitles.Keys) {
    $items = @($Entry.sections.$sectionName)
    if ($items.Count -eq 0) { continue }
    $lines.Add('')
    $lines.Add("## $($sectionTitles[$sectionName])")
    $lines.Add('')
    foreach ($item in $items) {
      if ($item -is [string]) {
        $lines.Add("- $(ConvertTo-ReleaseNoteText $item)")
        continue
      }
      $title = ConvertTo-ReleaseNoteText $item.title
      $description = ConvertTo-ReleaseNoteText $item.description
      if ($title -and $description) { $lines.Add("- **$title** - $description") }
      elseif ($title) { $lines.Add("- **$title**") }
      elseif ($description) { $lines.Add("- $description") }
    }
  }
  return $lines -join [Environment]::NewLine
}

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$changelog = Get-Content changelog.json -Raw | ConvertFrom-Json
$entry = $changelog.$version
if ($null -eq $entry) {
  Write-Error "No changelog.json entry for $version"
  exit 1
}
$notesText = New-StructuredReleaseNotes -Entry $entry -Version $version
if ($DryRun) {
  Write-Output $notesText
  return
}

Require-GhAuth

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

$notesFile = Join-Path $env:TEMP "refboard-release-$version.md"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($notesFile, $notesText, $utf8NoBom)

$releaseExists = $false
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
gh release view $Tag --repo $Repo 2>&1 | Out-Null
$probeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($probeExit -eq 0) { $releaseExists = $true }

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
