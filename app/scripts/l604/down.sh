#!/bin/sh
# LIFE-604 R1-G ① (l603/down.sh 를 옮김) — 격리 프로필 종료. app/ 에서: sh scripts/l603/down.sh <ROOT=/tmp/l604g-*> [herdr]
#   그 ROOT 의 앱만 SIGTERM → 남은 helper KILL. herdr 면 made.txt 에 적힌 herdr PID 와 그 이름 세션만 멈춘다(사용자 세션 무접촉).
# 실패 전파: 30초 안에 안 죽으면 KILL 하고 exit 6 — 「정상 종료」 로 읽지 않는다. 남은 프로세스가 있으면 exit 7.
set -u
ROOT=${1:-}
case "$ROOT" in /tmp/l604g-*) ;; *) echo "ROOT 는 /tmp/l604g-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
RC=0
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); do
  kill -TERM "$p"
  i=0; while kill -0 "$p" 2>/dev/null; do i=$((i+1)); [ $i -gt 600 ] && { echo "30초 넘음 — KILL $p"; kill -KILL "$p"; RC=6; break; }; sleep 0.05; done
  echo "stop_app pid=$p"
done
SPID=$(cat "$ROOT/serve.pid" 2>/dev/null || true)
# K1b R5-C: serve.pid 의 PID 가 이 ROOT 의 `corral.mjs serve` 인지 명령줄·env 로 확인하고서만 멈춘다(재사용된 PID 를 죽이지 않는다).
if [ -n "$SPID" ] && kill -0 "$SPID" 2>/dev/null; then
  SCMD=$(ps eww -o command= -p "$SPID" 2>/dev/null || true)
  case "$SCMD" in *"/cli/corral.mjs serve"*"CORRAL_USER_DATA=$ROOT/ud"*) ;; *) echo "serve.pid $SPID 는 이 ROOT 의 serve 가 아니다 — 멈추지 않는다"; SPID=""; RC=7 ;; esac
fi
if [ -n "$SPID" ] && kill -0 "$SPID" 2>/dev/null; then
  kill -TERM "$SPID"
  i=0; while kill -0 "$SPID" 2>/dev/null; do i=$((i+1)); [ $i -gt 600 ] && { echo "30초 넘음 — KILL $SPID"; kill -KILL "$SPID"; RC=6; break; }; sleep 0.05; done
  echo "stop_serve pid=$SPID"
fi
rm -f "$ROOT/serve.pid"
sleep 0.5
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "leftover helper $p — KILL"; kill -KILL "$p" 2>/dev/null; done
if [ "${2:-}" = herdr ]; then
  HP=$(sed -n 's/^pid herdr //p' "$ROOT/made.txt" 2>/dev/null | tail -1)
  [ -n "$HP" ] && kill -TERM "$HP" 2>/dev/null
  sleep 1
  SESSION="l604g-$(basename "$ROOT" | sed 's/^l604g-//')"
  for p in $(pgrep -f -- "--session $SESSION "); do echo "stop session $p"; kill -TERM "$p"; done
fi
LEFT=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')
echo "app_left=$LEFT"
[ -n "$LEFT" ] && RC=7
exit $RC
