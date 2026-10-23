#!/bin/sh
# LIFE-573 최종 관문 — 이 회차가 띄운 것만 멈추고 원자료를 옮긴다. app/ 에서: sh scripts/l573/down.sh <base|impl> <원자료 폴더>
# 로그를 옮기기 전에 격리 corral.ndjson 의 input.raw·window-focus 수를 센다(사용자 키 누출 감시).
set -u
BUILD=$1; OUT=$2; ROOT=/tmp/l573n-$BUILD; SESSION=l573-native-$BUILD
SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL "$1"; break; }; sleep 0.2; done; }
echo "# 앱"; for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "stop app $p"; stop "$p"; done
echo "window_down_after $(date '+%F %T')" >> "$OUT/window-times.txt"
echo "# 포커스 완충 루프"; stop "$(cat "$ROOT/refocus.pid" 2>/dev/null)"
echo "# 관측 서버"; stop "$(cat "$ROOT/http.pid" 2>/dev/null)"
echo "# 세션 서버 $SESSION"; HP=$(cat "$ROOT/herdr.pid" 2>/dev/null)
if [ -n "$HP" ] && ps -o command= -p "$HP" 2>/dev/null | grep -qF -- "--session $SESSION server"; then stop "$HP"; fi
for p in $(pgrep -f -- "--session $SESSION server"); do echo "stop leftover session $p"; stop "$p"; done
sleep 1
echo "# 누출 감시 (로그 옮기기 전)"
echo "input.raw=$(grep -c '"input.raw"' "$ROOT/corral.ndjson" 2>/dev/null)"
echo "window-focus=$(grep -c 'window-focus' "$ROOT/corral.ndjson" 2>/dev/null)"
grep -n '"input.raw"\|window-focus' "$ROOT/corral.ndjson" 2>/dev/null | cut -c1-300 | sed "s#$HOME#~#g"
echo "refocus_fired=$(grep -c '^refocus#' "$ROOT/refocus.log" 2>/dev/null)"
cp "$ROOT/corral.ndjson" "$OUT/corral.ndjson" 2>/dev/null; sed -i '' "s#$HOME#~#g" "$OUT/corral.ndjson" 2>/dev/null
cp "$ROOT/http.ndjson" "$OUT/http.ndjson" 2>/dev/null
cp "$ROOT/refocus.log" "$OUT/refocus.log" 2>/dev/null
cp "$ROOT/electron.log" "$OUT/electron.log" 2>/dev/null; sed -i '' "s#$HOME#~#g" "$OUT/electron.log" 2>/dev/null
cp "$ROOT/herdr-server.out" "$OUT/herdr-server.out" 2>/dev/null; sed -i '' "s#$HOME#~#g" "$OUT/herdr-server.out" 2>/dev/null
echo "# 남은 것 (기대: 없음)"
LEFT=$(pgrep -fl -- "$ROOT/"; pgrep -fl -- "--session $SESSION"; pgrep -fl -- "l573/refocus.sh"; pgrep -fl -- "l573/stream.py")
echo "leftover=${LEFT:-none}"
echo "orphans(PPID 1, 이 회차 표지):"; ps -Ao pid,ppid,etime,command | awk '$2==1' | grep -E "l573|$SESSION" | grep -v grep || echo none
echo "session_dir_left=$(ls -d "$SDIR" 2>/dev/null | sed "s#$HOME#~#g")"
