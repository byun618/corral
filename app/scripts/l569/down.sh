#!/bin/sh
# LIFE-569 — 이 회차가 띄운 것만 멈춘다. app/ 에서: sh scripts/l569/down.sh <원자료 폴더>
# 앱(--user-data-dir=/tmp/l569n/ud) · 격리 XDG(/tmp/l569n/xdg) env 토큰을 가진 herdr 서버만. 설치본·다른 서버 무접촉(읽기만).
set -u
OUT=$1; ROOT=/tmp/l569n; XDG=$ROOT/xdg
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL "$1"; break; }; sleep 0.2; done; }
ours() { for p in $(pgrep -f -- 'herdr'); do ps eww -o command= -p "$p" 2>/dev/null | tr ' ' '\n' | grep -qx "XDG_CONFIG_HOME=$XDG" && echo "$p"; done; }
echo "# 앱"; for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "stop app $p"; stop "$p"; done
sleep 1
echo "# 격리 herdr (env 토큰 XDG_CONFIG_HOME=$XDG)"
for p in $(ours); do echo "server $p: $(ps -o command= -p "$p" | sed "s#$HOME#~#g")"; stop "$p"; done
sleep 1
mkdir -p "$OUT"
for f in corral.ndjson electron.log; do cp "$ROOT/$f" "$OUT/$f" 2>/dev/null && sed -i '' "s#$HOME#~#g" "$OUT/$f"; done
echo "# 남은 것 (기대: 없음)"
LEFT=$(pgrep -fl -- "$ROOT/"; ours)
echo "leftover=${LEFT:-none}"
echo "orphans(PPID 1, 이 회차 표지):"; ps -Ao pid,ppid,etime,command | awk '$2==1' | grep -E "l569n" | grep -v grep || echo none
echo "무접촉 서버(읽기만):"; ps -axo pid=,etime=,command= | grep -E 'herdr( --session [^ ]+)? server' | grep -v grep | sed "s#$HOME#~#g"
