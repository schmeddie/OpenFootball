@echo off
rem Double-click to open OpenFootball in your browser.
rem Starts a small local web server (serve.ps1) so the app can load
rem players.csv and use all your CPU cores.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
if errorlevel 1 pause
