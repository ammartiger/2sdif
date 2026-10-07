<#
  2SDIF on Azure - Windows runner (Windows PowerShell 5.1 or PowerShell 7).
  Run it from this folder:
      powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 <step>

  Easiest: double-click RUN_AZURE.cmd in this folder (runs 'all').

  Steps, in order:
    all              check, setup, login (if needed), preflight, deploy and bench in one go
    check            which tools are installed (Node.js, npm, Azure CLI) and basic host details
    setup            copy the code to %USERPROFILE%\2sdif (outside OneDrive), install packages, create keys, compile
    login            sign in to Azure in the browser and select the Azure for Students subscription
    preflight        pick a region that the subscription allows and that offers Flex Consumption
    deploy           create the witness on Azure (Function App, Table Storage, Key Vault) and deploy the code
    bench            run the benchmarks with this PC as the fog node; results are copied to .\results_azure
    sepolia-wallet   create/show the throwaway Sepolia wallet to fund from a faucet
    sepolia          Sepolia commit-latency run (after funding)
    status           show the deployment and the witness health
    teardown         delete everything that was created on Azure
    sync             copy changed code from this folder to the working copy (no reinstall)

  Every step appends to .\azure_run.log. Keys stay in %USERPROFILE%\2sdif\.env and are never written to the log.
#>
param([Parameter(Position = 0)][string]$Step = "help", [string]$Region = "")

$ErrorActionPreference = "Continue"
$Src  = $PSScriptRoot
$Work = Join-Path $env:USERPROFILE "2sdif"
$Log  = Join-Path $Src "azure_run.log"
$Out  = Join-Path $Src "results_azure"
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Say([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date).ToString("o"), $m
  Write-Host $line
  [System.IO.File]::AppendAllText($Log, $line + "`r`n", $Utf8)
}

# Runs a native command, echoing and logging its output; returns the exit code.
function Run([string]$exe, [string[]]$argList) {
  Say ("> " + $exe + " " + ($argList -join " "))
  & $exe @argList 2>&1 | ForEach-Object {
    $s = "$_"
    Write-Host $s
    [System.IO.File]::AppendAllText($Log, $s + "`r`n", $Utf8)
  }
  return $LASTEXITCODE
}

function Sync-Code {
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  robocopy $Src $Work /E /NFL /NDL /NJH /NJS /NP /XD node_modules legacy results results_azure sandbox_test_results artifacts cache data deployments .git /XF .env devices.json azure_run.log | Out-Null
  if ($LASTEXITCODE -ge 8) { Say "copying the code to $Work failed (robocopy $LASTEXITCODE)"; exit 1 }
  Say "code copied to $Work"
}

function Azure-Step([string]$name, [string[]]$extra) {
  if (-not (Test-Path (Join-Path $Work "node_modules"))) { Say "run the setup step first"; exit 1 }
  Push-Location $Work
  $a = @("scripts/azure.js", $name, "--log", $Log, "--copy-to", $Out) + $extra
  & node @a
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -ne 0) { Say "step '$name' failed (exit $code); see azure_run.log"; exit $code }
}

function Step-Check {
  try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    Say ("host: {0} {1}; CPU {2} ({3} cores / {4} threads); RAM {5:N1} GiB" -f $os.Caption, $os.Version, $cpu.Name.Trim(), $cpu.NumberOfCores, $cpu.NumberOfLogicalProcessors, ($os.TotalVisibleMemorySize / 1MB))
    $disk = Get-PSDrive -Name C
    Say ("free space on C: {0:N1} GiB" -f ($disk.Free / 1GB))
  } catch { Say "host details unavailable: $_" }
  $ok = $true
  foreach ($t in @("node", "npm", "az", "git", "winget")) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if ($c) {
      $v = (& $t --version 2>&1 | Select-Object -First 1)
      Say ("{0}: {1} ({2})" -f $t, "$v".Trim(), $c.Source)
    } else {
      Say ("{0}: NOT FOUND" -f $t)
      if ($t -eq "node" -or $t -eq "npm" -or $t -eq "az") { $ok = $false }
    }
  }
  $nv = Get-Command node -ErrorAction SilentlyContinue
  if ($nv) {
    $major = [int](((& node --version) -replace "^v", "").Split(".")[0])
    if ($major -lt 20) { Say "Node.js $major is too old; version 20 or newer is needed"; $ok = $false }
  }
  if (-not $ok) {
    Say "MISSING TOOLS. Install them with these two commands, then close this window and run again:"
    Say "    winget install -e --id OpenJS.NodeJS.LTS"
    Say "    winget install -e --id Microsoft.AzureCLI"
  }
  Say "work folder: $Work (exists: $(Test-Path $Work))"
  return $ok
}

