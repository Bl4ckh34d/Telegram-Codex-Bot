@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from .env.example. Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
)

where node >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-codex-path.ps1" >nul 2>&1
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%ProgramFiles%\nodejs;%PATH%"
  )
  if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
    set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
  )
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js not found in PATH.
    exit /b 1
  )
)

where codex >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ensure-codex-path.ps1" >nul 2>&1
  if exist "%APPDATA%\npm\codex.cmd" (
    set "PATH=%APPDATA%\npm;%PATH%"
    echo Added "%APPDATA%\npm" to current session PATH.
  )
)

if exist "%~dp0setup-tts.cmd" (
  call "%~dp0setup-tts.cmd"
  if errorlevel 1 (
    echo.
    echo TTS setup failed. Fix the errors above, or set TTS_ENABLED=0 in .env to skip TTS.
    exit /b 1
  )
)

:run
node bot.js
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="75" (
  echo Bot restart requested. Relaunching...
  timeout /t 1 >nul
  goto run
)
endlocal
exit /b %EXITCODE%
