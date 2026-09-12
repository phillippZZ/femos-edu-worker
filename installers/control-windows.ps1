param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$AppDir = Split-Path $PSScriptRoot -Parent
$DataDir = Join-Path $env:LOCALAPPDATA "FEMOS Worker"
$PidFile = Join-Path $DataDir "worker.pid"
$OutLog = Join-Path $DataDir "worker.log"
$ErrorLog = Join-Path $DataDir "worker-error.log"
$Node = Join-Path $AppDir "bin\node.exe"
$Server = Join-Path $AppDir "app\src\server.mjs"

function Test-WorkerHealth {
  try { $null = Invoke-RestMethod "http://127.0.0.1:32145/v1/health"; return $true } catch { return $false }
}

function Start-Worker {
  if (Test-WorkerHealth) { Write-Host "FEMOS Worker is already running."; return }
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $Process = Start-Process -FilePath $Node -ArgumentList ('"' + $Server + '"') -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrorLog -PassThru
  [System.IO.File]::WriteAllText($PidFile, [string]$Process.Id)
  for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    Start-Sleep -Seconds 1
    if (Test-WorkerHealth) { Write-Host "FEMOS Worker started."; return }
  }
  throw "FEMOS Worker did not become healthy. Check $ErrorLog"
}

function Stop-Worker {
  if (Test-WorkerHealth) {
    try { Invoke-RestMethod -Method Post -ContentType "application/json" -Body '{"action":"shutdown"}' "http://127.0.0.1:32145/v1/control" | Out-Null } catch {}
    for ($Attempt = 0; $Attempt -lt 5; $Attempt++) {
      Start-Sleep -Seconds 1
      if (-not (Test-WorkerHealth)) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue; Write-Host "FEMOS Worker stopped."; return }
    }
  }
  if (Test-Path $PidFile) {
    $WorkerPid = [int](Get-Content $PidFile -Raw)
    Stop-Process -Id $WorkerPid -Force -ErrorAction SilentlyContinue
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  Write-Host "FEMOS Worker is stopped."
}

switch ($Action) {
  "start" { Start-Worker }
  "stop" { Stop-Worker }
  "restart" { Stop-Worker; Start-Worker }
  "status" {
    try {
      Invoke-RestMethod "http://127.0.0.1:32145/v1/health" | ConvertTo-Json -Depth 5
    } catch {
      Write-Host "FEMOS Worker is stopped."
    }
  }
}
