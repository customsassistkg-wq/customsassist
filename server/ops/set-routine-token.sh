#!/bin/bash
# Customs Assist KG: настройка рутины разбора находок, шаги владельца на сервере.
# Показывает владельцу (только в его терминале) строки для окружения рутины на claude.ai,
# затем принимает токен API-триггера, пишет его в .env и перезапускает API.
# Запуск: ssh -t root@<VPS> /root/set-routine-token.sh
set -euo pipefail
ENV=/opt/tnved/server/.env
grep -q '^ROUTINE_FIRE_URL=https://api.anthropic.com/' "$ENV" || { echo "В .env нет ROUTINE_FIRE_URL. Ничего не изменено."; exit 1; }
SECRET="$(grep '^OPS_REPORT_SECRET=' "$ENV" | cut -d= -f2- || true)"
[ -n "$SECRET" ] || { echo "В .env нет OPS_REPORT_SECRET. Ничего не изменено."; exit 1; }
cat <<EOF

1) Environment variables окружения рутины — вставьте две строки:

OPS_REPORT_URL=https://customsassist.trade/api/ops/report
OPS_REPORT_SECRET=$SECRET

2) Network access: Custom, «Also include default list of common package managers» — да.
   Allowed domains:

cbd.minjust.gov.kg
gov.kg
www.gov.kg
customs.gov.kg
www.customs.gov.kg
docs.eaeunion.org
eec.eaeunion.org
nsi.eaeunion.org
remedies.eaeunion.org
kenesh.kg
sti.gov.kg
vet.gov.kg
customsassist.trade

3) Select a trigger → Add another trigger → API → Generate token → Save.

EOF
read -rsp "Вставьте токен рутины (sk-ant-..., на экране не виден) и нажмите Enter: " TOK; echo
TOK="$(printf '%s' "$TOK" | tr -d '[:space:]')"
# Вставленного в терминале не видно, и токен легко вставить дважды (так и вышло 29.09.2026:
# 216 знаков вместо 108, рутина ответила бы 401). Две одинаковые половины — это один токен.
HALF="${TOK:0:$(( ${#TOK} / 2 ))}"
[ -n "$HALF" ] && [ "$HALF$HALF" = "$TOK" ] && TOK="$HALF"
printf '%s' "$TOK" | grep -Eq '^sk-ant-[A-Za-z0-9_-]{40,200}$' && ! printf '%s' "$TOK" | grep -q 'sk-ant-.*sk-ant-' \
  || { echo "Это не похоже на токен рутины (одна строка sk-ant-… без пробелов). Ничего не изменено — запустите скрипт ещё раз."; exit 1; }
cp -p "$ENV" /root/env.before-token   # прежний .env — на случай ошибки, только root
TMP="$(mktemp "$ENV.XXXXXX")"
grep -av '^ROUTINE_TOKEN=' "$ENV" > "$TMP" || true
printf 'ROUTINE_TOKEN=%s\n' "$TOK" >> "$TMP"
chown --reference="$ENV" "$TMP"; chmod --reference="$ENV" "$TMP"
mv "$TMP" "$ENV"
systemctl restart tnved
for i in $(seq 1 15); do ss -ltn | grep -q 127.0.0.1:3000 && break; sleep 1; done
echo "Готово: токен ${TOK:0:20}...${TOK: -4} записан (${#TOK} знаков), tnved $(systemctl is-active tnved)."
echo "На claude.ai у триггера рутины показано то же начало и те же четыре знака в конце. Напишите боту «статус»."
