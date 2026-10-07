@echo off
rem 2SDIF: deploy the witness to Azure and run the benchmarks (double-click to start).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" all
echo.
echo Finished. The log is azure_run.log in this folder.
pause
