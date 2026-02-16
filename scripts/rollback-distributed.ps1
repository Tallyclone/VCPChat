param(
  [string]$BackupTimestamp
)

if (-not $BackupTimestamp) {
  Write-Error "Please provide -BackupTimestamp"
  exit 1
}

$backupDir = "D:\Vchat\VCPChat\AppData\release_backups\$BackupTimestamp"
if (!(Test-Path $backupDir)) {
  Write-Error "Backup directory not found: $backupDir"
  exit 1
}

Write-Host "[Rollback] Using backup: $backupDir"
Write-Host "[Rollback] TODO: Restore Host package"
Write-Host "[Rollback] TODO: Rollback desktop updater channel"
Write-Host "[Rollback] TODO: Rollback mobile OTA bundle pointer"
Write-Host "[Rollback] Completed (manual placeholders)."
