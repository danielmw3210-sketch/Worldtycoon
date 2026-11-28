@echo off
title Worldtycoon - Full Launcher (PowerShell)
cd /d "%~dp0"

REM Launch the PowerShell script with execution policy bypass
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0run-game.ps1"
