@echo off
rem 2SDIF Sepolia, step 2: deploy on Sepolia and measure commit latency (after funding the wallet).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" sync
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" sepolia
echo.
echo Finished. The log is azure_run.log in this folder.
pause
