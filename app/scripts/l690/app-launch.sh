#!/bin/sh
# LIFE-690 f2 — 격리 개발 실행(Electron)을 띄운다. dev-up.sh 가 처음 한 번, app-restart.sh 가 빌드 전환 때 한 번 부른다(같은 userData·같은 herdr l690 서버).
# 사용: sh scripts/l690/app-launch.sh <ROOT=/tmp/l690-*>   (app/ 에서, dev-up.sh 가 남긴 <ROOT>/backend.sock·guard.path 를 읽는다)
set -eu
ROOT=$1
case "$ROOT" in /tmp/l690-*) ;; *) echo "ROOT 는 /tmp/l690-*"; exit 2 ;; esac
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
SOCK=$(cat "$ROOT/backend.sock"); GUARD=$(cat "$ROOT/guard.path"); SESSION=l690
[ -S "$SOCK" ] || { echo "herdr 소켓 없음 $SOCK"; exit 2; }
# 워커 세션 env 를 물려받지 않게 뺀다(dev-up.sh 와 같은 규칙).
UNSETS=$(env | sed -nE 's/^(CLAUDE_CODE_[A-Za-z0-9_]*|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|ORCA_AGENT_HOOK_[A-Za-z0-9_]*)=.*/-u \1/p' | tr '\n' ' ')
rm -f "$ROOT/ctl.sock"
# shellcheck disable=SC2086
env $UNSETS HOME="$HOME" CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$GUARD" \
  nohup "$EL" "$APP" --user-data-dir="$ROOT/ud" > "$ROOT/electron.log" 2>&1 &
echo $! > "$ROOT/app.pid"; echo "$APP" > "$ROOT/app.dir"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "ctl 안 뜸"; exit 1; }; sleep 0.2; done
echo "app pid $(cat "$ROOT/app.pid") ctl $ROOT/ctl.sock out $(cat "$APP/out/.l690-build" 2>/dev/null)"
