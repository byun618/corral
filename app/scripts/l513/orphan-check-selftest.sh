#!/bin/sh
# LIFE-513 fix2 R2-02 — orphan-check.sh 종료코드 판별력. 가짜 ps·pgrep·lsof(orphan-fake-bin/)를 PATH 앞에 두고 한 경우를 돌린다:
#   none(고아 없음 → orphan-check exit 0) · electron(이 빌드 Electron PPID1 → exit 1) · cwd(fixture 를 cwd 로 둔 provider → exit 1)
# 실제 종료코드와 출력을 찍고, 기대와 다르면 이 스크립트가 exit 1. 사용: sh orphan-check-selftest.sh <none|electron|cwd>
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CASE=${1:-}
FX=/tmp/l513fake-fixture
APP=/tmp/l513fake-app
case "$CASE" in none) want=0 ;; electron|cwd) want=1 ;; *) echo "사용: sh orphan-check-selftest.sh <none|electron|cwd>" >&2; exit 2 ;; esac
out=$(L513_FAKE=$CASE L513_FAKE_APP=$APP L513_FAKE_FX=$FX PATH="$HERE/orphan-fake-bin:$PATH" sh "$HERE/orphan-check.sh" "$FX" "$APP" 2>&1)
got=$?
echo "case=$CASE want=$want got=$got"
echo "--- orphan-check 출력"
echo "$out"
[ "$got" = "$want" ]
