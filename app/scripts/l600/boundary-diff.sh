#!/bin/sh
# LIFE-600 C10 — 경계 전후 대조(기준 commit ↔ 작업 트리). app/ 에서(먼저 npm run build): sh scripts/l600/boundary-diff.sh [기준 commit=023087a75]
# ① CSP(index.html) 무변경 ② BrowserWindow 보안 옵션 줄 무변경 ③ CLI 번들에 자격·출처 코드 0 ④ runtime 이 work 를 import 0
# ⑤ renderer·preload 의 외부 통신 호출 수 무변경 ⑥ 의존성(package.json·lock) 무변경. 하나라도 어긋나면 exit 1.
set -u
BASE=${1:-023087a75}
FAIL=0
say() { echo "$1"; }
check() { if [ "$2" = "$3" ]; then say "통과 $1 ($2)"; else say "미달 $1 (기대 $3, 실제 $2)"; FAIL=1; fi; }
check "① CSP index.html diff 줄" "$(git diff "$BASE" -- src/renderer/index.html | wc -l | tr -d ' ')" 0
B=$(git show "$BASE:app/src/main/index.ts" | grep -E 'sandbox|contextIsolation|nodeIntegration|webSecurity|Content-Security-Policy' | sed 's/^ *//' | shasum -a 256 | cut -c1-16)
H=$(grep -E 'sandbox|contextIsolation|nodeIntegration|webSecurity|Content-Security-Policy' src/main/index.ts | sed 's/^ *//' | shasum -a 256 | cut -c1-16)
check "② 보안 옵션 줄 해시(기준=$B)" "$H" "$B"
grep -E 'sandbox|contextIsolation|nodeIntegration|webSecurity' src/main/index.ts | sed 's/^ */    /'
[ -f out/runtime/cli.mjs ] || { say "미달 ③ out/runtime/cli.mjs 없음 — npm run build 먼저"; exit 1; }
check "③ CLI 번들의 자격·출처 지문(life_pat_·assistant-api·safeStorage·work-connections·WorkService)" "$(grep -cE 'life_pat_|assistant-api|safeStorage|work-connections|WorkService' out/runtime/cli.mjs)" 0
check "④ src/runtime 의 work import" "$(grep -rnE "main/work|shared/work" src/runtime | wc -l | tr -d ' ')" 0
BF=$(git grep -cE '\bfetch\(|XMLHttpRequest|new WebSocket|EventSource' "$BASE" -- src/renderer src/preload | awk -F: '{s+=$NF} END {print s+0}')
HF=$(grep -rcE '\bfetch\(|XMLHttpRequest|new WebSocket|EventSource' src/renderer src/preload | awk -F: '{s+=$NF} END {print s+0}')
check "⑤ renderer·preload 외부 통신 호출 수(기준=$BF)" "$HF" "$BF"
check "⑥ package.json·package-lock.json diff 줄" "$(git diff "$BASE" -- package.json package-lock.json | wc -l | tr -d ' ')" 0
exit $FAIL
