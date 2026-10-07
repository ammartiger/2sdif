@echo off
rem 2SDIF: delete everything that was created on Azure (double-click when the results are checked).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" teardown
echo.
pause
