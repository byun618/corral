#!/bin/bash
# LIFE-496 fix5 R5-01 — 격리 t2 교대 실행기(재사용용). fix4 원자료 `raw/claude/fix4/t2-attribution/run.sh` 는 그 회차의 기록이라 고치지 않고,
# 그것을 바탕으로 여기 새로 둔다. 다른 점: **앞 회차가 미정리면 다음 회차로 가지 않는다** — iso-t4.mjs 가 70(정리 뒤 잔존)으로 끝났거나
# iso-run.json 을 남기지 않았으면(정리·기록을 확인할 수 없음) 원장에 그 행을 적고 멈춘다(fix4 head-1 고아가 baseline-2~4 동안 살아 있었다).
# 사용: OUT=<raw 폴더> BASE_APP=<기준 app> HEAD_APP=<HEAD app> [RUNS="1 2 3"] [PORT_BASE=9670] [WORK_PREFIX=/tmp/l496iA] [ISO=<iso 스크립트 — 멈춤 경로 검사용 대역>] bash iso-alternate.sh
# 종료코드: 0 = 모든 회차가 정리됨(드라이버 실패는 원장에만) · 70 = 미정리 회차에서 멈춤 · 72 = 회차 raw 폴더가 이미 있어 실행 전 거절
set -u
export PATH=$HOME/.nvm/versions/node/v24.14.1/bin:$PATH TMPDIR=/tmp
HERE=$(cd "$(dirname "$0")" && pwd)
: "${OUT:?OUT 필요}" "${BASE_APP:?BASE_APP 필요}" "${HEAD_APP:?HEAD_APP 필요}"
RUNS=${RUNS:-1 2 3 4 5}
PORT_BASE=${PORT_BASE:-9670}
WORK_PREFIX=${WORK_PREFIX:-/tmp/l496iA}
ISO=${ISO:-$HERE/iso-t4.mjs}
case "$WORK_PREFIX" in /tmp/l496i*) ;; *) echo "WORK_PREFIX 는 /tmp/l496i*" >&2; exit 2 ;; esac
mkdir -p "$OUT"
LEDGER=$OUT/runs.tsv
[ -f "$LEDGER" ] || printf 'run\tside\tapp\tdriver\twork\tport\texit\tstart\tend\traw\tclean\n' > "$LEDGER"
for i in $RUNS; do
  for side in baseline head; do
    if [ "$side" = baseline ]; then app=$BASE_APP; driver=t2-orig; port=$((PORT_BASE + i * 2)); else app=$HEAD_APP; driver=t2; port=$((PORT_BASE + i * 2 + 1)); fi
    id=$side-$i; work=$WORK_PREFIX$i${side:0:1}; raw=$OUT/$id
    # fix6 R6-02 — 회차 raw 폴더는 새로 만든다. 이미 있으면(같은 OUT 재사용) 거절하고 멈춘다: 이전 회차의 iso-run.json 이 이번 기록 누락을
    # 통과시키지 않게, 그리고 기존 원자료를 지우거나 덮지 않게. 이 회차는 실행하지 않는다.
    if ! mkdir "$raw" 2>/dev/null; then
      echo "REFUSE $id — raw 폴더가 이미 있다($raw). 기존 원자료를 덮지 않고 멈춘다" | tee -a "$OUT/stopped.txt"
      exit 72
    fi
    start=$(date +%FT%T)
    node "$ISO" --app "$app" --work "$work" --port "$port" --out "$raw" --driver "$driver" > "$raw/console.log" 2>&1
    code=$?
    if [ -f "$raw/iso-run.json" ]; then clean=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).clean)' "$raw/iso-run.json"); else clean=missing; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$side" "$app" "$driver" "$work" "$port" "$code" "$start" "$(date +%FT%T)" "$raw" "$clean" >> "$LEDGER"
    if [ "$code" -eq 70 ] || [ "$clean" != true ]; then
      echo "STOP $id exit=$code clean=$clean — 앞 회차 미정리, 다음 회차로 가지 않는다" | tee -a "$OUT/stopped.txt"
      exit 70
    fi
  done
done
echo "ALLDONE $RUNS" >> "$OUT/runs.done"
