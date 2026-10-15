#!/bin/sh
# LIFE-603 R1-H ① — 격리 프로필 기동. l602/up.sh 를 옮기고 ROOT 를 /tmp/l603g-* 로, 시작 미확정 기록(CORRAL_WORK_START_PENDING)까지 ROOT 아래로 못박았다.
#   app/ 에서: sh scripts/l603/up.sh <ROOT=/tmp/l603g-*> [KEY=VALUE ...]
# - userData = <ROOT>/ud(런타임 소켓 = <ROOT>/ud/runtime/rpc.sock — transport.ts 기본값이 userData 아래) · 제어 소켓 = <ROOT>/ctl/ctl.sock
# - herdr = 레포 guard 바이너리의 이름 세션 `l603g-<ROOT 꼬리>`. 설치본 corral · 그 userData · 사용자 herdr 세션 · 기본 소켓 무접촉.
# - 만든 경로·PID 는 <ROOT>/made.txt 에 한 줄씩(down.sh 와 회차 기록이 읽는다).
# - L603_DRY=1 이면 아무것도 띄우지 않고 쓸 환경만 찍고 끝난다(자기점검용 — up.nodetest.mjs).
# 실패 전파: 가드 위반 exit 2·5 · 이미 떠 있음 3 · env 누수 4 · 소켓 안 뜸 1. 성공만 마지막 줄 「up ok」.
set -u
ROOT=${1:-}; [ $# -gt 0 ] && shift
case "$ROOT" in /tmp/l603g-*) ;; *) echo "ROOT 는 /tmp/l603g-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
INSTALLED_UD="$HOME/Library/Application Support/corral"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래"; exit 5;; esac
SESSION="l603g-$(basename "$ROOT" | sed 's/^l603g-//')"
case "$SESSION" in default|corral|'') echo "✘ herdr 세션 이름이 기본값"; exit 5;; esac
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
ENVS="CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET=$SOCK CORRAL_USER_DATA=$ROOT/ud CORRAL_CONTROL_SOCKET=$ROOT/ctl/ctl.sock CORRAL_SHOT_DIR=$ROOT/shots CORRAL_LA_MCP_URL=http://127.0.0.1:9/mcp CORRAL_WORK_MOCK=1 CORRAL_WORK_TEST_CIPHER=1 CORRAL_WORK_IPC_TRACE=$ROOT/ipc-trace.ndjson CORRAL_SETTINGS=$ROOT/ud/settings.json CORRAL_LOG=$ROOT/ud/corral.ndjson CORRAL_WORK_CONNECTIONS=$ROOT/ud/work-connections.json CORRAL_WORK_ACTIVITY=$ROOT/ud/work-activity.json CORRAL_WORK_START_PENDING=$ROOT/ud/work-start-pending.json CORRAL_UI_PREFS=$ROOT/ud/ui-prefs.json CORRAL_REGISTRY=$ROOT/ud/repos.json"
if [ "${L603_DRY:-}" = 1 ]; then echo "$ENVS" | tr ' ' '\n'; echo "dry ok"; exit 0; fi
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
echo "path $ROOT" >> "$ROOT/made.txt"
if [ ! -S "$SOCK" ]; then
  sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
  echo "path $(dirname "$SOCK")" >> "$ROOT/made.txt"
  echo "pid herdr $(cat "$ROOT/herdr.pid")" >> "$ROOT/made.txt"
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION"
rm -f "$ROOT/ctl/ctl.sock"
LAUNCH='if [ -n "${L603_EXE:-}" ]; then exec "$L603_EXE" --user-data-dir="$CORRAL_USER_DATA" ${L603_EXTRA_ARGS:-}; else exec "$L603_EL" "$L603_APP" --user-data-dir="$CORRAL_USER_DATA" ${L603_EXTRA_ARGS:-}; fi'
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" $ENVS CORRAL_HERDR_BIN="$GUARD" "$@" \
  L603_EL="$EL" L603_APP="${L603_APP_DIR:-$APP}" L603_EXE="${L603_EXE:-}" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "pid app $APID" >> "$ROOT/made.txt"
echo "app_pid=$APID launch=$N at=$(date '+%T')"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
echo "up ok"
