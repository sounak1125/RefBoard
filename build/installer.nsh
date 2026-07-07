!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to RefBoard"
  !define MUI_WELCOMEPAGE_TEXT "A fast, clean moodboard and reference app.$\r$\n$\r$\nPaste, arrange and export reference images in their original quality - your images never leave your PC.$\r$\n$\r$\nMade by Sounak$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "RefBoard is ready"
  !define MUI_FINISHPAGE_TEXT "Thank you for installing RefBoard.$\r$\n$\r$\nMade by Sounak - enjoy, and share it with your friends!"
  !insertmacro MUI_PAGE_FINISH
!macroend
