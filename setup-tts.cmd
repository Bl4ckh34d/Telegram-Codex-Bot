@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
  )
)

set "TTS_ENABLED="
set "TTS_AIDOLON_SERVER_DIR="
set "TTS_REFERENCE_AUDIO="
set "TTS_FFMPEG_BIN="

for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  set "K=%%A"
  set "V=%%B"
  if /i "!K!"=="TTS_ENABLED" set "TTS_ENABLED=!V!"
  if /i "!K!"=="TTS_AIDOLON_SERVER_DIR" set "TTS_AIDOLON_SERVER_DIR=!V!"
  if /i "!K!"=="TTS_REFERENCE_AUDIO" set "TTS_REFERENCE_AUDIO=!V!"
  if /i "!K!"=="TTS_FFMPEG_BIN" set "TTS_FFMPEG_BIN=!V!"
)

set "DO_TTS="
if /i "%TTS_ENABLED%"=="1" set "DO_TTS=1"
if /i "%TTS_ENABLED%"=="true" set "DO_TTS=1"
if /i "%TTS_ENABLED%"=="yes" set "DO_TTS=1"
if /i "%TTS_ENABLED%"=="on" set "DO_TTS=1"
if not defined DO_TTS exit /b 0

if not defined TTS_AIDOLON_SERVER_DIR set "TTS_AIDOLON_SERVER_DIR=..\\aidolon_server"
for %%I in ("%TTS_AIDOLON_SERVER_DIR%") do set "SERVER_DIR=%%~fI"

if not defined TTS_REFERENCE_AUDIO set "TTS_REFERENCE_AUDIO=assets\\reference.wav"
for %%I in ("%TTS_REFERENCE_AUDIO%") do set "REF_DST=%%~fI"

set "REF_SRC=%SERVER_DIR%\\data\\reference_audio\\reference.wav"

if not exist "%SERVER_DIR%\\start_server.bat" (
  echo TTS setup failed: Aidolon Server not found at "%SERVER_DIR%".
  echo Set TTS_AIDOLON_SERVER_DIR in .env.
  exit /b 1
)

if not defined TTS_FFMPEG_BIN set "TTS_FFMPEG_BIN=ffmpeg"
if exist "%TTS_FFMPEG_BIN%" (
  rem ok
) else (
  where "%TTS_FFMPEG_BIN%" >nul 2>&1
  if errorlevel 1 (
    echo TTS setup failed: ffmpeg not found ("%TTS_FFMPEG_BIN%").
    echo Install ffmpeg or set TTS_FFMPEG_BIN in .env.
    exit /b 1
  )
)

if not exist "%REF_DST%" (
  if exist "%REF_SRC%" (
    for %%D in ("%REF_DST%") do set "REF_DIR=%%~dpD"
    if not exist "%REF_DIR%" mkdir "%REF_DIR%" >nul 2>&1
    copy /Y "%REF_SRC%" "%REF_DST%" >nul
    if errorlevel 1 (
      echo WARNING: Failed to copy reference audio to "%REF_DST%".
    )
  ) else (
    echo WARNING: Reference audio not found at "%REF_SRC%".
  )
)

echo Ensuring Aidolon Server TTS dependencies...
set "AIDOLON_SETUP_ONLY=1"
set "AIDOLON_SKIP_PREFETCH=1"
set "AIDOLON_SKIP_LLAMA_WAIT=1"
call "%SERVER_DIR%\\start_server.bat"
if errorlevel 1 (
  echo TTS dependency setup failed.
  exit /b 1
)

exit /b 0
