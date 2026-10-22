#!/usr/bin/env bash
# LIFE-672 R1ⓑ — 실제 경합: 임시 레포에서 optional lock 을 켠 채 `git status` 를 계속 돌리는 동안 release-ff.sh 를 N번(기본 20) 돌린다.
# app/scripts/l672/r1b-contend.sh <원자료 폴더> [N]
# status 루프 = 본체에서 본 두 인자 형태(탐색기 `-c core.quotePath=false status --porcelain=v2 -z --untracked-files=all --ignored=matching`,
#   세션 `status --porcelain=v2 --branch`)를 번갈아, 매번 앞에서 추적 파일 하나를 touch 해 index 를 stat-dirty 로 둔다(status 가 index 를 다시 쓰게).
# 회차 준비 = main 을 origin/main 의 1커밋 뒤로 `reset --hard`(루프와 경합하므로 재시도 래퍼). 준비 실패 회차도 분모에 남기고 따로 표시한다.
# 양성 대조 = lockprobe.py(10ms, 쥔 프로세스 조회 없음)가 같은 창에서 lock 나타남을 센다.
# 임시 폴더 /tmp/l672r1b.XXXXXX — 본체 checkout 무접촉.
set -uo pipefail
OUT="${1:?원자료 폴더}"; N="${2:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FF="$ROOT/scripts/release-ff.sh"; PROBE="$ROOT/app/scripts/l672/lockprobe.py"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
W="$(mktemp -d /tmp/l672r1b.XXXXXX)" || exit 1
LOOP=""; OBS=""
cleanup() {
  [ -n "$LOOP" ] && kill "$LOOP" 2>/dev/null && wait "$LOOP" 2>/dev/null
  [ -n "$OBS" ] && kill "$OBS" 2>/dev/null && wait "$OBS" 2>/dev/null
  rm -rf "$W"
}
trap cleanup EXIT
g() { git -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@"; }
NF=${R1B_FILES:-3000}
g init -q --bare -b main "$W/origin.git"
g clone -q "$W/origin.git" "$W/seed" 2>/dev/null
for i in $(seq 1 $NF); do echo "f$i" > "$W/seed/f$i.txt"; done
g -C "$W/seed" add -A && g -C "$W/seed" commit -qm base && g -C "$W/seed" push -q origin main
g -C "$W/seed" commit -q --allow-empty -m next && g -C "$W/seed" push -q origin main
g clone -q "$W/origin.git" "$W/b"
B="$W/b"; LOCK="$B/.git/index.lock"
echo "# r1b-contend $(date '+%F %T') · git $(git --version | cut -d' ' -f3) · work $W · 추적 파일 $NF · release-ff.sh sha1 $(shasum "$FF" | cut -c1-12) · N $N" | tee "$OUT/summary.txt"
uptime | tee -a "$OUT/summary.txt"

# status 루프 (optional lock 켬 — GIT_OPTIONAL_LOCKS 를 지운다)
(
  unset GIT_OPTIONAL_LOCKS
  i=0; n=0
  while :; do
    i=$(( (i % NF) + 1 )); touch "$B/f$i.txt"
    git -C "$B" -c core.quotePath=false status --porcelain=v2 -z --untracked-files=all --ignored=matching > /dev/null 2>&1
    i=$(( (i % NF) + 1 )); touch "$B/f$i.txt"
    git -C "$B" status --porcelain=v2 --branch > /dev/null 2>&1
    n=$((n + 2)); [ $((n % 50)) = 0 ] && echo "$n" > "$W/loop-count"
  done
) &
LOOP=$!
python3 "$PROBE" --lock "$LOCK" --out "$OUT/probe" --seconds 3600 --interval 0.01 --no-owner --no-ps > /dev/null 2>&1 &
OBS=$!
echo "status 루프 pid $LOOP · 관측기 pid $OBS · lock $LOCK" | tee -a "$OUT/summary.txt" "$OUT/helper-pids.txt"
sleep 2

now() { python3 -c 'import time; print(round(time.time(), 3))'; }
printf 'run\t준비 시도\t준비\t시작\t끝\t초\t종료코드\t대기 경로\tHEAD=origin\t창 안 lock 나타남\t문구\n' > "$OUT/runs.tsv"
for r in $(seq 1 "$N"); do
  tries=0; prep=실패
  while [ $tries -lt 40 ]; do
    tries=$((tries + 1))
    if g -C "$B" reset -q --hard origin/main~1 > "$OUT/prep-$r.txt" 2>&1 && [ "$(git -C "$B" rev-parse HEAD)" = "$(git -C "$B" rev-parse origin/main~1)" ]; then prep=ok; break; fi
    sleep 0.1
  done
  if [ "$prep" != ok ]; then
    printf '%s\t%s\t준비 실패\t-\t-\t-\t-\t-\t-\t-\t%s\n' "$r" "$tries" "$(head -1 "$OUT/prep-$r.txt")" >> "$OUT/runs.tsv"
    echo "run $r 준비 실패($tries 회)" | tee -a "$OUT/summary.txt"; continue
  fi
  t0="$(now)"
  "$FF" --repo "$B" --base main > "$OUT/run-$r.txt" 2>&1; rc=$?
  t1="$(now)"
  waited=아니오; grep -qE 'index\.lock 대기|잡혀 있다' "$OUT/run-$r.txt" && waited=예
  same=아니오; [ "$(git -C "$B" rev-parse HEAD)" = "$(git -C "$B" rev-parse origin/main)" ] && same=예
  seen="$(python3 -c "
import json,sys
n=0
for l in open('$OUT/probe/appearances.ndjson'):
    t=json.loads(l).get('t')
    if t is not None and $t0 <= t <= $t1: n+=1
print(n)")"
  printf '%s\t%s\tok\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$r" "$tries" "$t0" "$t1" "$(python3 -c "print(round($t1-$t0,2))")" "$rc" "$waited" "$same" "$seen" \
    "$(grep -v '^$' "$OUT/run-$r.txt" | tr '\t\n' '  ' | cut -c1-240)" >> "$OUT/runs.tsv"
  echo "run $r 준비 ${tries}회 · exit $rc · 대기 $waited · HEAD=origin $same · 창 안 lock $seen" | tee -a "$OUT/summary.txt"
done
kill "$OBS" 2>/dev/null; wait "$OBS" 2>/dev/null; OBS=""
kill "$LOOP" 2>/dev/null; wait "$LOOP" 2>/dev/null; LOOP=""
cat "$OUT/probe/summary.txt" >> "$OUT/summary.txt"
inwin=$(awk -F'\t' 'NR>1 && $10 ~ /^[0-9]+$/ {s+=$10} END {print s+0}' "$OUT/runs.tsv")
total=$(wc -l < "$OUT/probe/appearances.ndjson" | tr -d ' ')
echo "lock 나타남: 전체 $total · ff 창 안(release-ff 자신의 merge 포함) $inwin · 창 밖(status 루프만) $((total - inwin))" | tee -a "$OUT/summary.txt"
ok=$(awk -F'\t' 'NR>1 && $7=="0" && $9=="예"' "$OUT/runs.tsv" | wc -l | tr -d ' ')
prepfail=$(awk -F'\t' 'NR>1 && $3=="준비 실패"' "$OUT/runs.tsv" | wc -l | tr -d ' ')
waitn=$(awk -F'\t' 'NR>1 && $8=="예"' "$OUT/runs.tsv" | wc -l | tr -d ' ')
echo "결과: ff 성공(exit 0·HEAD=origin) $ok/$N · 준비 실패 $prepfail · 대기 경로 탄 회차 $waitn · status 루프 실행 약 $(cat "$W/loop-count" 2>/dev/null || echo ?)회" | tee -a "$OUT/summary.txt"
uptime | tee -a "$OUT/summary.txt"
[ "$ok" = "$N" ]
