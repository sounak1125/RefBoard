param(
  [string]$Repo = 'sounak1125/RefBoard',
  [string[]]$RemoveTags = @('v1.0.2', 'v1.0.1')
)

$ErrorActionPreference = 'Stop'
$token = $env:GH_TOKEN
if (-not $token) { $token = $env:GITHUB_TOKEN }
if (-not $token) {
  Write-Error 'Set GH_TOKEN (GitHub PAT with repo scope) or run: gh auth login'
  exit 1
}

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
}

function Remove-ReleaseByTag([string]$ReleaseTag) {
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$ReleaseTag" -Headers $headers
    Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Repo/releases/$($rel.id)" -Headers $headers | Out-Null
    Write-Host "Deleted release $ReleaseTag"
  } catch {
    Write-Host "No release for $ReleaseTag"
  }
}

function Remove-RemoteTag([string]$Name) {
  try {
    Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Repo/git/refs/tags/$Name" -Headers $headers | Out-Null
    Write-Host "Deleted tag $Name"
  } catch {
    Write-Host "No tag $Name"
  }
}

foreach ($t in $RemoveTags) { Remove-ReleaseByTag $t }
foreach ($t in $RemoveTags) { Remove-RemoteTag $t }

Write-Host "Kept v1.0.0 release. Check: https://github.com/$Repo/releases/tag/v1.0.0"
