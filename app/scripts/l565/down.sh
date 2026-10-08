#!/bin/sh
# LIFE-565 최종 관문 — 이 회차가 띄운 것만 멈추고 남은 것을 확인한다. app/ 에서: sh scripts/l565/down.sh <원자료 폴더>
set -u
OUT=$1; ROOT=/tmp/l565n; SESSION=l565-native
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL "$1"; break; }; sleep 0.2; done; }
echo "# 앱"; for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "stop app $p"; stop "$p"; done
echo "# 관측 서버"; stop "$(cat "$ROOT/http.pid" 2>/dev/null)"
echo "# 세션 서버 $SESSION"; HP=$(cat "$ROOT/herdr.pid" 2>/dev/null)
if [ -n "$HP" ] && ps -o command= -p "$HP" 2>/dev/null | grep -qF -- "--session $SESSION server"; then stop "$HP"; fi
for p in $(pgrep -f -- "--session $SESSION server"); do echo "stop leftover session $p"; stop "$p"; done
sleep 1
cp "$ROOT/corral.ndjson" "$OUT/corral.ndjson" 2>/dev/null; sed -i '' "s#$HOME#~#g" "$OUT/corral.ndjson" 2>/dev/null
cp "$ROOT/http.ndjson" "$OUT/http.ndjson" 2>/dev/null
cp "$ROOT/electron.log" "$OUT/electron.log" 2>/dev/null; sed -i '' "s#$HOME#~#g" "$OUT/electron.log" 2>/dev/null
echo "# 남은 것 (기대: 없음)"
LEFT=$(pgrep -fl -- "$ROOT/"; pgrep -fl -- "--session $SESSION"; pgrep -fl -- "observe-server.mjs")
echo "leftover=${LEFT:-none}"
echo "orphans(PPID 1, 이 회차 표지):"; ps -Ao pid,ppid,etime,command | awk '$2==1' | grep -E "l565|$SESSION" | grep -v grep || echo none
echo "herdr_dev_default_server(읽기만, 이 회차 전과 같은 PID 여야):"; ps -axo pid=,lstart=,command= | grep -F "$GUARD server" | grep -v -- '--session' | grep -v grep | sed "s#$HOME#~#g"
echo "life417_native_pids=$(pgrep -f -- '--session life417-native server' | tr '\n' ' ')"
echo "session_dir_left=$(ls -d "$SDIR" 2>/dev/null | sed "s#$HOME#~#g")"
