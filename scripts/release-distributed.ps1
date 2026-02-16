param(
  [string]$Target = "all",
  [string]$Version = "0.1.0"
)

Write-Host "[Release] Starting distributed release pipeline..."
Write-Host "[Release] Target: $Target"
Write-Host "[Release] Version: $Version"

# 1) Host backup marker
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupDir = "D:\Vchat\VCPChat\AppData\release_backups\$timestamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
Write-Host "[Release] Backup directory prepared: $backupDir"

# 2) Placeholder: add build commands here
Write-Host "[Release] TODO: Build Host package"
Write-Host "[Release] TODO: Build Remote Desktop package"
Write-Host "[Release] TODO: Publish Mobile OTA bundle"

# 3) Write release metadata
$meta = @{
  version = $Version
  target = $Target
  timestamp = $timestamp
  status = "prepared"
}
$meta | ConvertTo-Json | Set-Content -Path "$backupDir\release-meta.json" -Encoding UTF8

Write-Host "[Release] Pipeline completed (prepared state)."
