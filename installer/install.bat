@echo off
rem Podcast Kurgu Asistani - elle kurulum (setup.exe olmadan)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
