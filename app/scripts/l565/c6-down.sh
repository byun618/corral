#!/bin/sh
# LIFE-565 C6 최종 관문 — 이 회차가 띄운 것만 멈춘다. app/ 에서: sh scripts/l565/c6-down.sh <원자료 폴더> <app|server|all>
#   app: 개발 앱만. server: 격리 루트(/tmp/l565c6/xdg)의 herdr 서버(이름 세션 l565-c6·default) 만. all: 앱·서버·관측 서버 + 남은 것 확인.
# guard 의 `herdr server` 는 주인 미상 default(24475)와 명령행이 같다 — 명령행으로 고르지 않고, env 에 XDG_CONFIG_HOME=/tmp/l565c6/xdg 토큰이 있는 PID 만 고른다.
set -u
OUT=$1; WHAT=$2; ROOT=/tmp/l565c6; XDG=$ROOT/xdg
H="sh $(pwd -P)/scripts/l565/c6-h.sh"
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL "$1"; break; }; sleep 0.2; done; }
ours() { for p in $(pgrep -f -- 'herdr-0.9.0/target/debug/herdr'); do ps eww -o command= -p "$p" 2>/dev/null | tr ' ' '\n' | grep -qx "XDG_CONFIG_HOME=$XDG" && echo "$p"; done; }
if [ "$WHAT" = app ] || [ "$WHAT" = all ]; then
  echo "# 앱"; for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "stop app $p"; stop "$p"; done
fi
if [ "$WHAT" = server ] || [ "$WHAT" = all ]; then
  echo "# 격리 루트 서버 (env 토큰 XDG_CONFIG_HOME=$XDG)"
  for p in $(ours); do echo "server $p: $(ps -o command= -p "$p" | sed "s#$HOME#~#g")"; done
  $H --session l565-c6 server stop 2>&1 | head -3
  $H server stop 2>&1 | head -3
  sleep 1
  for p in $(ours); do echo "stop leftover $p"; stop "$p"; done
fi
if [ "$WHAT" = all ]; then
  echo "# 관측 서버"; stop "$(cat "$ROOT/http.pid" 2>/dev/null)"
  sleep 1
  for f in corral.ndjson electron.log; do cp "$ROOT/$f" "$OUT/$f" 2>/dev/null && sed -i '' "s#$HOME#~#g" "$OUT/$f"; done
  cp "$ROOT/http.ndjson" "$OUT/http.ndjson" 2>/dev/null
  echo "# 남은 것 (기대: 없음)"
  LEFT=$(pgrep -fl -- "$ROOT/"; ours)
  echo "leftover=${LEFT:-none}"
  echo "orphans(PPID 1, 이 회차 표지):"; ps -Ao pid,ppid,etime,command | awk '$2==1' | grep -E "l565c6|$(ours | tr '\n' '|')^$" | grep -v grep || echo none
fi
echo "무접촉 서버(읽기만, 전과 같은 PID 여야):"; ps -axo pid=,etime=,command= | grep -E 'herdr( --session [^ ]+)? server|observe-server' | grep -v grep | sed "s#$HOME#~#g"
