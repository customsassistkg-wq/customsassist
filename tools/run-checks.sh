#!/bin/bash
# bash tools/run-checks.sh [каталог-журналов]   — весь список проверок из CLAUDE.md («Verification: mandatory after any code change»):
# синтаксис больших файлов и серверных скриптов, tools/base-sweep.js, затем тесты по одному. Список тестов читается из самого
# CLAUDE.md (строки «node server/tests/…test.js»), поэтому новый тест достаточно вписать туда; assistant-browser добавлен всегда.
# Печатает по строке на проверку: код выхода, секунды, число PASS и SKIP. Код выхода скрипта: 0 — всё прошло и ничего не пропущено,
# 1 — что-то упало или браузерный тест пропущен (SKIP = нет среды: docs/testing.md), 2 — нет node.
# Не запускает: reset-password.test.js без TEST_DATABASE_URL (нужна одноразовая база) и платный server/tests/assistant-eval.js.
# Среда: если есть /tmp/pw/env.sh (Node и Playwright на машине разработки, см. docs/testing.md) — подключается; PW_ENV меняет путь.
# Написан 02.10.2026 из рабочего скрипта дня; до этого список был зашит во временный файл.
set -u
cd "$(cd "$(dirname "$0")/.." && pwd)"
ENVF=${PW_ENV:-/tmp/pw/env.sh}
[ -f "$ENVF" ] && . "$ENVF"
command -v node >/dev/null 2>&1 || { echo "node не найден (docs/testing.md)"; exit 2; }
OUT=${1:-/tmp/ca-checks}; mkdir -p "$OUT"
bad=0
for f in server/private/base.js server/private/checker.js server/private/dash.js $(git ls-files 'server/src/*.js' 'server/scripts/*.js'); do
  node --check "$f" 2>"$OUT/syntax.log" || { echo "SYNTAX FAIL $f"; cat "$OUT/syntax.log"; bad=1; }
done
echo "syntax $([ $bad = 0 ] && echo ok || echo FAIL)"
node tools/base-sweep.js > "$OUT/base-sweep.log" 2>&1; rc=$?
echo "base-sweep rc=$rc $(tail -1 "$OUT/base-sweep.log")"; [ $rc = 0 ] || bad=1
tests=$(grep -oE 'node server/tests/[A-Za-z0-9-]+\.test\.js' CLAUDE.md | sed -E 's#node server/tests/(.*)\.test\.js#\1#' | awk '!s[$0]++')
case " $tests " in *" assistant-browser "*) ;; *) tests="$tests assistant-browser" ;; esac
[ -n "${TEST_DATABASE_URL:-}" ] && tests="$tests reset-password"
cd server
n=0; skipped=0
for t in $tests; do
  s=$(date +%s); timeout 600 node "tests/$t.test.js" > "$OUT/$t.log" 2>&1; rc=$?
  p=$(grep -c '^PASS' "$OUT/$t.log"); k=$(grep -c '^SKIP' "$OUT/$t.log")
  echo "$t rc=$rc $(( $(date +%s)-s ))s PASS=$p SKIP=$k"
  n=$((n+1)); [ $rc = 0 ] || bad=1; [ "$k" = 0 ] || { skipped=$((skipped+1)); bad=1; }
done
echo "ИТОГ: тестов $n, пропущено (SKIP) $skipped, $([ $bad = 0 ] && echo 'всё прошло' || echo 'ЕСТЬ ПАДЕНИЯ ИЛИ ПРОПУСКИ — журналы в '"$OUT")"
[ -n "${TEST_DATABASE_URL:-}" ] || echo "не запускались: reset-password (нужна TEST_DATABASE_URL), assistant-eval (платный)"
exit $bad
