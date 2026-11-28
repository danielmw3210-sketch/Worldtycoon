@echo off
title Worldtycoon Server
cd /d "%~dp0"

echo Starting Worldtycoon Webapp Server on http://localhost:3001 ...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo ERROR: Dependencies are missing ^(node_modules not found^). Run: npm install
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

node "%~dp0server\index.js"
pause
