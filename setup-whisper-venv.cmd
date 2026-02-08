@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "UV_ENABLED=auto"
set "WHISPER_VENV_PATH=.venv"
if exist ".env" (
  for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
    set "K=%%A"
    set "V=%%B"
    if /i "!K!"=="UV_ENABLED" set "UV_ENABLED=!V!"
    if /i "!K!"=="WHISPER_VENV_PATH" set "WHISPER_VENV_PATH=!V!"
  )
)

for %%I in ("%WHISPER_VENV_PATH%") do set "VENV_DIR=%%~fI"

set "HAS_UV="
where /q uv
if not errorlevel 1 set "HAS_UV=1"
if /i "%UV_ENABLED%"=="0" set "HAS_UV="
if /i "%UV_ENABLED%"=="1" if not defined HAS_UV goto :uv_missing

if exist "%VENV_DIR%\Scripts\python.exe" goto has_venv

echo Creating venv for Whisper at "%VENV_DIR%"...
if defined HAS_UV (
  uv venv --python 3.12 "%VENV_DIR%" 2>nul
  if errorlevel 1 uv venv "%VENV_DIR%"
) else (
  if exist "%SystemRoot%\py.exe" (
    py -3.12 -m venv "%VENV_DIR%" 2>nul
    if errorlevel 1 py -3.11 -m venv "%VENV_DIR%" 2>nul
    if errorlevel 1 py -3.10 -m venv "%VENV_DIR%" 2>nul
  ) else (
    python -m venv "%VENV_DIR%"
  )
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo Failed to create venv. Ensure Python 3.10+ is installed.
  exit /b 1
)

:has_venv
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo Warning: ffmpeg not found on PATH. Whisper transcription will fail without ffmpeg.
)

echo Installing OpenAI Whisper into "%VENV_DIR%"...
if defined HAS_UV (
  uv pip install --python "%VENV_DIR%\Scripts\python.exe" --upgrade openai-whisper
  if errorlevel 1 exit /b 1
) else (
  "%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
  if errorlevel 1 exit /b 1
  "%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade openai-whisper
  if errorlevel 1 exit /b 1
)
if errorlevel 1 exit /b 1

echo Whisper venv setup complete.
echo Python: %VENV_DIR%\Scripts\python.exe
endlocal
exit /b 0

:uv_missing
echo UV is required because UV_ENABLED is 1, but uv was not found on PATH.
exit /b 1
