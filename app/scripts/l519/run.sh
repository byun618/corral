#!/bin/sh
# LIFE-519 명시 실행 목록 기록기 — 명령 1회를 돌리고 원자료(머리: HEAD·node·TMPDIR) + runs.md 한 행을 남긴다.
# 사용: sh run.sh <실행id> <기준항목> <기대종료코드> <원자료 상대경로(raw/claude 기준)> -- <명령...>
# 통과/실패 = 실제 종료코드가 기대와 같은가. 판정 내용(출력 대조)은 명령 쪽이 종료코드로 낸다.
set -u
ID=$1; ITEM=$2; WANT=$3; OUT=$4; shift 5
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
RAW="$REPO/specs/LIFE-519-socket-chmod/raw/claude"
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=${TMPDIR:-/tmp/l519t}
mkdir -p "$TMPDIR" "$(dirname "$RAW/$OUT")"
{ echo "# run $ID ($ITEM) $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "# HEAD $(git -C "$REPO" rev-parse HEAD) dirty=$(git -C "$REPO" status --porcelain -- app/src | wc -l | tr -d ' ')"
  echo "# node $(node --version) TMPDIR=$TMPDIR ${CORRAL_ELECTRON:+ELECTRON=$CORRAL_ELECTRON}"; echo "# cmd $*"; } > "$RAW/$OUT"
"$@" >> "$RAW/$OUT" 2>&1; CODE=$?
echo "# exit $CODE" >> "$RAW/$OUT"
[ "$CODE" = "$WANT" ] && R=통과 || R=실패
[ -f "$RAW/runs.md" ] || printf '# LIFE-519 명시 실행 목록 (구현 워커 claude)\n\n| 실행 id | 기준 항목 | 명령 | 기대 종료코드 | 실제 종료코드 | 원자료 | 통과/실패 |\n| --- | --- | --- | --- | --- | --- | --- |\n' > "$RAW/runs.md"
printf '| %s | %s | `%s` | %s | %s | %s | %s |\n' "$ID" "$ITEM" "$(echo "$*" | sed 's/|/\\|/g' | cut -c1-160)" "$WANT" "$CODE" "$OUT" "$R" >> "$RAW/runs.md"
echo "$ID $ITEM exit=$CODE want=$WANT → $R"
