@echo off
rem 2SDIF: follow-up steps (retrieval, attack suite against the deployed witness, gas including batched commitments). About 15 minutes.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" extra
echo.
echo Finished. Results are in results_revision.
pause
