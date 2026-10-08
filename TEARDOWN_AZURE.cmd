@echo off
rem 2SDIF: delete everything that was created on Azure (resource group, purged Key Vault, default Log Analytics workspace).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" sync
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" teardown
echo.
echo Finished. The log is azure_run.log in this folder.
pause
