#!/bin/sh
# LIFE-628 최종 관문 격리 앱 기동 (l676 하네스 개작) — 창은 보이되 비활성(visible-inactive 래퍼), CDP 렌더러·main 인스펙터.
#   sh scripts/l628/up.sh <ROOT=/tmp/l6g/*> <APP 디렉터리(out/ 빌드됨)> <HERDR_BIN> <SESSION>
# herdr 는 herdr.sh 가 띄운 격리 서버(XDG_CONFIG_HOME=<ROOT>/x)에 CORRAL_SESSION·CORRAL_BACKEND_SOCKET 으로만 붙는다(세션 스캔 없음).
# PATH 앞에 <ROOT>/gitwrap(git 실패·지연 주입)·<ROOT>/bin(가짜 claude). userData·설정·로그·레지스트리는 <ROOT>/ud.
set -u
ROOT=$1; APP=$2; BIN=$3; SESSION=$4
case "$ROOT" in /tmp/l6g/*) ;; *) echo "ROOT 는 /tmp/l6g/*"; exit 2 ;; esac
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOCK="$ROOT/x/corral-herdr/sessions/$SESSION/herdr.sock"
EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
[ -S "$SOCK" ] || { echo "herdr 소켓 없음 $SOCK"; exit 2; }
[ -f "$APP/out/main/index.js" ] || { echo "$APP/out 없음"; exit 2; }
"$NODE" "$APP/scripts/build-footprint.mjs" --check >/dev/null 2>&1 || (cd "$APP" && "$NODE" scripts/build-footprint.mjs) || { echo "도우미 빌드 실패"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl" "$ROOT/wrap"; chmod 700 "$ROOT/ud" "$ROOT/ctl"
cp "$HERE/../l676/visible-inactive.cjs" "$ROOT/wrap/main.cjs"
"$NODE" -e "const p=require('$APP/package.json');require('fs').writeFileSync('$ROOT/wrap/package.json',JSON.stringify({name:p.name,productName:p.productName,version:p.version,main:'main.cjs'}))"
port() { "$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
CDP=$(port); INSPECT=$(port); echo "$CDP" > "$ROOT/cdp.port"; echo "$INSPECT" > "$ROOT/inspect.port"
ENVS="XDG_CONFIG_HOME=$ROOT/x L628_ROOT=$ROOT PATH=$ROOT/gitwrap:$ROOT/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET=$SOCK CORRAL_HERDR_BIN=$BIN CORRAL_USER_DATA=$ROOT/ud CORRAL_CONTROL_SOCKET=$ROOT/ctl/ctl.sock CORRAL_SHOT_DIR=$ROOT/shots CORRAL_LA_MCP_URL=http://127.0.0.1:9/mcp CORRAL_SETTINGS=$ROOT/ud/settings.json CORRAL_LOG=$ROOT/ud/corral.ndjson CORRAL_UI_PREFS=$ROOT/ud/ui-prefs.json CORRAL_REGISTRY=$ROOT/ud/repos.json CORRAL_TAILSCALE_BIN=/nonexistent"
LAUNCH='export PATH="$L628_ROOT/gitwrap:$L628_ROOT/bin:$PATH"; exec "$L676_EL" "$L676_WRAP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L676_CDP" --inspect="$L676_INSPECT"'
# shellcheck disable=SC2086
sh "$HERE/../l470/clean.sh" $ENVS L676_MAIN="$APP/out/main/index.js" L676_WRAP="$ROOT/wrap" L676_EL="$EL" L676_CDP="$CDP" L676_INSPECT="$INSPECT" -- "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; tail -5 "$ROOT/electron.log"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "pid app $APID app_dir=$APP cdp=$CDP inspect=$INSPECT at=$(date -u +%FT%TZ)" | tee -a "$ROOT/made.txt"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+)=' && { echo "✘ env 누수"; exit 4; }
echo "up ok"
