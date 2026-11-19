@echo off
title Townforge Numista - API Server
cd /d "%~dp0"

echo ============================================
echo   TOWNFORGE NUMISTA - Backend API Server
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

echo Starting server on http://localhost:3001 ...
echo Press Ctrl+C to stop.
echo.
node "%~dp0server\index.js"
pause
