#!/bin/sh
# LIFE-693 — (l691/l670/down.sh 사본) 격리 개발 앱 종료. app/ 에서: sh scripts/l693/down.sh <ROOT> [herdr]
#   SIGTERM(app.quit 경로) → 남은 helper KILL. herdr 면 그 ROOT 의 herdr 이름 세션도 멈춘다(회차 끝 정리).
set -u
ROOT=$1
case "$ROOT" in /tmp/l693q-*) ;; *) echo "ROOT 는 /tmp/l693q-*"; exit 2 ;; esac
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); do
  kill -TERM "$p"
  i=0; while kill -0 "$p" 2>/dev/null; do i=$((i+1)); [ $i -gt 300 ] && { echo "30초 넘음 — KILL $p"; kill -KILL "$p"; break; }; sleep 0.05; done
  echo "stop_app pid=$p"
done
sleep 0.5
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "leftover helper $p — KILL"; kill -KILL "$p" 2>/dev/null; done
if [ "${2:-}" = herdr ]; then
  HP=$(cat "$ROOT/herdr.pid" 2>/dev/null)
  [ -n "$HP" ] && kill -TERM "$HP" 2>/dev/null
  sleep 1
  SESSION="l693q-$(basename "$ROOT" | sed 's/^l693q-//')"
  for p in $(pgrep -f -- "--session $SESSION "); do echo "stop session $p"; kill -TERM "$p"; done
fi
echo "app_left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')"
