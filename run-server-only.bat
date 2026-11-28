@echo off
title Worldtycoon - API Server
cd /d "%~dp0"

echo ============================================
echo   WORLDTYCOON - Backend API Server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo ERROR: Dependencies are missing ^(node_modules not found^).
  echo Run: npm install
  echo Or run launch.bat / run-game.ps1 to install and start.
  pause
  exit /b 1
)

echo Building the frontend served on port 3001...
call npm run build
if errorlevel 1 (
  echo ERROR: Frontend build failed. The server was not started.
  pause
  exit /b 1
)

echo Starting server on http://localhost:3001 ...
echo Press Ctrl+C to stop.
echo.
node "%~dp0server\index.js"
pause
