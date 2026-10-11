#!/bin/sh
# LIFE-567 C1·C2 한 회차 — 새 개발 인스턴스(l567 세션)를 띄워 실제 `claude` 를 열고, 입력 줄에 ASCII 채움 400자를 **제출 없이** 넣어
# 입력 상자를 여러 줄로 감은 뒤(꽉 찬 줄 = 커서 아래 행 수 + 2 이상 → xterm reflowSmaller 가 ybase 를 올리는 조건) 창 폭을 40px 줄인다.
# c1.mjs 가 상태·조합 상자 행·커서 행을 재고, 끝에 인스턴스를 끈다(Claude 세션은 제출 없이 닫힌다). 회차마다 새 인스턴스라 상태가 이어지지 않는다.
# 사용: sh scripts/l567/c1-round.sh <ROOT=/tmp/l567n-*> <out 사본> <원자료 폴더> <회차 이름>   (app/ 에서)
set -eu
ROOT=$1; OUTSRC=$2; OUT=$3; NAME=$4
WT=$(cd .. && pwd -P)
sh scripts/l567/dev-up.sh "$ROOT" "$OUTSRC"
echo "$(date +%FT%T) $NAME app=$(cat "$ROOT/app.pid") backend=$(cat "$ROOT/backend.pid")" >> /tmp/l567n-pids.txt
trap 'sh scripts/l567/dev-down.sh "$ROOT"' EXIT
node scripts/l566/open-claude.mjs "$ROOT/ctl.sock" "$WT"
sleep 2
node scripts/l566/ctl.mjs "$ROOT/ctl.sock" "{\"cmd\":\"type\",\"text\":\"$(printf 'x%.0s' $(seq 400))\"}" > /dev/null
sleep 2
node scripts/l567/c1.mjs "$ROOT/ctl.sock" "$OUT" "$NAME" 40
# 입력 줄 비우기(제출 금지) — Ctrl+U 두 번
node scripts/l566/ctl.mjs "$ROOT/ctl.sock" '{"cmd":"key","keyCode":"U","modifiers":["control"]}' > /dev/null
node scripts/l566/ctl.mjs "$ROOT/ctl.sock" '{"cmd":"key","keyCode":"U","modifiers":["control"]}' > /dev/null
