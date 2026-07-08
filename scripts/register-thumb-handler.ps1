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
$ClassesRoot = 'Registry::HKEY_CURRENT_USER\Software\Classes'

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
  Remove-ItemProperty -Path "$ClassesRoot\$ProgId\shellex" -Name $ThumbShellGuid -Force -ErrorAction SilentlyContinue
  Refresh-Explorer
  Write-Host 'Unregistered RefBoard thumbnail handler (current user)'
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

New-Item -Path "$ClassesRoot\CLSID\$HandlerGuid" -Force | Out-Null
New-Item -Path "$ClassesRoot\CLSID\$HandlerGuid\InprocServer32" -Force | Out-Null
Set-ItemProperty -Path "$ClassesRoot\CLSID\$HandlerGuid" -Name '(default)' -Value 'RefBoard Thumbnail Handler'
Set-ItemProperty -Path "$ClassesRoot\CLSID\$HandlerGuid\InprocServer32" -Name '(default)' -Value $dllPathResolved
Set-ItemProperty -Path "$ClassesRoot\CLSID\$HandlerGuid\InprocServer32" -Name 'ThreadingModel' -Value 'Apartment'
Set-ItemProperty -Path "$ClassesRoot\CLSID\$HandlerGuid\InprocServer32" -Name 'Class' -Value 'RefBoard Thumbnail Handler'

New-Item -Path "$ClassesRoot\$ProgId" -Force | Out-Null
Set-ItemProperty -Path "$ClassesRoot\$ProgId" -Name '(default)' -Value 'RefBoard moodboard'
New-Item -Path "$ClassesRoot\$ProgId\shellex" -Force | Out-Null
Set-ItemProperty -Path "$ClassesRoot\$ProgId\shellex" -Name $ThumbShellGuid -Value $HandlerGuid
New-Item -Path "$ClassesRoot\.refboard" -Force | Out-Null
Set-ItemProperty -Path "$ClassesRoot\.refboard" -Name '(default)' -Value $ProgId

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
