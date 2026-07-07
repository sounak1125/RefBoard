@echo off
setlocal
cd /d "%~dp0"

rem 1) Electron dev (npm start) — full app experience including custom cursor
if exist "node_modules\.bin\electron.cmd" (
  call npm start
  exit /b %ERRORLEVEL%
)

rem 2) Packaged Electron build
if exist "dist\win-unpacked\RefBoard.exe" (
  start "" "dist\win-unpacked\RefBoard.exe"
  exit /b 0
)

rem 3) Browser fallback via localhost (file:// blocks custom CSS cursors)
set "PORT=8123"
set "URL=http://localhost:%PORT%/index.html"

where python >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" /B python -m http.server %PORT%
  goto :open_browser
)

where py >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" /B py -m http.server %PORT%
  goto :open_browser
)

where npx >nul 2>&1
if %ERRORLEVEL%==0 (
  start "" /B npx --yes serve -l %PORT%
  goto :open_browser
)

rem Last resort: file URL with forward slashes
set "APP=%~dp0index.html"
set "APP=%APP:\=/%"
set "FILEURL=file:///%APP%"

set "C1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "C2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
set "C3=%LocalAppData%\Google\Chrome\Application\chrome.exe"
set "E1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "E2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if exist "%C1%" ( start "" "%C1%" --app="%FILEURL%" & exit /b )
if exist "%C2%" ( start "" "%C2%" --app="%FILEURL%" & exit /b )
if exist "%C3%" ( start "" "%C3%" --app="%FILEURL%" & exit /b )
if exist "%E1%" ( start "" "%E1%" --app="%FILEURL%" & exit /b )
if exist "%E2%" ( start "" "%E2%" --app="%FILEURL%" & exit /b )
start "" "%FILEURL%"
exit /b 0

:open_browser
timeout /t 2 /nobreak >nul

set "C1=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "C2=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
set "C3=%LocalAppData%\Google\Chrome\Application\chrome.exe"
set "E1=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "E2=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if exist "%C1%" ( start "" "%C1%" --app="%URL%" & exit /b )
if exist "%C2%" ( start "" "%C2%" --app="%URL%" & exit /b )
if exist "%C3%" ( start "" "%C3%" --app="%URL%" & exit /b )
if exist "%E1%" ( start "" "%E1%" --app="%URL%" & exit /b )
if exist "%E2%" ( start "" "%E2%" --app="%URL%" & exit /b )
start "" "%URL%"
exit /b 0
