# Townforge Numista - Full Game Launcher
# Run this via launch.bat (bypasses PowerShell execution policy)

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectDir

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  TOWNFORGE NUMISTA - Game Launcher" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check Node.js is available
try {
    $nodeVersion = node --version 2>&1
    if ($LASTEXITCODE -ne 0) { throw "node failed" }
    Write-Host "Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js not found. Please install Node.js from https://nodejs.org" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies (first run)..." -ForegroundColor Yellow
    cmd /c "cd /d `"$projectDir`" && npm install"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Dependency installation failed. Please run 'npm install' manually." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

if (-not (Test-Path "node_modules\vite\bin\vite.js")) {
    Write-Host "ERROR: Vite is missing. Run 'npm install' in this folder." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "Starting Backend API Server on http://localhost:3001 ..." -ForegroundColor Green
$apiServer = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "cd /d `"$projectDir`" && node `"$projectDir\server\index.js`"" `
    -PassThru `
    -WindowStyle Normal

Write-Host "Waiting for backend to initialize..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

Write-Host "Starting Frontend Dev Server on http://localhost:5173 ..." -ForegroundColor Green
$frontendServer = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k", "cd /d `"$projectDir`" && node `"$projectDir\node_modules\vite\bin\vite.js`"" `
    -PassThru `
    -WindowStyle Normal

Write-Host "Waiting for Vite to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 4

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Game is running!" -ForegroundColor Green
Write-Host "  Backend API : http://localhost:3001" -ForegroundColor White
Write-Host "  Frontend    : http://localhost:5173" -ForegroundColor White
Write-Host "  (Map uses free tile providers; no API key required)" -ForegroundColor DarkGray
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Open in browser
Start-Process "http://localhost:5173"

Write-Host "Both servers launched in separate windows." -ForegroundColor Yellow
Write-Host "Close those CMD windows to stop the servers." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter to close this launcher"
