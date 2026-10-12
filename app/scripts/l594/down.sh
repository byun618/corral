#!/bin/sh
# LIFE-594 K2 — 이 회차가 띄운 것만 멈추고 남은 것을 확인한다. app/ 에서: sh scripts/l594/down.sh <원자료 폴더>
set -u
OUT=$1; ROOT=/tmp/l594e; SESSION=l594-k2; SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL "$1"; break; }; sleep 0.2; done; }
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "stop app $p"; stop "$p"; done
HP=$(cat "$ROOT/herdr.pid" 2>/dev/null)
if [ -n "$HP" ] && ps -o command= -p "$HP" 2>/dev/null | grep -qF -- "--session $SESSION server"; then echo "stop herdr $HP"; stop "$HP"; fi
for p in $(pgrep -f -- "--session $SESSION server"); do echo "stop leftover session $p"; stop "$p"; done
sleep 1
mkdir -p "$OUT"; cp "$ROOT/electron.log" "$OUT/electron.log" 2>/dev/null; sed -i '' "s#$HOME#~#g" "$OUT/electron.log" 2>/dev/null
LEFT=$(pgrep -fl -- "$ROOT/"; pgrep -fl -- "--session $SESSION")
echo "leftover=${LEFT:-none}"
echo "orphans:"; ps -Ao pid,ppid,command | awk '$2==1' | grep -E "l594e|$SESSION" | grep -v grep || echo none
rm -rf "$SDIR" && echo "removed session dir"
echo "session_dir_left=$(ls -d "$SDIR" 2>/dev/null)"
