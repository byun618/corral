#!/bin/sh
# LIFE-636 최종 관문 격리 회차 — 빌드 산출물(app/out)의 제품 main 을 **숨긴 창**으로 띄우고 CDP 포트를 연다. app/ 에서:
#   sh scripts/l636/iso-up.sh <root> [KEY=VALUE …]     (예: CODEX_HOME=/tmp/l636f/empty-codex)
# userData·설정·UI prefs·로그·제어 소켓은 <root> 아래(사용자 userData·설치본 무접촉). herdr 는 이 회차 전용 세션 l636f 를
# `XDG_CONFIG_HOME=<root>/xdg` 로 띄운다(사용자 herdr 세션 무접촉) — 이미 떠 있으면 그대로 쓴다. tailscale 은 없는 경로.
# 창은 래퍼 진입점 hide-window.cjs 가 show·focus 를 막고 제품 main 을 import 한다. PID·포트는 <root>/app.pid·cdp.port.
set -u
ROOT=${1:?root}; shift
case "$ROOT" in /tmp/l636f*) ;; *) echo "root 는 /tmp/l636f* 만"; exit 2 ;; esac
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
HERDR=/tmp/l636f-herdr/herdr-0.9.0/target/release/herdr
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
SESSION=l636f
[ -x "$HERDR" ] || { echo "herdr 없음: $HERDR"; exit 2; }
[ -f "$APP/out/main/index.js" ] || { echo "app/out 없음 — 빌드 먼저"; exit 2; }
DEV=$(ps -axo pid=,command= | grep -F "$APP/node_modules/electron/dist" | grep -v -- '--type=' | grep -v grep)
[ -n "$DEV" ] && { echo "이 worktree 의 개발 GUI 가 이미 떠 있다 — 멈춘다: $DEV"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/xdg" "$ROOT/shots"; chmod 700 "$ROOT" "$ROOT/ud"
if ! { [ -f "$ROOT/herdr.pid" ] && kill -0 "$(cat "$ROOT/herdr.pid")" 2>/dev/null; }; then
  sh "$APP/scripts/l470/clean.sh" XDG_CONFIG_HOME="$ROOT/xdg" -- "nohup '$HERDR' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
fi
i=0; SOCK=""
until [ -n "$SOCK" ]; do SOCK=$(find "$ROOT/xdg" -name herdr.sock -type s 2>/dev/null | head -1); i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 소켓 안 뜸"; exit 1; }; sleep 0.2; done
echo "herdr_pid=$(cat "$ROOT/herdr.pid") sock=$SOCK"
# 래퍼 앱 — 이름·버전은 제품 package.json 그대로(userData 는 CORRAL_USER_DATA 로 따로 고정)
mkdir -p "$ROOT/wrap"; cp "$APP/scripts/l636/hide-window.cjs" "$ROOT/wrap/main.cjs"
"$NODE" -e "const p=require('$APP/package.json');require('fs').writeFileSync('$ROOT/wrap/package.json',JSON.stringify({name:p.name,productName:p.productName,version:p.version,main:'main.cjs'}))"
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
LAUNCH='exec "$L636_EL" "$L636_WRAP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L636_CDP"'
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$HERDR" XDG_CONFIG_HOME="$ROOT/xdg" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_SETTINGS="$ROOT/ud/settings.json" CORRAL_UI_PREFS="$ROOT/ud/ui-prefs.json" CORRAL_REGISTRY="$ROOT/ud/repos.json" \
  CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" CORRAL_TAILSCALE_BIN=/nonexistent \
  L636_MAIN="$APP/out/main/index.js" L636_WRAP="$ROOT/wrap" L636_EL="$EL" L636_APP="$APP" L636_CDP="$CDP" "$@" -- "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 200 ] && { echo "제어 소켓 안 뜸"; tail -5 "$ROOT/electron.log"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1)
echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID cdp_port=$CDP"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ env 오염 — 멈춘다"; exit 4; }
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^(CORRAL_[A-Z_]+|CODEX_HOME|GROK_HOME|CLAUDE_CONFIG_DIR|L636_[A-Z]+)=' | sed "s#$HOME#~#g"
echo "up ok"
