#!/bin/sh
# LIFE-565 C6 최종 관문 — 개발 앱 기동. app/ 에서: sh scripts/l565/c6-up.sh <원자료 폴더> <bound|spawn> [userData 폴더 이름=ud]
#   bound: corral 이 아닌 경로(깨끗한 로그인 셸에서 guard 직접)로 FORCE_HYPERLINK 없는 이름 세션 l565-c6 서버를 먼저 띄우고,
#          앱을 거기 바인딩해 붙인다(C6ⓗ 한계 관측 — 이미 떠 있는 서버).
#   spawn: 바인딩 없이 띄워 앱이 default 서버를 직접 띄우게 한다(spawnServer → serverEnv, C6ⓗ 2).
# 모두 격리 루트 XDG_CONFIG_HOME=/tmp/l565c6/xdg 아래 — herdr-dev 의 실제 default(주인 미상 24475)·l565-native(코디) 와 소켓·세션 폴더가 갈린다.
# 실제 HOME·로그인 셸·실제 claude·실제 기본 브라우저. userData·제어 소켓·로그만 /tmp/l565c6 아래. PID 는 $ROOT/*.pid.
set -u
OUT=$1; MODE=$2; UDN=${3:-ud}; ROOT=/tmp/l565c6; XDG=$ROOT/xdg; HDIR=$XDG/herdr-dev; SESSION=l565-c6
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
# bound 회차의 userData 는 프로필 바인딩(runtime/profile.json)을 남긴다 — spawn 은 새 userData 로(g09 실패 회차).
mkdir -p "$OUT" "$ROOT/$UDN" "$ROOT/shots" "$XDG"; chmod 700 "$ROOT" "$ROOT/$UDN"
echo "# ⓪ 전제 $(date '+%F %T') mode=$MODE"
DEV=$(ps -axo pid=,command= | grep -E 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep)
echo "dev_gui_before=${DEV:-none}" | sed "s#$HOME#~#g"
[ -n "$DEV" ] && { echo "다른 개발 GUI 가 떠 있다 — 손대지 않고 멈춘다"; exit 3; }
echo "무접촉 서버(읽기만):"; ps -axo pid=,ppid=,etime=,command= | grep -E 'herdr( --session [^ ]+)? server' | grep -v grep | sed "s#$HOME#~#g"
echo "guard=$GUARD sha=$(shasum -a 256 "$GUARD" | cut -c1-64)" | sed "s#$HOME#~#g"
if [ ! -f "$ROOT/http.pid" ] || ! kill -0 "$(cat "$ROOT/http.pid")" 2>/dev/null; then
  echo "# localhost 관측 서버"
  PORT=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  nohup "$NODE" "$APP/scripts/l565/observe-server.mjs" "$PORT" "$ROOT/http.ndjson" > "$ROOT/http.out" 2>&1 &
  echo $! > "$ROOT/http.pid"; echo "$PORT" > "$ROOT/http.port"
  i=0; until curl -s "http://127.0.0.1:$PORT/l565-c6-selftest" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { echo "관측 서버 안 뜸"; exit 1; }; sleep 0.2; done
fi
echo "http_port=$(cat "$ROOT/http.port") http_pid=$(cat "$ROOT/http.pid")"
BIND=""
if [ "$MODE" = bound ]; then
  SOCK="$HDIR/sessions/$SESSION/herdr.sock"
  echo "# ① 이름 세션 서버 $SESSION — corral 이 아닌 경로(clean.sh 로그인 셸에서 guard 직접), FORCE_HYPERLINK 없음"
  [ -S "$SOCK" ] && { echo "$SOCK 이미 있음 — 멈춘다"; exit 2; }
  sh "$APP/scripts/l470/clean.sh" XDG_CONFIG_HOME="$XDG" -- "unset FORCE_HYPERLINK; nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-$SESSION.out' 2>&1 & echo \$! > '$ROOT/herdr-$SESSION.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
  HP=$(cat "$ROOT/herdr-$SESSION.pid"); ps -o pid=,ppid=,command= -p "$HP" | sed "s#$HOME#~#g"
  BIND="CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET=$SOCK"
fi
echo "# ② 개발 실행 (로그인 셸·실제 HOME, XDG_CONFIG_HOME=$XDG${BIND:+, $BIND})"
CDP=$("$NODE" -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
echo "$CDP" > "$ROOT/cdp.port"
rm -f "$ROOT/ctl.sock"
LAUNCH='unset FORCE_HYPERLINK; exec "$L565_EL" "$L565_APP" --user-data-dir="$CORRAL_USER_DATA" --remote-debugging-port="$L565_CDP"'
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" XDG_CONFIG_HOME="$XDG" $BIND \
  CORRAL_USER_DATA="$ROOT/$UDN" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  L565_EL="$EL" L565_APP="$APP" L565_CDP="$CDP" -- "$LAUNCH" >> "$ROOT/electron.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 200 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/$UDN" | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID cdp_port=$CDP"
echo "# ③ 앱 env 판독 (ps eww — env 는 명령행 뒤에 공백으로 이어진다, 토큰 경계로 센다)"
ENVLINE=$(ps eww -o command= -p "$APID")
echo "양성 대조(같은 명령, 알려진 키): CORRAL_USER_DATA 토큰 수=$(printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -c '^CORRAL_USER_DATA=') XDG_CONFIG_HOME 토큰 수=$(printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -c '^XDG_CONFIG_HOME=')"
echo "앱 FORCE_HYPERLINK 토큰 수=$(printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -c '^FORCE_HYPERLINK=') (기대 0)"
echo "앱 env 키 전체(값 없이):"; printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -E '^[A-Z_][A-Z0-9_]*=' | cut -d= -f1 | sort | tr '\n' ' '; echo
printf '%s\n' "$ENVLINE" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE|HERDR_[A-Z_]+|FORCE_HYPERLINK)=' && { echo "✘ CLAUDE_CODE_*/HERDR_*/FORCE_HYPERLINK 가 앱 env 에 있다 — 멈춘다"; exit 4; }
echo "앱 env 오염 검사 통과(CLAUDE_CODE_*·CLAUDECODE·HERDR_*·FORCE_HYPERLINK 없음)"
echo "claude=$(/bin/zsh -lc 'command -v claude; claude --version' 2>&1 | tr '\n' ' ')" | sed "s#$HOME#~#g"
echo "up ok"
