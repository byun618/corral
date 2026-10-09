#!/bin/sh
# LIFE-565 최종 관문 — 네이티브 개발 실행 기동. app/ 에서: sh scripts/l565/up.sh <원자료 폴더>
# 실제 HOME·로그인 셸·실제 claude·실제 기본 브라우저. userData·제어 소켓·로그만 /tmp/l565n 아래.
# 바인딩 세션(코디 지시 msg_4860c088c77a): 주인 미상의 herdr-dev default 서버에는 붙지도 멈추지도 않는다(ps 만) —
# 이 회차 전용 이름 세션 l565-native 를 레포 guard herdr 로 직접 띄우고 CORRAL_SESSION+CORRAL_BACKEND_SOCKET 으로 바인딩한다.
# 브라우저 쪽 관측용 localhost HTTP 서버(접속 로그)도 띄운다. PID 는 $ROOT/pids 에.
set -u
OUT=$1; ROOT=/tmp/l565n; SESSION=l565-native
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"; SOCK="$SDIR/herdr.sock"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
mkdir -p "$OUT"
echo "# ⓪ 전제 $(date '+%F %T')"
DEV=$(ps -axo pid=,command= | grep -E 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep)
echo "dev_gui_before=${DEV:-none}" | sed "s#$HOME#~#g"
# 코디 지시 msg(병렬 B): 다른 worktree 의 개발 GUI(566 등)는 읽기만 하고 병렬 진행. 이 worktree 의 것이 떠 있으면 멈춘다.
echo "$DEV" | grep -qF "$APP/node_modules/electron" && { echo "이 worktree 의 개발 GUI 가 이미 떠 있다 — 멈춘다"; exit 3; }
echo "herdr_dev_default_server(읽기만):"; ps -axo pid=,ppid=,lstart=,command= | grep -F "$GUARD server" | grep -v -- '--session' | grep -v grep | sed "s#$HOME#~#g"
echo "life417_native_pids=$(pgrep -f -- '--session life417-native server' | tr '\n' ' ')"
{ [ -e "$ROOT" ] || [ -e "$SDIR" ]; } && { echo "$ROOT 또는 $SDIR 이미 있음 — 멈춘다"; exit 2; }
mkdir -p "$ROOT/ud" "$ROOT/shots"; chmod 700 "$ROOT" "$ROOT/ud"
echo "guard=$GUARD sha=$(shasum -a 256 "$GUARD" | cut -c1-64)" | sed "s#$HOME#~#g"
echo "# ① 이름 세션 서버 $SESSION (로그인 셸·실제 HOME)"
# 깨끗한 로그인 셸(l470/clean.sh = env -i + HOME·USER·PATH) — 1회차는 이 워커(Claude Code)의 CLAUDE_CODE_*·HERDR_* 가 새어 폐기했다(run1-env-contaminated).
sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
HPID=$(cat "$ROOT/herdr.pid"); ps -o pid=,ppid=,command= -p "$HPID" | sed "s#$HOME#~#g"
echo "session_dir=$SDIR" | sed "s#$HOME#~#g"
echo "# ② localhost 관측 서버"
PORT=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
nohup "$NODE" "$APP/scripts/l565/observe-server.mjs" "$PORT" "$ROOT/http.ndjson" > "$ROOT/http.out" 2>&1 &
echo $! > "$ROOT/http.pid"; echo "$PORT" > "$ROOT/http.port"
i=0; until curl -s "http://127.0.0.1:$PORT/l565-selftest" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { echo "관측 서버 안 뜸"; exit 1; }; sleep 0.2; done
echo "http_port=$PORT http_pid=$(cat "$ROOT/http.pid")"
echo "# ③ 개발 실행 (로그인 셸·실제 HOME, 세션 바인딩)"
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
LAUNCH='exec "$L565_EL" "$L565_APP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L565_CDP"'
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  L565_EL="$EL" L565_APP="$APP" L565_CDP="$CDP" -- "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
echo $! > "$ROOT/app.pid"; echo "app_pid=$(cat "$ROOT/app.pid") cdp_port=$CDP"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 200 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1)
echo "앱 env 바인딩:"; ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^(CORRAL_[A-Z_]+|HOME|SHELL)=' | sed "s#$HOME#~#g"
echo "앱 env 키 전체(값 없이):"; ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^[A-Z_]+=' | cut -d= -f1 | sort | tr '\n' ' '; echo
echo "세션 서버 env 키 전체:"; ps eww -o command= -p "$(cat "$ROOT/herdr.pid")" | tr ' ' '\n' | grep -E '^[A-Z_]+=' | cut -d= -f1 | sort | tr '\n' ' '; echo
ps eww -o command= -p "$APID" "$(cat "$ROOT/herdr.pid")" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ CLAUDE_CODE_*/HERDR_* 가 새었다 — 멈춘다"; exit 4; }
echo "env 오염 검사 통과(CLAUDE_CODE_*·CLAUDECODE·HERDR_* 없음)"
echo "claude=$(/bin/zsh -lc 'command -v claude; claude --version' 2>&1 | tr '\n' ' ')" | sed "s#$HOME#~#g"
echo "up ok"
