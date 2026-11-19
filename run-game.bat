@echo off
title Townforge Numista - Game Launcher
cd /d "%~dp0"

echo ============================================
echo   TOWNFORGE NUMISTA - Game Server Launcher
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

echo Starting Backend API Server (port 3001)...
start "Townforge API Server" cmd /k "cd /d ""%~dp0"" && node ""%~dp0server\index.js"""

echo Waiting for backend to initialize...
timeout /t 3 /nobreak >nul

echo Starting Frontend Dev Server (port 5173)...
start "Townforge Frontend" cmd /k "cd /d ""%~dp0"" && node ""%~dp0node_modules\vite\bin\vite.js"""

echo Waiting for Vite to start...
timeout /t 4 /nobreak >nul

echo.
echo ============================================
echo   Game is running!
echo   Backend API : http://localhost:3001
echo   Frontend    : http://localhost:5173
echo ============================================
echo.
echo Opening game in browser...
start "" http://localhost:5173

echo.
echo Both servers are running in separate windows.
echo Close those windows to stop the servers.
pause
