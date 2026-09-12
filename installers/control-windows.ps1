param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "status"
)

$ErrorActionPreference = "Stop"
$TaskName = "FEMOS Worker"

switch ($Action) {
  "start" { Start-ScheduledTask -TaskName $TaskName }
  "stop" { Stop-ScheduledTask -TaskName $TaskName }
  "restart" {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Start-ScheduledTask -TaskName $TaskName
  }
  "status" {
    try {
      Invoke-RestMethod "http://127.0.0.1:32145/v1/health" | ConvertTo-Json -Depth 5
    } catch {
      Write-Host "FEMOS Worker is stopped."
    }
  }
}
