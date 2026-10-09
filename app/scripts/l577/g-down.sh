#!/bin/sh
# LIFE-577 최종 관문 — 격리 개발 앱 종료. app/ 에서: sh scripts/l577/g-down.sh <ROOT> [term|kill|herdr]
#   term(기본) = SIGTERM → Electron 이 app.quit 경로(before-quit — 메뉴 ⌘Q 의 role quit 과 같은 경로)로 끝난다. 끝날 때까지 걸린 ms 를 찍는다.
#   kill = SIGKILL(비정상 종료 — before-quit 없음). herdr = 앱 종료 뒤 그 ROOT 의 herdr 이름 세션도 멈춘다(회차 끝 정리).
set -u
ROOT=$1; MODE=${2:-term}
stop_app() {
  for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); do
    t0=$(node -e 'console.log(Date.now())')
    if [ "$MODE" = kill ]; then kill -KILL "$p"; else kill -TERM "$p"; fi
    i=0; while kill -0 "$p" 2>/dev/null; do i=$((i+1)); [ $i -gt 300 ] && { echo "30초 넘음 — KILL $p"; kill -KILL "$p"; break; }; sleep 0.05; done
    echo "stop_app pid=$p mode=$MODE exit_ms=$(( $(node -e 'console.log(Date.now())') - t0 ))"
  done
  sleep 0.5
  for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "leftover helper $p — KILL"; kill -KILL "$p" 2>/dev/null; done
}
stop_app
if [ "$MODE" = herdr ] || [ "${3:-}" = herdr ]; then
  HP=$(cat "$ROOT/herdr.pid" 2>/dev/null)
  [ -n "$HP" ] && kill -TERM "$HP" 2>/dev/null
  sleep 1
  SESSION="l577g-$(basename "$ROOT" | sed 's/^l577g-//')"
  for p in $(pgrep -f -- "--session $SESSION "); do echo "stop session $p"; kill -TERM "$p"; done
fi
echo "app_left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')"