function Step-Setup {
  Sync-Code
  Push-Location $Work
  $rc = Run "npm" @("ci", "--no-audit", "--no-fund")
  if ($rc -ne 0) { $rc = Run "npm" @("install", "--no-audit", "--no-fund") }
  if ($rc -ne 0) { Pop-Location; Say "package installation failed"; exit 1 }
  $rc = Run "node" @("scripts/gen-keys.js")
  $rc = Run "npx" @("hardhat", "compile")
  Pop-Location
  if ($rc -ne 0) { Say "compilation failed"; exit 1 }
  Say "setup done"
}

function Step-Login([bool]$onlyIfNeeded) {
  if ($onlyIfNeeded) {
    & az account show -o none --only-show-errors 2>$null
    if ($LASTEXITCODE -eq 0) {
      $cur = (& az account show -o json --only-show-errors) | ConvertFrom-Json
      Say ("already signed in to Azure; subscription: {0}" -f $cur.name)
      return
    }
  }
  & az config set core.login_experience_v2=off --only-show-errors 2>&1 | Out-Null
  Say "opening the browser for Azure sign-in (sign in with the account that has Azure for Students)"
  & az login --only-show-errors -o none
  if ($LASTEXITCODE -ne 0) { Say "az login failed"; exit 1 }
  $subs = (& az account list -o json --only-show-errors) | ConvertFrom-Json
  foreach ($s in $subs) { Say ("subscription: {0} ({1})" -f $s.name, $s.state) }
  $stud = $subs | Where-Object { $_.name -like "*Student*" -and $_.state -eq "Enabled" } | Select-Object -First 1
  if ($stud) {
    & az account set --subscription $stud.id --only-show-errors
    Say ("selected subscription: {0}" -f $stud.name)
  } else {
    $cur = (& az account show -o json --only-show-errors) | ConvertFrom-Json
    Say ("no 'Student' subscription found; using {0}" -f $cur.name)
  }
}

Say "=== run_azure.ps1 $Step ==="
switch ($Step) {
  "all" {
    if (-not (Step-Check)) { exit 1 }
    Step-Setup
    Step-Login $true
    if ($Region) { Azure-Step "preflight" @("--region", $Region) } else { Azure-Step "preflight" @() }
    Azure-Step "deploy" @()
    Azure-Step "bench" @()
    Say "ALL STEPS DONE. Results are in $Out. The Azure resources are still running; run 'teardown' when the results are checked."
  }
  "check" { Step-Check | Out-Null }
  "sync" { Sync-Code }
  "setup" { Step-Setup }
  "login" { Step-Login $false }
  "preflight" { if ($Region) { Azure-Step "preflight" @("--region", $Region) } else { Azure-Step "preflight" @() } }
  "deploy" { Azure-Step "deploy" @() }
  "bench" { Azure-Step "bench" @() }
  "sepolia-wallet" { Azure-Step "sepolia-wallet" @() }
  "sepolia" { Azure-Step "sepolia" @() }
  "status" { Azure-Step "status" @() }
  "teardown" { Azure-Step "teardown" @() }
  default {
    Get-Content $PSCommandPath -TotalCount 26 | Select-Object -Skip 1 | ForEach-Object { Write-Host $_ }
  }
}
