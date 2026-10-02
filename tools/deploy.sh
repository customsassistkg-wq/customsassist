#!/bin/bash
# bash tools/deploy.sh <коммит> <метка> <файл>...   — выкладка файлов коммита на сервер по server/CHECKER.md.
#   DEPLOY_DRY=1     только проверки (стадия, SHA256, синтаксис, живые файлы = основа) — ничего не меняет на сервере
#   DEPLOY_BASE=<к>  коммит, который сейчас выложен (по умолчанию — родитель выкладываемого); нужен, когда между выкладками
#                    были коммиты, не менявшие эти файлы, или выкладывается несколько коммитов сразу
#   DEPLOY_KEY, DEPLOY_HOST, DEPLOY_SITE — ключ ssh, root@адрес и https-адрес сайта (по умолчанию — боевые)
# Порядок: архив из git → стадия на сервере → SHA256 и синтаксис там же → живые файлы = основа? → копия прежних
# в /root/deploy_backups/<время>_<метка>/ → картинки и server/* через *.new и mv → перезапуск tnved (если затронут server/)
# → публичные страницы последними → SHA256 снаружи. nginx.conf этим скриптом не ставится (docs/backend-ops.md).
# Написан 02.10.2026 из рабочего скрипта дня (шесть выкладок подряд); до этого лежал во временной папке и пропал бы с ней.
set -euo pipefail
[ $# -ge 3 ] || { sed -n 2,12p "$0"; exit 2; }
COMMIT=$1; LABEL=$2; shift 2; FILES=("$@")
KEY=${DEPLOY_KEY:-$HOME/.ssh/id_ed25519_claude_vps}; HOST=${DEPLOY_HOST:-root@65.109.170.170}; SITE=${DEPLOY_SITE:-https://customsassist.trade}
DRY=${DEPLOY_DRY:-}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -i $KEY $HOST"
TS=$(date -u +%Y%m%d_%H%M%S); STAGE=/root/deploy_stage_$TS; BACKUP=/root/deploy_backups/${TS}_$LABEL
cd "$(cd "$(dirname "$0")/.." && pwd)"
git rev-parse --verify -q "$COMMIT^{commit}" >/dev/null || { echo "нет такого коммита: $COMMIT"; exit 2; }
for f in "${FILES[@]}"; do
  [ "$f" != server/nginx.conf ] || { echo "nginx.conf — вручную (docs/backend-ops.md)"; exit 1; }
  git cat-file -e "$COMMIT:$f" 2>/dev/null || { echo "в коммите $COMMIT нет файла $f"; exit 2; }
done
git archive --format=tar "$COMMIT" -- "${FILES[@]}" | gzip -n > /tmp/deploy-$TS.tgz
for f in "${FILES[@]}"; do printf '%s  %s\n' "$(git show "$COMMIT:$f" | sha256sum | cut -d' ' -f1)" "$f"; done > /tmp/deploy-$TS.sha256
BASE=${DEPLOY_BASE:-$(git rev-parse "$COMMIT~1")}
# живые файлы до выкладки — те, что в основе (иначе на сервере есть невыложенное и затирать его нельзя)
for f in "${FILES[@]}"; do printf '%s  %s\n' "$(git show "$BASE:$f" 2>/dev/null | sha256sum | cut -d' ' -f1)" "$f"; done > /tmp/deploy-$TS.parent
scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$KEY" /tmp/deploy-$TS.tgz /tmp/deploy-$TS.sha256 /tmp/deploy-$TS.parent "$HOST:/root/"
$SSH "bash -s" <<REMOTE
set -euo pipefail
mkdir -m 700 $STAGE && cd $STAGE && tar xzf /root/deploy-$TS.tgz
sha256sum -c --quiet /root/deploy-$TS.sha256 && echo "  стадия = коммит (SHA256)"
for f in \$(awk '{print \$2}' /root/deploy-$TS.sha256); do
  case \$f in *.js) node --check \$f ;; *.html) node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");for(const m of s.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g))if(!/src=/.test(m[1]))new (require("vm").Script)(m[2]);' \$f ;; esac
done; echo "  синтаксис на сервере — ok"
bad=0; while read -r h f; do cur=\$(sha256sum /opt/tnved/\$f 2>/dev/null | cut -d' ' -f1 || true); if [ -e /opt/tnved/\$f ] && [ "\$cur" != "\$h" ]; then echo "  НА СЕРВЕРЕ НЕ ОСНОВА: \$f"; bad=1; fi; done < /root/deploy-$TS.parent
[ \$bad = 0 ] || { echo "  остановлено: живые файлы не равны основе (DEPLOY_BASE?)"; rm -rf $STAGE /root/deploy-$TS.*; exit 1; }
echo "  живые файлы = основа"
if [ -n "$DRY" ]; then rm -rf $STAGE /root/deploy-$TS.*; echo "  DEPLOY_DRY — на сервере ничего не изменено"; exit 0; fi
mkdir -p -m 700 $BACKUP
for f in \$(awk '{print \$2}' /root/deploy-$TS.sha256); do if [ -e /opt/tnved/\$f ]; then mkdir -p $BACKUP/\$(dirname \$f); cp -a /opt/tnved/\$f $BACKUP/\$f; else echo \$f >> $BACKUP/NEW_FILES; fi; done
echo "  копия прежних: $BACKUP"
put() { install -D -m 644 -o tnved -g tnved $STAGE/\$1 /opt/tnved/\$1.new; [ "\$(sha256sum < /opt/tnved/\$1.new)" = "\$(sha256sum < $STAGE/\$1)" ] || { echo "SHA \$1"; exit 1; }; mv /opt/tnved/\$1.new /opt/tnved/\$1; echo "  на месте \$1"; }
files=\$(awk '{print \$2}' /root/deploy-$TS.sha256)
for f in \$files; do case \$f in tnved_checker.html|privacy.html|terms.html|terms-next.html) ;; *) put \$f ;; esac; done
if echo "\$files" | grep -q '^server/'; then
  systemctl restart tnved; for i in \$(seq 1 60); do ss -ltn | grep -q '127.0.0.1:3000' && break; sleep 0.25; done
  ss -ltn | grep -q '127.0.0.1:3000' && echo "  tnved слушает" || { echo "  TNVED НЕ ПОДНЯЛСЯ"; exit 1; }
  sleep 4; journalctl -u tnved --since '-15s' --no-pager -o cat | grep -v -E 'listening|Started|Stopping|Stopped|Deactivated|Consumed' | tail -5 | sed 's/^/  журнал: /' || true
  curl -sS -m 5 http://127.0.0.1:3000/api/health | sed 's/^/  health: /'; echo
fi
for f in \$files; do case \$f in tnved_checker.html|privacy.html|terms.html|terms-next.html) put \$f ;; esac; done
rm -rf $STAGE /root/deploy-$TS.*
REMOTE
if [ -z "$DRY" ]; then
  echo "  снаружи:"
  for f in "${FILES[@]}"; do case $f in tnved_checker.html) u=/ ;; privacy.html|terms.html|terms-next.html|assets/*) u=/$f ;; *) continue ;; esac
    a=$(curl -sS -m 20 --compressed "$SITE$u" | sha256sum | cut -c1-16); b=$(grep " $f\$" /tmp/deploy-$TS.sha256 | cut -c1-16)
    [ "$a" = "$b" ] && echo "    $u = коммит ($a)" || echo "    $u НЕ РАВНО коммиту ($a ≠ $b)"; done
  echo "  копия прежних: $BACKUP"
fi
rm -f /tmp/deploy-$TS.tgz /tmp/deploy-$TS.sha256 /tmp/deploy-$TS.parent
