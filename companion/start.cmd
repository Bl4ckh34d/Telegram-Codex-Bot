@echo off
cd /d "%~dp0\.."
node companion\init.js
if errorlevel 1 exit /b 1
node companion\server.js
pause
