@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---- locate Node.js: PATH first, then common install locations ----
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 (
  set "NODE_EXE="
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
  if not defined NODE_EXE (
    echo [ERROR] Node.js not found. Install Node 18 or newer, or add node.exe to PATH.
    pause
    exit /b 1
  )
)

echo ==================================================
echo   DeepSeek Chatbox
echo   Desktop : http://127.0.0.1:17321
echo   Phone   : open the LAN line printed below
echo   Stop    : close this window or press Ctrl+C
echo ==================================================
echo.
echo (Local only? right-click edit, add  --local-only  after server.mjs)
echo.

start "" http://127.0.0.1:17321
"%NODE_EXE%" server.mjs %*

echo.
echo Server stopped.
pause
