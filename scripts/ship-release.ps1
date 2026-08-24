param(
  [string]$DistDir = 'dist',
  [string]$Tag = '',
  [string]$Repo = 'sounak1125/RefBoard',
  [switch]$Draft,
  [switch]$Publish,
  [switch]$DryRun,
  [switch]$SkipPayloadCheck,
  [switch]$NoBootstrapperRebuild
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

function Find-BootstrapperDir {
  param([string]$DistDir, [string]$InstallerName)
  foreach ($dir in @((Join-Path $DistDir 'bootstrapper'), (Join-Path 'dist' 'bootstrapper'))) {
    if (Test-Path (Join-Path $dir $InstallerName)) { return $dir }
  }
  return $null
}

# The file whose hash represents what the installer actually wraps, or $null when
# that cannot be established. win-unpacked holds the copy the portable exe was
# built around, so it also catches a payload refreshed without a rebuild. The
# payload file is only evidence when the installer was built after it.
function Get-WrappedSetup {
  param([string]$InstallerDir, [string]$Installer, [string]$Payload)

  $embedded = Join-Path $InstallerDir (Join-Path 'win-unpacked' (Join-Path 'resources' 'RefBoard-Setup.exe'))
  if (Test-Path $embedded) { return $embedded }
  if (-not (Test-Path $Payload)) { return $null }
  if ((Get-Item -LiteralPath $Installer).LastWriteTimeUtc -lt (Get-Item -LiteralPath $Payload).LastWriteTimeUtc) { return $null }
  return $Payload
}

function Sync-BootstrapperPayload {
  param(
    [string]$SetupPath,
    [string]$DistDir,
    [string]$Version,
    [switch]$NoRebuild
  )

  $installerName = "RefBoard-Installer-$Version.exe"
  $installerDir = Find-BootstrapperDir -DistDir $DistDir -InstallerName $installerName
  if (-not $installerDir) {
    Write-Warning "No $installerName built - the bootstrapper will be skipped. Build it with: Push-Location bootstrapper; npm run dist; Pop-Location"
    return
  }

  $installer = Join-Path $installerDir $installerName
  $payload = Join-Path 'bootstrapper' (Join-Path 'payload' 'RefBoard-Setup.exe')
  $setupHash = (Get-FileHash -LiteralPath $SetupPath).Hash

  $wrapped = Get-WrappedSetup -InstallerDir $installerDir -Installer $installer -Payload $payload
  if ($wrapped -and (Get-FileHash -LiteralPath $wrapped).Hash -eq $setupHash) {
    Write-Host "Bootstrapper payload matches RefBoard-Setup-$Version.exe."
    return
  }

  if ($wrapped) {
    Write-Host ''
    Write-Host "  $SetupPath" -ForegroundColor Yellow
    Write-Host "    $setupHash"
    Write-Host "  $wrapped" -ForegroundColor Yellow
    Write-Host "    $((Get-FileHash -LiteralPath $wrapped).Hash)"
    Write-Host ''
  } else {
    Write-Host ''
    Write-Host "Cannot establish which setup $installerName wraps." -ForegroundColor Yellow
  }

  if ($NoRebuild) {
    Write-Host 'Refresh it with:'
    Write-Host "  Copy-Item $SetupPath bootstrapper\payload\RefBoard-Setup.exe -Force" -ForegroundColor Cyan
    Write-Host '  Push-Location bootstrapper; npm run dist; Pop-Location' -ForegroundColor Cyan
    Write-Error "$installerName does not wrap $SetupPath - it would install the wrong version. Drop -NoBootstrapperRebuild to have this script fix it."
    exit 1
  }

  Write-Host "Refreshing the bootstrapper payload from $SetupPath..."
  New-Item -ItemType Directory -Force (Split-Path $payload) | Out-Null
  Copy-Item -LiteralPath $SetupPath -Destination $payload -Force

  Write-Host 'Rebuilding the bootstrapper...'
  Push-Location 'bootstrapper'
  try { & npm run dist -- --publish never; $buildExit = $LASTEXITCODE } finally { Pop-Location }
  if ($buildExit -ne 0) {
    Write-Error "Bootstrapper build failed (exit $buildExit) - nothing was uploaded."
    exit 1
  }

  # A rebuild is not evidence. Re-resolve and re-hash, because the whole point
  # of this function is that the release must never carry an installer nobody
  # proved wraps this version.
  $installerDir = Find-BootstrapperDir -DistDir $DistDir -InstallerName $installerName
  if (-not $installerDir) {
    Write-Error "Bootstrapper build reported success but $installerName is not there."
    exit 1
  }
  $installer = Join-Path $installerDir $installerName
  $wrapped = Get-WrappedSetup -InstallerDir $installerDir -Installer $installer -Payload $payload
  if (-not $wrapped) {
    Write-Error "Rebuilt $installerName but nothing proves which setup it wraps."
    exit 1
  }
  if ((Get-FileHash -LiteralPath $wrapped).Hash -ne $setupHash) {
    Write-Error "Rebuilt $installerName still does not wrap $SetupPath."
    exit 1
  }

  Write-Host "Bootstrapper rebuilt around RefBoard-Setup-$Version.exe." -ForegroundColor Green
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

$version = (Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
$changelog = Get-Content changelog.json -Raw -Encoding UTF8 | ConvertFrom-Json
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

if (-not $SkipPayloadCheck) {
  Sync-BootstrapperPayload -SetupPath $setup -DistDir $DistDir -Version $version -NoRebuild:$NoBootstrapperRebuild
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
