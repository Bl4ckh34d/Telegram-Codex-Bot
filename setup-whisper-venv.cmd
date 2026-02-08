@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto has_venv

echo Creating .venv for Whisper...
if exist "%SystemRoot%\py.exe" (
  py -3.12 -m venv .venv 2>nul
  if errorlevel 1 py -3.11 -m venv .venv 2>nul
  if errorlevel 1 py -3.10 -m venv .venv 2>nul
) else (
  python -m venv .venv
)

if not exist ".venv\Scripts\python.exe" (
  echo Failed to create venv. Ensure Python 3.10+ is installed.
  exit /b 1
)

:has_venv
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo Warning: ffmpeg not found on PATH. Whisper transcription will fail without ffmpeg.
)

echo Upgrading pip/setuptools/wheel...
".venv\Scripts\python.exe" -m pip install --upgrade pip setuptools wheel
if errorlevel 1 exit /b 1

echo Installing OpenAI Whisper into .venv...
".venv\Scripts\python.exe" -m pip install --upgrade openai-whisper
if errorlevel 1 exit /b 1

echo Whisper venv setup complete.
echo Python: .venv\Scripts\python.exe
endlocal
