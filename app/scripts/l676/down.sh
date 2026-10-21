#!/bin/sh
# LIFE-676 (637 하네스 복사·개작) 최종 관문 격리 회차 정리 — up.sh 가 띄운 Electron·herdr 를 끄고, 남은 PID·고아를 센다. app/ 에서: sh scripts/l676/down.sh <ROOT>
set -u
ROOT=${1:?root}
case "$ROOT" in /tmp/l676f-*) ;; *) echo "ROOT 는 /tmp/l676f-*"; exit 2 ;; esac
for pid in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do kill "$pid" 2>/dev/null; done
i=0; while pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "--user-data-dir=$ROOT/ud"; break; }; sleep 0.2; done
if [ -f "$ROOT/herdr.pid" ]; then
  HP=$(cat "$ROOT/herdr.pid")
  # herdr 서버의 자손(pane 셸·yes·sleep)을 먼저 기록한다
  ps -axo pid=,ppid=,command= | awk -v r="$HP" '{p[$1]=$2; c[$1]=$0} END {for (x in p) {y=x; while (y in p && y!=1 && y!=0) {if (p[y]==r) {print c[x]; break}; y=p[y]}}}' > "$ROOT/herdr-descendants-before-down.txt"
  kill "$HP" 2>/dev/null
  i=0; while kill -0 "$HP" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -9 "$HP"; break; }; sleep 0.2; done
fi
sleep 1
echo "remaining_app_pids=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | wc -l | tr -d ' ')"
echo "remaining_herdr=$( { [ -f "$ROOT/herdr.pid" ] && kill -0 "$(cat "$ROOT/herdr.pid")" 2>/dev/null && echo 1; } | wc -l | tr -d ' ')"
SESSION="l676f-$(basename "$ROOT" | sed 's/^l676f-//')"
echo "remaining_session_procs=$(pgrep -f -- "--session $SESSION" | wc -l | tr -d ' ')"
# 이 회차 표식(L676M)을 단 부하 프로세스와 PPID 1 고아
echo "orphans_l676m=$(ps -axo pid=,ppid=,command= | grep -c '[L]676M')"
echo "ppid1_top_l=$(ps -axo pid=,ppid=,command= | awk '$2==1 && $3 ~ /top$/ && $4=="-l"' | wc -l | tr -d ' ')"
echo "ppid1_yes_sleep=$(ps -axo pid=,ppid=,command= | awk '$2==1 && ($3=="yes" || $3=="sleep")' | wc -l | tr -d ' ')"
