@echo off
REM Murmur Lite — one-click desktop launcher
REM Starts the server (if not already running) and opens the Electron window.
cd /d "%~dp0"
npx electron .
