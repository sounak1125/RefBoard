param(
  [Parameter(Mandatory = $true)][string]$DllPath,
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [string]$AppExePath = '',
  [string]$DefaultIconPath = ''
)

$ErrorActionPreference = 'Stop'
$HandlerGuid = '{B8E4F1A2-3C5D-4E6F-9A0B-1C2D3E4F5A6B}'
$ThumbShellGuid = '{E357FCCD-A995-4576-B01F-234630154E96}'
$ProgId = 'RefBoard.refboard'
$ManagedProgId = 'RefBoard.RefBoardThumbnailHandler'
$ManagedClass = 'RefBoard.RefBoardThumbnailHandler'
$ManagedCategoryGuid = '{62C8FE65-4EBB-45E7-B440-6E39B2CDBF29}'
$ClassesRoot = 'Registry::HKEY_CURRENT_USER\Software\Classes'

function Set-DefaultValue([string]$Path, [string]$Value) {
  New-Item -Path $Path -Force | Out-Null
  Set-ItemProperty -Path $Path -Name '(default)' -Value $Value
}

function ThumbnailAssociationRoots {
  @(
    "$ClassesRoot\$ProgId",
    "$ClassesRoot\.refboard",
    "$ClassesRoot\SystemFileAssociations\.refboard"
  )
}

function Refresh-Explorer {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RefBoardShellNotify {
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
"@
  [RefBoardShellNotify]::SHChangeNotify(0x08000000, 0x00001000, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}

if ($Action -eq 'uninstall') {
  Remove-Item -Path "$ClassesRoot\CLSID\$HandlerGuid" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path "$ClassesRoot\$ManagedProgId" -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($root in (ThumbnailAssociationRoots)) {
    Remove-Item -Path "$root\shellex\$ThumbShellGuid" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path "$root\shellex" -Name $ThumbShellGuid -Force -ErrorAction SilentlyContinue
  }
  Refresh-Explorer
  Write-Host 'Unregistered RefBoard thumbnail handler (current user)'
  exit 0
}

if ($AppExePath -and ([IO.Path]::GetFileName($AppExePath) -ieq 'electron.exe')) {
  Write-Host 'Skipped RefBoard shell registration from the Electron development runtime'
  exit 0
}

if (-not (Test-Path -LiteralPath $DllPath)) {
  Write-Error "DLL not found: $DllPath"
}

$dllPathResolved = (Resolve-Path -LiteralPath $DllPath).Path
$dllDir = Split-Path -Parent $dllPathResolved
$sharpDll = Join-Path $dllDir 'SharpShell.dll'
if (-not (Test-Path -LiteralPath $sharpDll)) {
  Write-Error 'SharpShell.dll must sit beside RefBoardThumbnailHandler.dll'
}

$assemblyName = [Reflection.AssemblyName]::GetAssemblyName($dllPathResolved)
$assemblyFullName = $assemblyName.FullName
$assemblyVersion = $assemblyName.Version.ToString()
$runtimeVersion = 'v4.0.30319'
$codeBase = ([Uri]$dllPathResolved).AbsoluteUri
$clsidKey = "$ClassesRoot\CLSID\$HandlerGuid"
$inprocKey = "$clsidKey\InprocServer32"
$versionKey = "$inprocKey\$assemblyVersion"

Set-DefaultValue "$ClassesRoot\$ManagedProgId" $ManagedProgId
Set-DefaultValue "$ClassesRoot\$ManagedProgId\CLSID" $HandlerGuid
Set-DefaultValue $clsidKey $ManagedClass
Set-DefaultValue $inprocKey 'mscoree.dll'
Set-ItemProperty -Path $inprocKey -Name 'ThreadingModel' -Value 'Both'
Set-ItemProperty -Path $inprocKey -Name 'Class' -Value $ManagedClass
Set-ItemProperty -Path $inprocKey -Name 'Assembly' -Value $assemblyFullName
Set-ItemProperty -Path $inprocKey -Name 'RuntimeVersion' -Value $runtimeVersion
Set-ItemProperty -Path $inprocKey -Name 'CodeBase' -Value $codeBase
New-Item -Path $versionKey -Force | Out-Null
Set-ItemProperty -Path $versionKey -Name 'Class' -Value $ManagedClass
Set-ItemProperty -Path $versionKey -Name 'Assembly' -Value $assemblyFullName
Set-ItemProperty -Path $versionKey -Name 'RuntimeVersion' -Value $runtimeVersion
Set-ItemProperty -Path $versionKey -Name 'CodeBase' -Value $codeBase
Set-DefaultValue "$clsidKey\ProgId" $ManagedProgId
New-Item -Path "$clsidKey\Implemented Categories\$ManagedCategoryGuid" -Force | Out-Null

Set-DefaultValue "$ClassesRoot\$ProgId" 'RefBoard moodboard'
Set-DefaultValue "$ClassesRoot\.refboard" $ProgId
foreach ($root in (ThumbnailAssociationRoots)) {
  New-Item -Path "$root\shellex" -Force | Out-Null
  Remove-ItemProperty -Path "$root\shellex" -Name $ThumbShellGuid -Force -ErrorAction SilentlyContinue
  Set-DefaultValue "$root\shellex\$ThumbShellGuid" $HandlerGuid
}

if ($DefaultIconPath -and (Test-Path -LiteralPath $DefaultIconPath)) {
  $iconResolved = (Resolve-Path -LiteralPath $DefaultIconPath).Path
  New-Item -Path "$ClassesRoot\$ProgId\DefaultIcon" -Force | Out-Null
  Set-ItemProperty -Path "$ClassesRoot\$ProgId\DefaultIcon" -Name '(default)' -Value "$iconResolved,0"
}

if ($AppExePath -and (Test-Path -LiteralPath $AppExePath)) {
  $exeResolved = (Resolve-Path -LiteralPath $AppExePath).Path
  New-Item -Path "$ClassesRoot\$ProgId\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path "$ClassesRoot\$ProgId\shell\open\command" -Name '(default)' -Value "`"$exeResolved`" `"%1`""
}

Refresh-Explorer
Write-Host 'Registered RefBoard thumbnail handler for current user'
