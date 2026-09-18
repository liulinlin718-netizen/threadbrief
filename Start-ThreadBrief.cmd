@echo off
powershell.exe -NoProfile -File "%~dp0app\Start-ThreadBrief-Codex.ps1"
if errorlevel 1 pause
