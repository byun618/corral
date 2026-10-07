#!/bin/zsh
# LIFE-507 G5 — 실행 한 번 = runs.md 한 행. 명령 출력(stdout+stderr)은 원자료 파일로, 종료코드는 행에 그대로.
# 사용: run.sh <실행 id> <기준 항목> <기대 종료코드> <원자료 상대경로(raw/claude/ 아래)> -- <명령...>
set -u
ID=$1; CRIT=$2; WANT=$3; RAW=$4; shift 4
[ "$1" = "--" ] && shift
TOP=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
DIR="$TOP/specs/LIFE-507-tab-bundle/raw/claude"
OUT="$DIR/$RAW"
mkdir -p "$(dirname "$OUT")"
RUNS="$DIR/runs.md"
if [ ! -f "$RUNS" ]; then
  printf '# LIFE-507 명시 실행 목록 (G5)\n\n실행 한 번 = 한 행. 행은 `app/scripts/l507/run.sh` 가 명령이 끝난 직후 덧붙인다(종료코드는 명령의 것 그대로). 수정 라운드를 넘겨 누적한다.\n\n| 실행 id | 기준 항목 | 명령 | 기대 종료코드 | 실제 종료코드 | 원자료 경로 | 통과/실패 |\n| --- | --- | --- | --- | --- | --- | --- |\n' > "$RUNS"
fi
{ echo "# $ID $(date '+%Y-%m-%d %H:%M:%S') — $*"; } > "$OUT"
"$@" >> "$OUT" 2>&1
CODE=$?
echo "# exit $CODE $(date '+%H:%M:%S')" >> "$OUT"
[ "$CODE" = "$WANT" ] && VERDICT=통과 || VERDICT=실패
CMD=$(printf '%s ' "$@" | sed 's/|/\\|/g' | cut -c1-220)
echo "| $ID | $CRIT | \`$CMD\` | $WANT | $CODE | raw/claude/$RAW | $VERDICT |" >> "$RUNS"
echo "[$ID] exit $CODE ($VERDICT) → raw/claude/$RAW"
exit $CODE
