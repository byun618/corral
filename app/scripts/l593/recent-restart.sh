#!/bin/sh
# LIFE-593 — R1-C-09 재시작 회차(fixture → g-up → open → g-down term → seed → g-up → restored → g-down term herdr → 남은 프로세스). 수정 r1 A08 의 명령을 묶었다.
# 사용(app/ 에서): sh scripts/l593/recent-restart.sh <ROOT=/tmp/l593g-*> <FAKE=/tmp/l593g-f*> <OUT 접두사>   (OUT 접두사-open.json·-seed.json·-restored.json)
set -u
R=$1; F=$2; OUT=$3
case "$R" in /tmp/l593g-*) ;; *) echo "ROOT 는 /tmp/l593g-*"; exit 2 ;; esac
[ -e "$R" ] && { echo "ROOT 가 이미 있다"; exit 2; }
mkdir -p "$R" && node scripts/l593/fixture.mjs "$R/repo" > /dev/null || exit 3
sh scripts/l577/g-up.sh "$R" "$F" L577_KEEP_PAINTING=1 | tail -1; echo "# app_pid=$(cat "$R/app.pid")"
node scripts/l593/recent-restart.mjs open "$R" "$OUT-open.json"; a=$?; echo "open_exit=$a"
sh scripts/l577/g-down.sh "$R" term | tail -2
node scripts/l593/recent-restart.mjs seed "$R" "$OUT-seed.json"; b=$?; echo "seed_exit=$b"
sh scripts/l577/g-up.sh "$R" "$F" L577_KEEP_PAINTING=1 | tail -1; echo "# app_pid=$(cat "$R/app.pid")"
node scripts/l593/recent-restart.mjs restored "$R" "$OUT-restored.json"; c=$?; echo "restored_exit=$c"
sh scripts/l577/g-down.sh "$R" term herdr | tail -2
sleep 1
echo "# leftover_app_pids=[$(pgrep -f -- "--user-data-dir=$R/ud" | tr '\n' ' ')] orphan_ppid1=[$(ps -axo pid=,ppid=,command= | awk -v r="$R" '$2==1 && index($0, r)>0 {print $1}' | tr '\n' ' ')]"
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ]
