#!/bin/sh
# LIFE-601 — 격리 개발 앱 기동(작업 페이지 빠른 층 진입점). l600/up.sh 에서 모의 LA 서버 요구를 빼고 모의 출처(CORRAL_WORK_MOCK=1)를 켰다. app/ 에서:
#   sh scripts/l601/up.sh <ROOT=/tmp/l601q-*> [KEY=VALUE ...]
# l577 g-up.sh 를 줄여 옮겼다(tailscale 가짜 없음). 덧붙인 KEY=VALUE 가 우선.
# - userData = <ROOT>/ud · 제어 소켓 = <ROOT>/ctl/ctl.sock · 샷 = <ROOT>/shots · 로그 = <ROOT>/ud/corral.ndjson
# - 작업 출처 = 모의 Jira 형(데모 씨앗, CORRAL_WORK_MOCK=1 — 측정 모드에서만 등록). LA 주소는 닿지 않는 로컬(127.0.0.1:9) — 실제 LA 무접촉.
# - 자격 = 계측 cipher(`CORRAL_WORK_TEST_CIPHER=1`) — 사용자 로그인 키체인 무접촉(네이티브 C13 의 첫 질문을 오염시키지 않는다).
# - IPC 응답 기록 = <ROOT>/ipc-trace.ndjson (C7 대조용).
# - herdr = 레포 guard 바이너리의 이름 세션 `l601q-<ROOT 꼬리>`. 설치본 corral·그 userData·herdr 무접촉.
set -u
ROOT=$1; shift
case "$ROOT" in /tmp/l601q-*) ;; *) echo "ROOT 는 /tmp/l601q-*"; exit 2 ;; esac
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SESSION="l601q-$(basename "$ROOT" | sed 's/^l601q-//')"
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
INSTALLED_UD="$HOME/Library/Application Support/corral"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래"; exit 5;; esac
if [ ! -S "$SOCK" ]; then
  sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION"
rm -f "$ROOT/ctl/ctl.sock"
LAUNCH='exec "$L601_EL" "$L601_APP" --user-data-dir="$CORRAL_USER_DATA"'
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$GUARD" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" \
  CORRAL_LA_MCP_URL=http://127.0.0.1:9/mcp CORRAL_WORK_MOCK=1 CORRAL_WORK_TEST_CIPHER=1 CORRAL_WORK_IPC_TRACE="$ROOT/ipc-trace.ndjson" "$@" \
  L601_EL="$EL" L601_APP="$APP" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID launch=$N at=$(date '+%T')"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
echo "up ok"
