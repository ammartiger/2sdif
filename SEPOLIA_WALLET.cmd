@echo off
rem 2SDIF Sepolia, step 1: create or show the throwaway Sepolia wallet to fund from a faucet.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" sync
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_azure.ps1" sepolia-wallet
echo.
echo Fund the ADMIN wallet address shown above from a Sepolia faucet, then double-click SEPOLIA_RUN.cmd.
pause
