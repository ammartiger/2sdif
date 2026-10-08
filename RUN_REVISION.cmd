@echo off
rem 2SDIF revision: all experiments for the revised paper (about 3 hours). Double-click to start.
rem Keep the laptop plugged in with the lid open. The window keeps the PC awake while it runs.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" revision
echo.
echo Finished. The log is azure_run.log in this folder; results are in results_azure.
pause
