# Ежедневная копия дампов базы с VPS на машину владельца.
# Запускается задачей Windows «tnved-db-backup-pull» (12:00, StartWhenAvailable):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\CustomsAssistKG\server\pull-db-backups.ps1
# Локально дампы хранятся 30 дней — этот срок назван в privacy.html. Старые
# копии удаляются, только если есть свежая (не старше 2 дней): при недоступном
# сервере или сломанном таймере дампа локальные копии — последнее, что есть.
$dest = Join-Path $env:USERPROFILE 'tnved-db-backups'
New-Item -ItemType Directory -Force $dest | Out-Null
& "$env:SystemRoot\System32\OpenSSH\scp.exe" -B -p -q -o ConnectTimeout=30 'root@65.109.170.170:/var/backups/tnved-db/*.dump' $dest
$code = $LASTEXITCODE
$dumps = Get-ChildItem $dest -Filter 'tnved_*.dump'
if ($dumps | Where-Object LastWriteTime -gt (Get-Date).AddDays(-2)) {
  $dumps | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item
}
exit $code
