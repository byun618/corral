#!/bin/sh
# LIFE-636 격리 회차 정리 — iso-up.sh 가 띄운 Electron(과 --herdr 면 herdr 서버)을 끄고 남은 PID 를 센다. app/ 에서:
#   sh scripts/l636/iso-down.sh <root> [--herdr]
set -u
ROOT=${1:?root}
case "$ROOT" in /tmp/l636f*) ;; *) echo "root 는 /tmp/l636f* 만"; exit 2 ;; esac
for pid in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do kill "$pid" 2>/dev/null; done
i=0; while pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "--user-data-dir=$ROOT/ud"; break; }; sleep 0.2; done
if [ "${2:-}" = "--herdr" ] && [ -f "$ROOT/herdr.pid" ]; then
  kill "$(cat "$ROOT/herdr.pid")" 2>/dev/null
  i=0; while kill -0 "$(cat "$ROOT/herdr.pid")" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -9 "$(cat "$ROOT/herdr.pid")"; break; }; sleep 0.2; done
  pgrep -f -- "$ROOT/xdg" >/dev/null && pkill -f -- "$ROOT/xdg"
fi
echo "remaining_app_pids=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | wc -l | tr -d ' ')"
[ "${2:-}" = "--herdr" ] && echo "remaining_herdr_pids=$( { [ -f "$ROOT/herdr.pid" ] && kill -0 "$(cat "$ROOT/herdr.pid")" 2>/dev/null && echo 1; } | wc -l | tr -d ' ')"
echo "input_raw_lines=$(cat "$ROOT/corral.ndjson" 2>/dev/null | grep -c '"input.raw"')"
