#!/bin/sh
# LIFE-591 E7ⓑ 무회귀 — LIFE-590 시험(mixed-tabs·f1-regress·viewer-check·e1b-worktree)을 l591 격리 루트로 옮긴 사본의 회차 한 번. fixture = 590 fixture 를 /tmp/l591g-u/repo 에.
# 사용(app/ 에서): sh scripts/l591/r590/iso.sh <ROOT=/tmp/l591g-*> <FAKE=/tmp/l591g-f*> <명령...>
set -u
ROOT=$1; FAKE=$2; shift 2
case "$ROOT" in /tmp/l591g-*) ;; *) echo "ROOT 는 /tmp/l591g-*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "ROOT 가 이미 있다 — 회차마다 새 ROOT"; exit 2; }
node scripts/l591/r590/fixture.mjs /tmp/l591g-u/repo > /dev/null || exit 3
# shellcheck disable=SC2046
sh scripts/l577/g-up.sh "$ROOT" "$FAKE" $(printf '%s' "${ISO_ENV:-}" | sed "s#{ROOT}#$ROOT#g") | tail -1
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
