; Match the installer chrome and welcome/finish pages to RefBoard's icon palette.
!define MUI_BGCOLOR "131419"
!define MUI_TEXTCOLOR "E8EAF0"

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to RefBoard"
  !define MUI_WELCOMEPAGE_TEXT "A clean, minimal moodboard for artists and creators.$\r$\n$\r$\nPaste, arrange and export reference images in their original quality - everything stays on your PC, nothing is ever uploaded.$\r$\n$\r$\nMade by Sounak$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
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
