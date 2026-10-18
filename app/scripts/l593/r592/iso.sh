#!/bin/sh
# LIFE-592 격리 회차 한 번 — 새 fixture(<ROOT>/repo) → 띄움(g-up) → 명령 → 내림(g-down term herdr) → 남은 프로세스 확인. 명령의 종료 코드를 돌려준다.
# 사용(app/ 에서): sh scripts/l592/iso.sh <ROOT=/tmp/l593g-*> <FAKE=/tmp/l593g-f*> <명령...>   (명령 안의 {ROOT}·{FAKE} 를 바꿔 넣는다)
# ISO_ENV = g-up 에 덧붙일 KEY=VALUE(공백 구분, {ROOT} 치환). 앱 PID 는 <ROOT>/app.pid, 남은 프로세스는 마지막 줄.
set -u
ROOT=$1; FAKE=$2; shift 2
case "$ROOT" in /tmp/l593g-*) ;; *) echo "ROOT 는 /tmp/l593g-*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "ROOT 가 이미 있다 — 회차마다 새 ROOT"; exit 2; }
mkdir -p "$ROOT"
node scripts/l593/r592/fixture.mjs "$ROOT/repo" > /dev/null || exit 3
# shellcheck disable=SC2046
sh scripts/l577/g-up.sh "$ROOT" "$FAKE" L577_KEEP_PAINTING=1 $(printf '%s' "${ISO_ENV:-}" | sed "s#{ROOT}#$ROOT#g") | tail -1
echo "# app_pid=$(cat "$ROOT/app.pid" 2>/dev/null)"
CMD=$(printf '%s ' "$@" | sed "s#{ROOT}#$ROOT#g; s#{FAKE}#$FAKE#g")
echo "# cmd: $CMD"
sh -c "$CMD"
rc=$?
sh scripts/l577/g-down.sh "$ROOT" term herdr | tail -2
sleep 1
left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" || true)
orphans=$(ps -axo pid=,ppid=,command= | awk -v r="$ROOT" '$2==1 && index($0, r)>0 {print $1}' | tr '\n' ' ')
echo "# leftover_app_pids=[$left] orphan_ppid1=[$orphans] exit=$rc"
[ -n "$left" ] && pkill -KILL -f -- "--user-data-dir=$ROOT/ud"
exit $rc
