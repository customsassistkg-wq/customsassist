# Ежедневная копия дампов базы с VPS на машину владельца.
# Запускается задачей Windows «tnved-db-backup-pull» (12:00, StartWhenAvailable):
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\CustomsAssistKG\server\pull-db-backups.ps1
# Локально дампы хранятся 30 дней — этот срок назван в privacy.html. Старые
# копии удаляются, только если есть свежая (не старше 2 дней): при недоступном
# сервере или сломанном таймере дампа локальные копии — последнее, что есть.
# После удачной выгрузки на сервере отмечается время (/var/lib/tnved/last-pull) — по нему дашборд
# показывает плитку «Вывоз копий»: иначе сорванный вывоз не виден ниоткуда
# (22.09.2026 задачу убил десятиминутный лимит, и копия за сутки не уехала).
$dest = Join-Path $env:USERPROFILE 'tnved-db-backups'
New-Item -ItemType Directory -Force $dest | Out-Null
& "$env:SystemRoot\System32\OpenSSH\scp.exe" -B -p -q -o ConnectTimeout=30 'root@65.109.170.170:/var/backups/tnved-db/*.dump' $dest
$code = $LASTEXITCODE
$dumps = Get-ChildItem $dest -Filter 'tnved_*.dump'
$fresh = $dumps | Where-Object LastWriteTime -gt (Get-Date).AddDays(-2)
if ($fresh) {
  $dumps | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item
}
if ($code -eq 0 -and $fresh) {
  & "$env:SystemRoot\System32\OpenSSH\ssh.exe" -o BatchMode=yes -o ConnectTimeout=30 root@65.109.170.170 `
    'date -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/tnved/last-pull' | Out-Null
}
# Короткий журнал рядом с копиями: когда, с каким кодом, сколько копий и самая свежая.
# Строка латиницей: Windows PowerShell 5.1 читает .ps1 без BOM как ANSI и кириллицу в ней портит.
"{0} exit={1} dumps={2} newest={3}" -f (Get-Date -Format s), $code, $dumps.Count,
  ($dumps | Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name |
  Add-Content -Path (Join-Path $dest 'pull.log') -Encoding utf8
exit $code
