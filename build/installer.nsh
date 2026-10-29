; Match the installer chrome and welcome/finish pages to RefBoard's icon palette.
!define MUI_BGCOLOR "131419"
!define MUI_TEXTCOLOR "E8EAF0"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to RefBoard"
  !define MUI_WELCOMEPAGE_TEXT "A clean, minimal moodboard for artists and creators.$\r$\n$\r$\nPaste, arrange and export reference images in their original quality - everything stays on your PC, nothing is ever uploaded.$\r$\n$\r$\nMade by Sounak$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  ; A custom finish page replaces electron-builder's, and with it the "Run RefBoard"
  ; checkbox. The assisted installer ignores --force-run unless silent, so without
  ; this a "Restart to update" install closes RefBoard and never brings it back.
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_TITLE "RefBoard is ready"
  !define MUI_FINISHPAGE_TEXT "Thank you for installing RefBoard.$\r$\n$\r$\nPress Ctrl+V on the board to paste your first reference.$\r$\n$\r$\nMade by Sounak - enjoy, and share it with your friends!"
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInstall
  ; Per-user Explorer thumbnails for .refboard (moodboard preview + R badge)
  ExecWait '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\register-thumb-handler.ps1" -DllPath "$INSTDIR\resources\RefBoardThumbnailHandler.dll" -Action install -AppExePath "$INSTDIR\RefBoard.exe" -DefaultIconPath "$INSTDIR\resources\icon.ico"'
!macroend

!macro customUnInstall
  ExecWait '"powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\scripts\register-thumb-handler.ps1" -DllPath "$INSTDIR\resources\RefBoardThumbnailHandler.dll" -Action uninstall'
!macroend
