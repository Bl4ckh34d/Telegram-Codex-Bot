@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

if /i "%TTS_DEBUG%"=="1" (
  echo on
  echo [setup-tts] debug echo enabled
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
  )
)

set "TTS_ENABLED="
set "TTS_VENV_PATH="
set "TTS_MODEL="
set "TTS_REFERENCE_AUDIO="
set "TTS_FFMPEG_BIN="
set "UV_ENABLED="

for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  set "K=%%A"
  set "V=%%B"
  if /i "!K!"=="TTS_ENABLED" set "TTS_ENABLED=!V!"
  if /i "!K!"=="TTS_VENV_PATH" set "TTS_VENV_PATH=!V!"
  if /i "!K!"=="TTS_MODEL" set "TTS_MODEL=!V!"
  if /i "!K!"=="TTS_REFERENCE_AUDIO" set "TTS_REFERENCE_AUDIO=!V!"
  if /i "!K!"=="TTS_FFMPEG_BIN" set "TTS_FFMPEG_BIN=!V!"
  if /i "!K!"=="UV_ENABLED" set "UV_ENABLED=!V!"
)

set "DO_TTS="
if /i "%TTS_ENABLED%"=="1" set "DO_TTS=1"
if /i "%TTS_ENABLED%"=="true" set "DO_TTS=1"
if /i "%TTS_ENABLED%"=="yes" set "DO_TTS=1"
if /i "%TTS_ENABLED%"=="on" set "DO_TTS=1"
if not defined DO_TTS exit /b 0

if not defined TTS_VENV_PATH set "TTS_VENV_PATH=.tts-venv"
for %%I in ("%TTS_VENV_PATH%") do set "VENV_DIR=%%~fI"

if not defined TTS_MODEL (
  echo TTS setup failed: TTS_MODEL is not set in .env.
  exit /b 1
)

if not defined TTS_REFERENCE_AUDIO set "TTS_REFERENCE_AUDIO=assets\\reference.wav"
for %%I in ("%TTS_REFERENCE_AUDIO%") do set "REF_DST=%%~fI"

if not defined TTS_FFMPEG_BIN set "TTS_FFMPEG_BIN=ffmpeg"
if exist "%TTS_FFMPEG_BIN%" goto :ffmpeg_ok
where /q "%TTS_FFMPEG_BIN%"
if not errorlevel 1 goto :ffmpeg_ok
echo TTS setup failed: ffmpeg not found ("%TTS_FFMPEG_BIN%").
echo Install ffmpeg or set TTS_FFMPEG_BIN in .env.
exit /b 1

:ffmpeg_ok

if not exist "%REF_DST%" (
  echo WARNING: Reference audio not found at "%REF_DST%".
  echo WARNING: Set TTS_REFERENCE_AUDIO to an existing WAV file.
)

set "PYTHON_CMD="
set "PYTHON_ARGS="

rem NOTE: Avoid FOR /F with inline python snippets containing parentheses; cmd parsing is fragile there.
py -3.12 -V >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_CMD=py"
  set "PYTHON_ARGS=-3.12"
  goto :found_python
)

where python >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_CMD=python"
  set "PYTHON_ARGS="
  goto :found_python
)

where py >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_CMD=py"
  set "PYTHON_ARGS=-3"
  goto :found_python
)

:found_python
if not defined PYTHON_CMD (
  echo TTS setup failed: Python 3.10+ not found in PATH. Install Python and retry.
  exit /b 1
)

set "HAS_UV="
if not defined UV_ENABLED set "UV_ENABLED=auto"
where /q uv
if not errorlevel 1 set "HAS_UV=1"
if /i "%UV_ENABLED%"=="0" set "HAS_UV="
if /i "%UV_ENABLED%"=="1" if not defined HAS_UV goto :uv_missing

if not exist "%VENV_DIR%\\Scripts\\python.exe" (
  echo Creating TTS virtual environment at "%VENV_DIR%"...
  if defined HAS_UV (
    uv venv --python 3.12 "%VENV_DIR%" 2>nul
    if errorlevel 1 uv venv "%VENV_DIR%"
  ) else (
    "%PYTHON_CMD%" %PYTHON_ARGS% -m venv "%VENV_DIR%"
  )
  if errorlevel 1 exit /b 1
)

echo Installing MiraTTS dependencies into "%VENV_DIR%"...
set "VENV_PY=%VENV_DIR%\\Scripts\\python.exe"

set "TORCH_CUDA_PACKAGES=torch==2.8.0+cu128 torchvision==0.23.0+cu128 torchaudio==2.8.0+cu128"
set "TORCH_CPU_PACKAGES=torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0"

where nvidia-smi >nul 2>&1
if errorlevel 1 (
  echo NVIDIA GPU not detected. Falling back to CPU-only torch...
  if defined HAS_UV (
    uv pip install --python "%VENV_PY%" %TORCH_CPU_PACKAGES%
    if errorlevel 1 exit /b 1
  ) else (
    "%VENV_PY%" -m pip install %TORCH_CPU_PACKAGES%
    if errorlevel 1 exit /b 1
  )
) else (
  "%VENV_PY%" -c "import torch,sys; v=torch.__version__.split('+')[0].split('.'); sys.exit(0 if torch.cuda.is_available() and (int(v[0]),int(v[1])) >= (2,8) else 1)" >nul 2>&1
  if errorlevel 1 (
    echo Installing CUDA-enabled torch stack...
    if defined HAS_UV (
      uv pip install --python "%VENV_PY%" --upgrade --force-reinstall %TORCH_CUDA_PACKAGES% --index-url https://download.pytorch.org/whl/cu128
      if errorlevel 1 exit /b 1
    ) else (
      "%VENV_PY%" -m pip install --upgrade --force-reinstall %TORCH_CUDA_PACKAGES% --index-url https://download.pytorch.org/whl/cu128
      if errorlevel 1 exit /b 1
    )
    "%VENV_PY%" -c "import torch,sys; v=torch.__version__.split('+')[0].split('.'); sys.exit(0 if torch.cuda.is_available() and (int(v[0]),int(v[1])) >= (2,8) else 1)" >nul 2>&1
    if errorlevel 1 exit /b 1
  )
  "%VENV_PY%" -c "import torch,torchaudio; assert torch.cuda.is_available()" >nul 2>&1
  if errorlevel 1 exit /b 1
)

if defined HAS_UV (
  uv pip install --python "%VENV_PY%" "numpy<2" soundfile omegaconf
  if errorlevel 1 exit /b 1
) else (
  "%VENV_PY%" -m pip install "numpy<2" soundfile omegaconf
  if errorlevel 1 exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  echo TTS setup failed: git not found in PATH.
  echo Install Git for Windows or add git.exe to PATH, then retry.
  exit /b 1
)
if defined HAS_UV (
  uv pip install --python "%VENV_PY%" "git+https://github.com/ysharma3501/MiraTTS.git"
  if errorlevel 1 exit /b 1
) else (
  "%VENV_PY%" -m pip install "git+https://github.com/ysharma3501/MiraTTS.git"
  if errorlevel 1 exit /b 1
)
if errorlevel 1 exit /b 1

"%VENV_PY%" -c "from mira.model import MiraTTS; print('MiraTTS import ok')"
if errorlevel 1 (
  echo TTS setup failed: MiraTTS import failed.
  exit /b 1
)

exit /b 0

:uv_missing
echo UV is required because UV_ENABLED is 1, but uv was not found on PATH.
exit /b 1
