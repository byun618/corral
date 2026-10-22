#!/bin/sh
# LIFE-690 f2 — 빌드 전환. Electron 만 PID 로 끄고(herdr l690 서버는 살린다 — pane·Claude Code 가 이어진다) app/out 을 <out 사본> 으로 바꾼 뒤 같은 userData 로 다시 띄운다.
# f1 의 렌더러 location.reload() 는 main 의 will-navigate 가드가 막았다(f1 final/corral.ndjson 652 window.navigate.denied) — 그래서 재기동이다.
# 앞 구간의 격리 로그는 <ROOT>/corral.<이름>.ndjson·electron.<이름>.log 로 옮겨 둔다(새 실행이 같은 경로에 쓴다).
# 사용: sh scripts/l690/app-restart.sh <ROOT> <out 사본> <앞 구간 이름>   (app/ 에서). 종료코드 0 = 새 실행 ctl 소켓이 섰다, 2 = 전제 어긋남.
set -u
ROOT=$1; OUTSRC=$2; PREV=$3
case "$ROOT" in /tmp/l690-*) ;; *) echo "ROOT 는 /tmp/l690-*"; exit 2 ;; esac
APP=$(pwd -P); GUARD=$(cat "$ROOT/guard.path"); A=$(cat "$ROOT/app.pid"); B=$(cat "$ROOT/backend.pid")
ps -o command= -p "$A" 2>/dev/null | grep -qF -- "--user-data-dir=$ROOT/ud" || { echo "app pid $A 가 이 ROOT 의 Electron 이 아니다"; exit 2; }
stop() { kill "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 75 ] && { kill -9 "$1"; break; }; sleep 0.2; done; }
stop "$A"
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do stop "$p"; done
sleep 0.5
left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')
[ -z "$left" ] || { echo "Electron 잔존 $left"; exit 2; }
echo "Electron $A 종료"
ps -o command= -p "$B" 2>/dev/null | grep -qF -- "--session l690 server" || { echo "herdr l690 서버(pid $B)가 같이 내려갔다"; exit 2; }
"$GUARD" session list 2>/dev/null | awk '$1=="l690"{print $2}' | grep -q running || { echo "herdr l690 세션이 running 이 아니다"; exit 2; }
echo "herdr l690 서버 pid $B 살아 있음"
mv "$ROOT/corral.ndjson" "$ROOT/corral.$PREV.ndjson"; mv "$ROOT/electron.log" "$ROOT/electron.$PREV.log"
rm -rf "$APP/out" && cp -R "$OUTSRC" "$APP/out" && echo "out ← $OUTSRC ($(cat "$OUTSRC/.l690-build" 2>/dev/null))"
sh "$(dirname "$0")/app-launch.sh" "$ROOT" || exit 2
