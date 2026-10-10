@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer from https://nodejs.org then run again.
  pause
  exit /b 1
)
if not exist "node_modules\qrcode\package.json" (
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
node server.mjs
pause
