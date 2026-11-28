@echo off
title Worldtycoon - Frontend Dev Server
cd /d "%~dp0"

echo ============================================
echo   WORLDTYCOON - Frontend Dev Server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo ERROR: Vite is not installed ^(node_modules missing or incomplete^).
  echo Run: npm install
  pause
  exit /b 1
)

echo Starting Vite on http://localhost:5173 ...
echo Press Ctrl+C to stop.
echo.
node "%~dp0node_modules\vite\bin\vite.js"
pause
