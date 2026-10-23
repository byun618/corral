#!/bin/sh
# LIFE-573 최종 관문 — 네이티브 개발 실행 기동 (l565/up.sh 를 빌드 인자로 일반화).
# 구현 worktree 의 app/ 에서: sh scripts/l573/up.sh <base|impl> <띄울 app 폴더 절대경로> <원자료 폴더>
# 실제 HOME·로그인 셸(l470/clean.sh = env -i)·실제 claude·실제 기본 브라우저. userData·제어 소켓·로그만 /tmp/l573n-<빌드>.
# herdr 는 이 회차 전용 이름 세션 l573-native-<빌드> 를 레포 guard 로 직접 띄워 바인딩한다 — 설치본 corral·그 herdr 무접촉.
# 창을 띄우기 직전 시각·PID 를 남기고, 포커스 완충 루프(refocus.sh)를 먼저 띄운다.
set -u
BUILD=$1; TARGET=$2; OUT=$3; ROOT=/tmp/l573n-$BUILD; SESSION=l573-native-$BUILD
HERE=$(pwd -P); EL="$TARGET/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
KEY=$("$NODE" -e "const fs=require('fs'),c=require('crypto'),d=process.argv[1]+'/backend/';const s=JSON.parse(fs.readFileSync(d+'source.json'));console.log(c.createHash('sha256').update(Buffer.concat(s.patches.map(n=>fs.readFileSync(d+n)))).digest('hex').slice(0,16))" "$TARGET")
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"; SOCK="$SDIR/herdr.sock"
mkdir -p "$OUT"
echo "# ⓪ 전제 $(date '+%F %T') build=$BUILD target=$TARGET head=$(git -C "$TARGET" rev-parse HEAD)" | sed "s#$HOME#~#g"
DEV=$(ps -axo pid=,command= | grep -E 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep | cut -c1-260)
echo "dev_gui_before(읽기만)=${DEV:-none}" | sed "s#$HOME#~#g"
echo "$DEV" | grep -qF -- "--user-data-dir=/tmp/l573n-" && { echo "이 일감의 개발 GUI 가 이미 떠 있다 — 멈춘다"; exit 3; }
echo "무접촉 herdr 서버(읽기만):"; ps -axo pid=,ppid=,etime=,command= | grep -E 'herdr( --session [^ ]+)? server' | grep -v grep | sed "s#$HOME#~#g"
{ [ -e "$ROOT" ] || [ -e "$SDIR" ]; } && { echo "$ROOT 또는 $SDIR 이미 있음 — 멈춘다"; exit 2; }
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 1; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/rows"; chmod 700 "$ROOT" "$ROOT/ud"
echo "guard=$GUARD sha=$(shasum -a 256 "$GUARD" | cut -c1-64)" | sed "s#$HOME#~#g"
echo "# ① 이름 세션 서버 $SESSION (깨끗한 로그인 셸·실제 HOME)"
sh "$HERE/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
ps -o pid=,ppid=,command= -p "$(cat "$ROOT/herdr.pid")" | sed "s#$HOME#~#g"
echo "# ② localhost 관측 서버"
PORT=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
nohup "$NODE" "$HERE/scripts/l565/observe-server.mjs" "$PORT" "$ROOT/http.ndjson" > "$ROOT/http.out" 2>&1 &
echo $! > "$ROOT/http.pid"; echo "$PORT" > "$ROOT/http.port"
i=0; until curl -s "http://127.0.0.1:$PORT/l573-selftest" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { echo "관측 서버 안 뜸"; exit 1; }; sleep 0.2; done
echo "http_port=$PORT http_pid=$(cat "$ROOT/http.pid")"
echo "# ③ 포커스 완충 루프"
nohup sh "$HERE/scripts/l573/refocus.sh" "$TARGET/node_modules/electron/dist/Electron.app" "$ROOT/refocus.log" > "$ROOT/refocus.out" 2>&1 &
echo $! > "$ROOT/refocus.pid"; echo "refocus_pid=$(cat "$ROOT/refocus.pid")"
echo "# ④ 개발 실행"
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
echo "window_up_before $(date '+%F %T')" >> "$OUT/window-times.txt"
# 창이 다른 창에 가려지면 Chromium 이 rAF·렌더를 멈춘다(2회차 실측 renders=0) — 관문 실행 인자로만 끈다(제품 코드 무변경).
EXTRA=${L573_CHROMIUM_FLAGS:-}
LAUNCH='exec "$L573_EL" "$L573_APP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L573_CDP" '"$EXTRA"
sh "$HERE/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  L573_EL="$EL" L573_APP="$TARGET" L573_CDP="$CDP" -- "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
echo $! > "$ROOT/app.pid"; echo "app_launcher_pid=$(cat "$ROOT/app.pid") cdp_port=$CDP chromium_flags=${EXTRA:-none}"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 200 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1); echo "$APID" > "$ROOT/electron.pid"
echo "electron_main_pid=$APID"
echo "앱 env 바인딩:"; ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^(CORRAL_[A-Z_]+|HOME|SHELL)=' | sed "s#$HOME#~#g"
echo "앱 env 키 전체(값 없이):"; ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^[A-Z_]+=' | cut -d= -f1 | sort | tr '\n' ' '; echo
ps eww -o command= -p "$APID" "$(cat "$ROOT/herdr.pid")" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ CLAUDE_CODE_*/HERDR_* 가 새었다 — 멈춘다"; exit 4; }
echo "env 오염 검사 통과(CLAUDE_CODE_*·CLAUDECODE·HERDR_* 없음)"
echo "claude=$(/bin/zsh -lc 'command -v claude; claude --version' 2>&1 | tr '\n' ' ')" | sed "s#$HOME#~#g"
echo "up ok $(date '+%F %T')"
