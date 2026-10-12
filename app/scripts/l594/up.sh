#!/bin/sh
# LIFE-594 K2 — 구현 브랜치 개발 Electron(빌드 산출물 app/out) 격리 기동. app/ 에서: sh scripts/l594/up.sh
# userData·제어 소켓·로그·캡처는 /tmp/l594e 아래(사용자 userData·설치본 무접촉). herdr 는 이 회차 전용 이름 세션 l594-k2 를
# 레포 guard herdr 로 띄워 바인딩한다(l565/up.sh 를 줄인 것 — 관측 서버 없음). PID 는 $ROOT 에.
set -u
ROOT=/tmp/l594e; SESSION=l594-k2
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$("$HOME/.nvm/versions/node/v24.14.1/bin/node" -e "const fs=require('fs'),c=require('crypto');const s=JSON.parse(fs.readFileSync('backend/source.json'));console.log(c.createHash('sha256').update(Buffer.concat(s.patches.map(n=>fs.readFileSync('backend/'+n)))).digest('hex').slice(0,16))")
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"; SOCK="$SDIR/herdr.sock"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
[ -x "$GUARD" ] || { echo "guard herdr 없음: $GUARD"; exit 2; }
[ -f "$APP/out/main/index.js" ] || { echo "app/out 없음 — 빌드 먼저"; exit 2; }
{ [ -e "$ROOT" ] || [ -e "$SDIR" ]; } && { echo "$ROOT 또는 $SDIR 이미 있음 — 멈춘다"; exit 2; }
DEV=$(ps -axo pid=,command= | grep -F "$APP/node_modules/electron/dist" | grep -v -- '--type=' | grep -v grep)
[ -n "$DEV" ] && { echo "이 worktree 의 개발 GUI 가 이미 떠 있다 — 멈춘다: $DEV"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/repo"; chmod 700 "$ROOT" "$ROOT/ud"
echo "guard=$GUARD sha=$(shasum -a 256 "$GUARD" | cut -c1-64)" | sed "s#$HOME#~#g"
sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session_dir=$SDIR" | sed "s#$HOME#~#g"
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
LAUNCH='exec "$L594_EL" "$L594_APP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L594_CDP"'
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  L594_EL="$EL" L594_APP="$APP" L594_CDP="$CDP" -- "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
echo $! > "$ROOT/app.pid"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 200 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1)
echo "app_pid=$APID cdp_port=$CDP"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ env 오염 — 멈춘다"; exit 4; }
echo "up ok"
