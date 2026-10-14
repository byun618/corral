#!/bin/sh
# LIFE-590 격리 회차 한 번 — 새 fixture → 띄움(g-up) → 명령 → 내림(g-down term herdr) → 남은 프로세스 확인. 명령의 종료 코드를 돌려준다.
# 사용(app/ 에서): sh scripts/l591/iso.sh <ROOT=/tmp/l591g-*> <FAKE=/tmp/l591g-f*> <명령...>   (명령 안의 {ROOT}·{FAKE} 를 바꿔 넣는다)
set -u
ROOT=$1; FAKE=$2; shift 2
case "$ROOT" in /tmp/l591g-*) ;; *) echo "ROOT 는 /tmp/l591g-*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "ROOT 가 이미 있다 — 회차마다 새 ROOT"; exit 2; }
node scripts/l591/fixture.mjs /tmp/l591g-t/repo > /dev/null || exit 3
sh scripts/l577/g-up.sh "$ROOT" "$FAKE" | tail -1
CMD=$(printf '%s ' "$@" | sed "s#{ROOT}#$ROOT#g; s#{FAKE}#$FAKE#g")
echo "# cmd: $CMD"
sh -c "$CMD"
rc=$?
sh scripts/l577/g-down.sh "$ROOT" term herdr | tail -2
sleep 1
left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" || true)
echo "# leftover_app_pids=[$left] exit=$rc"
[ -n "$left" ] && pkill -KILL -f -- "--user-data-dir=$ROOT/ud"
exit $rc
