#!/bin/sh
# LIFE-567 최종 관문 C4 한 회차 — 새 개발 인스턴스(l567 세션)에서 셸 pane 을 열어 c4.mjs 를 돌리고 끈다.
# 사용: sh scripts/l567/c4-round.sh <ROOT=/tmp/l567n-*> <out 사본> <원자료 폴더> <이름>   (app/ 에서)
set -eu
ROOT=$1; OUTSRC=$2; OUT=$3; NAME=$4
WT=$(cd .. && pwd -P)
sh scripts/l567/dev-up.sh "$ROOT" "$OUTSRC"
echo "$(date +%FT%T) $NAME app=$(cat "$ROOT/app.pid") backend=$(cat "$ROOT/backend.pid")" >> /tmp/l567n-pids.txt
trap 'sh scripts/l567/dev-down.sh "$ROOT"' EXIT
node scripts/l567/c4.mjs "$ROOT/ctl.sock" "$WT" "$OUT" "$NAME"
