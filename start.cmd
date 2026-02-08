@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from .env.example. Fill TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.
)

rem Load a few toggles from .env so start.cmd can conditionally bootstrap deps.
set "UV_ENABLED=auto"
set "WHISPER_ENABLED=1"
for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  set "K=%%A"
  set "V=%%B"
  if /i "!K!"=="UV_ENABLED" set "UV_ENABLED=!V!"
  if /i "!K!"=="WHISPER_ENABLED" set "WHISPER_ENABLED=!V!"
)

set "DO_WHISPER="
for %%G in (1 true yes on) do if /i "!WHISPER_ENABLED!"=="%%G" set "DO_WHISPER=1"

rem Bootstrap uv so both venv installers can use it (much faster than pip).
set "UV_WANTED="
set "UV_REQUIRED="
if /i "!UV_ENABLED!"=="1" set "UV_REQUIRED=1"
if /i "!UV_ENABLED!"=="auto" set "UV_WANTED=1"
if defined UV_REQUIRED set "UV_WANTED=1"

if defined UV_WANTED (
  call :ensure_uv
  if errorlevel 1 (
    if defined UV_REQUIRED (
      echo uv bootstrap failed and UV_ENABLED=1. Aborting.
      exit /b 1
    ) else (
      echo WARNING: uv bootstrap failed; continuing without uv. Installs may be slower.
    )
  )
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

if defined DO_WHISPER if exist "%~dp0setup-whisper-venv.cmd" (
  call "%~dp0setup-whisper-venv.cmd"
  if errorlevel 1 (
    echo.
    echo Whisper setup failed. Fix the errors above, or set WHISPER_ENABLED=0 in .env to skip Whisper.
    exit /b 1
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

:ensure_uv
where /q uv
if not errorlevel 1 exit /b 0

call :maybe_add_uv_dir "%USERPROFILE%\.local\bin"
call :maybe_add_uv_dir "%USERPROFILE%\.cargo\bin"
call :maybe_add_uv_dir "%LOCALAPPDATA%\uv\bin"
call :maybe_add_uv_dir "%APPDATA%\uv\bin"

where /q uv
if not errorlevel 1 exit /b 0

echo uv not found; installing uv for current user...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { irm https://astral.sh/uv/install.ps1 | iex } catch { exit 1 }" >nul 2>&1

rem The installer may update user PATH, but this cmd session won't see it; probe common install dirs.
call :maybe_add_uv_dir "%USERPROFILE%\.local\bin"
call :maybe_add_uv_dir "%USERPROFILE%\.cargo\bin"
call :maybe_add_uv_dir "%LOCALAPPDATA%\uv\bin"
call :maybe_add_uv_dir "%APPDATA%\uv\bin"

where /q uv
if not errorlevel 1 (
  echo uv is ready.
  exit /b 0
)

echo uv install did not place uv on PATH for this session.
exit /b 1

:maybe_add_uv_dir
set "D=%~1"
if exist "%D%\uv.exe" (
  set "PATH=%D%;%PATH%"
)
exit /b 0

