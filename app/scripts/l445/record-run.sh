#!/bin/sh
# LIFE-445 실행 원장 한 행 — 명령을 돌리고 종료코드·원자료 경로를 runs.md 에 덧붙인다(validation.md H8ⓑ — 실패 회차도 남긴다).
# 사용: sh record-run.sh <실행id> <기준항목> <기대종료코드> <원자료 폴더(레포 상대)> -- <명령...>
# 출력 전체는 <원자료 폴더>/<실행id>.log. 통과/실패 = 실제 종료코드 == 기대 종료코드.
set -u
ID=$1; ITEM=$2; EXPECT=$3; RAWD=$4; shift 4; [ "$1" = "--" ] && shift
TOP=$(git rev-parse --show-toplevel)
LEDGER="$TOP/specs/LIFE-445-worktree-refresh/raw/claude/runs.md"
mkdir -p "$TOP/$RAWD"
LOG="$RAWD/$ID.log"
START=$(date '+%F %T')
{ echo "# $ID · $ITEM · $START · $(uptime) · yes=$(pgrep -x yes | wc -l | tr -d ' ')"; echo "\$ $*"; } > "$TOP/$LOG"
"$@" >> "$TOP/$LOG" 2>&1
CODE=$?
echo "# exit=$CODE · $(date '+%F %T') · $(uptime)" >> "$TOP/$LOG"
[ "$CODE" = "$EXPECT" ] && VERDICT=통과 || VERDICT=실패
CMD=$(echo "$*" | sed "s#$TOP/##g; s#|#\\\\|#g")
echo "| $ID | $ITEM | \`$CMD\` | $EXPECT | $CODE | \`$LOG\` | $VERDICT |" >> "$LEDGER"
echo "$ID exit=$CODE ($VERDICT) → $LOG"
