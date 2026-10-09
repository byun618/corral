#!/bin/sh
# LIFE-576 — 개발 앱만 띄운다(herdr 이름 세션은 up.sh 가 띄운 것 그대로). 재시작 회차(K2ⓑ·K4ⓓ)는 app-down.sh → app-up.sh.
set -u
OUT=$1; ROOT=/tmp/l576n; SESSION=l576-native
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
[ -S "$SOCK" ] || { echo "herdr 이름 세션 소켓 없음 — up.sh 먼저"; exit 1; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "앱이 이미 떠 있다"; exit 3; }
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
LAUNCH='exec "$L576_EL" "$L576_APP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L576_CDP"'
date +%s000 > "$ROOT/app.started"
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  L576_EL="$EL" L576_APP="$APP" L576_CDP="$CDP" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID cdp_port=$CDP launch=$N at=$(date '+%T')"
echo "앱 env 바인딩:"; ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^(CORRAL_[A-Z_]+|HOME|SHELL)=' | sed "s#$HOME#~#g"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+|CORRAL_REGISTRY|CORRAL_UI_PREFS|CORRAL_RUNTIME_SOCKET)=' && { echo "✘ 새면 안 되는 env 가 있다 — 멈춘다"; exit 4; }
echo "env 오염 검사 통과(CLAUDE_CODE_*·CLAUDECODE·HERDR_*·CORRAL_REGISTRY·CORRAL_UI_PREFS·CORRAL_RUNTIME_SOCKET 없음)"
i=0; until [ -S "$ROOT/ud/runtime/rpc.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "격리 rpc 소켓 안 뜸"; break; }; sleep 0.2; done
echo "isolated_rpc_sock=$(ls "$ROOT/ud/runtime/rpc.sock" 2>&1)"
