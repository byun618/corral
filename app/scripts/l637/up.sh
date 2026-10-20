#!/bin/sh
# LIFE-637 최종 관문 격리 회차 기동 — app/ 에서: sh scripts/l637/up.sh <ROOT=/tmp/l637f-*>
# - 빌드 산출물(app/out)의 제품 main 을 래퍼(visible-inactive.cjs)로 띄운다: 창은 보이지만 비활성(키 포커스 안 가져감).
# - CDP: 렌더러 --remote-debugging-port(<ROOT>/cdp.port) · main --inspect(<ROOT>/inspect.port).
# - herdr = 레포 guard 바이너리의 이름 세션 l637f-<꼬리>(사용자 herdr 세션 무접촉). userData·설정·로그·소켓은 <ROOT> 아래.
# - 만든 경로·PID 는 <ROOT>/made.txt. 끄기는 down.sh.
set -u
ROOT=${1:-}; [ $# -gt 0 ] && shift
case "$ROOT" in /tmp/l637f-*) ;; *) echo "ROOT 는 /tmp/l637f-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
SESSION="l637f-$(basename "$ROOT" | sed 's/^l637f-//')"
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
KEY=$("$NODE" -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
[ -f "$APP/out/main/index.js" ] || { echo "app/out 없음 — 빌드 먼저"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl" "$ROOT/wrap"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
echo "path $ROOT" >> "$ROOT/made.txt"
if [ ! -S "$SOCK" ]; then
  sh "$APP/scripts/l470/clean.sh" DISABLE_AUTO_UPDATE=true -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
  echo "path $(dirname "$SOCK")" >> "$ROOT/made.txt"
  echo "pid herdr $(cat "$ROOT/herdr.pid")" >> "$ROOT/made.txt"
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION sock=$SOCK"
cp "$APP/scripts/l637/visible-inactive.cjs" "$ROOT/wrap/main.cjs"
"$NODE" -e "const p=require('$APP/package.json');require('fs').writeFileSync('$ROOT/wrap/package.json',JSON.stringify({name:p.name,productName:p.productName,version:p.version,main:'main.cjs'}))"
port() { "$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
CDP=$(port); INSPECT=$(port); echo "$CDP" > "$ROOT/cdp.port"; echo "$INSPECT" > "$ROOT/inspect.port"
ENVS="CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET=$SOCK CORRAL_HERDR_BIN=$GUARD CORRAL_USER_DATA=$ROOT/ud CORRAL_CONTROL_SOCKET=$ROOT/ctl/ctl.sock CORRAL_SHOT_DIR=$ROOT/shots CORRAL_LA_MCP_URL=http://127.0.0.1:9/mcp CORRAL_SETTINGS=$ROOT/ud/settings.json CORRAL_LOG=$ROOT/ud/corral.ndjson CORRAL_UI_PREFS=$ROOT/ud/ui-prefs.json CORRAL_REGISTRY=$ROOT/ud/repos.json CORRAL_TAILSCALE_BIN=/nonexistent"
LAUNCH='exec "$L637_EL" "$L637_WRAP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L637_CDP" --inspect="$L637_INSPECT"'
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" $ENVS L637_MAIN="$APP/out/main/index.js" L637_WRAP="$ROOT/wrap" L637_EL="$EL" L637_CDP="$CDP" L637_INSPECT="$INSPECT" "$@" -- "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; tail -5 "$ROOT/electron.log"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "pid app $APID" >> "$ROOT/made.txt"
echo "app_pid=$APID cdp=$CDP inspect=$INSPECT at=$(date -u +%FT%TZ)"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ env 누수"; exit 4; }
echo "up ok"
