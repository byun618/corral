#!/bin/sh
# LIFE-603 R1-H ① — 격리 프로필 종료. app/ 에서: sh scripts/l603/down.sh <ROOT=/tmp/l603g-*> [herdr]
#   그 ROOT 의 앱만 SIGTERM → 남은 helper KILL. herdr 면 made.txt 에 적힌 herdr PID 와 그 이름 세션만 멈춘다(사용자 세션 무접촉).
# 실패 전파: 30초 안에 안 죽으면 KILL 하고 exit 6 — 「정상 종료」 로 읽지 않는다. 남은 프로세스가 있으면 exit 7.
set -u
ROOT=${1:-}
case "$ROOT" in /tmp/l603g-*) ;; *) echo "ROOT 는 /tmp/l603g-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
RC=0
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); do
  kill -TERM "$p"
  i=0; while kill -0 "$p" 2>/dev/null; do i=$((i+1)); [ $i -gt 600 ] && { echo "30초 넘음 — KILL $p"; kill -KILL "$p"; RC=6; break; }; sleep 0.05; done
  echo "stop_app pid=$p"
done
sleep 0.5
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "leftover helper $p — KILL"; kill -KILL "$p" 2>/dev/null; done
if [ "${2:-}" = herdr ]; then
  HP=$(sed -n 's/^pid herdr //p' "$ROOT/made.txt" 2>/dev/null | tail -1)
  [ -n "$HP" ] && kill -TERM "$HP" 2>/dev/null
  sleep 1
  SESSION="l603g-$(basename "$ROOT" | sed 's/^l603g-//')"
  for p in $(pgrep -f -- "--session $SESSION "); do echo "stop session $p"; kill -TERM "$p"; done
fi
LEFT=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')
echo "app_left=$LEFT"
[ -n "$LEFT" ] && RC=7
exit $RC
