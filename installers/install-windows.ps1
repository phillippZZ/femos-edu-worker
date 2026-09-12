$ErrorActionPreference = "Stop"

$Repository = "phillippZZ/femos-edu-worker"
$Asset = "femos-worker-windows-x64.zip"
$InstallRoot = Join-Path $env:LOCALAPPDATA "FEMOS Worker"
$AppDir = Join-Path $InstallRoot "app"
$DataDir = Join-Path $InstallRoot "data"
$TaskName = "FEMOS Worker"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("femos-worker-" + [guid]::NewGuid())

New-Item -ItemType Directory -Force -Path $TempDir, $InstallRoot, $DataDir | Out-Null
try {
  $BaseUrl = "https://github.com/$Repository/releases/latest/download"
  $Archive = Join-Path $TempDir $Asset
  $ChecksumFile = "$Archive.sha256"
  Write-Host "Downloading FEMOS Worker..."
  Invoke-WebRequest "$BaseUrl/$Asset" -OutFile $Archive
  Invoke-WebRequest "$BaseUrl/$Asset.sha256" -OutFile $ChecksumFile
  $Expected = ((Get-Content $ChecksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw "FEMOS Worker checksum verification failed." }

  Expand-Archive $Archive -DestinationPath $TempDir -Force
  $Extracted = Join-Path $TempDir "femos-worker"
  if (-not (Test-Path (Join-Path $Extracted "bin\node.exe"))) { throw "The release does not contain Node.js." }
  if (-not (Test-Path (Join-Path $Extracted "bin\arduino-cli.exe"))) { throw "The release does not contain Arduino CLI." }

  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  $Previous = Join-Path $InstallRoot "app.previous"
  if (Test-Path $Previous) { Remove-Item $Previous -Recurse -Force }
  if (Test-Path $AppDir) { Move-Item $AppDir $Previous }
  Move-Item $Extracted $AppDir
  $ExpectedVersion = (Get-Content (Join-Path $AppDir "VERSION") -Raw).Trim()

  $Node = Join-Path $AppDir "bin\node.exe"
  $Server = Join-Path $AppDir "app\src\server.mjs"
  $Action = New-ScheduledTaskAction -Execute $Node -Argument ('"' + $Server + '"')
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
  $TaskSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $TaskSettings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName

  for ($Attempt = 0; $Attempt -lt 10; $Attempt++) {
    Start-Sleep -Seconds 1
    try {
      $Health = Invoke-RestMethod "http://127.0.0.1:32145/v1/health"
      if ($Health.version -eq $ExpectedVersion) {
        Write-Host "FEMOS Worker is installed and running."
        Write-Host "Open https://femos.ai/worker-console"
        exit 0
      }
    } catch {}
  }
  throw "The worker was installed but did not become healthy. Stop any older worker using port 32145 and run the installer again."
} finally {
  Remove-Item $TempDir -Recurse -Force -ErrorAction SilentlyContinue
}
