#!/bin/sh
# LIFE-702 최종 관문 — 격리 개발 앱 기동(l670/up.sh 사본 — ROOT·세션 이름 l702g, LA = 모의 MCP 서버, 모의 출처 함께). app/ 에서:
#   sh scripts/l702/up.sh <ROOT=/tmp/l702g-*> [KEY=VALUE ...]
# - LA = <ROOT>/fixture.url 의 모의 서버(scripts/l702/fixture-server.mts 를 먼저 띄운다). 실제 LA 무접촉.
# - 모의 출처(CORRAL_WORK_MOCK=1, 측정 모드에서만 등록) — ⓖ 순서 이동 장면용(LA 는 순서 능력이 꺼져 있다, LIFE-612).
# - userData·설정·로그·연결·활동·ui-prefs·레포 목록 = <ROOT>/ud 아래. 자격 = 계측 cipher(`CORRAL_WORK_TEST_CIPHER=1`) — 키체인 무접촉.
# - herdr = 레포 guard 바이너리의 이름 세션 `l702g-<ROOT 꼬리>`. 설치본 corral·그 userData·사용자 herdr 세션 무접촉.
# - 환경 L702_APP_DIR = 실행할 앱 폴더(기본 app/ — 기준 commit 빌드·씨앗 사본을 넘길 때) · L702_EXTRA_ARGS = Electron 인자(CDP 포트 등).
set -u
ROOT=$1; shift
case "$ROOT" in /tmp/l702g-*) ;; *) echo "ROOT 는 /tmp/l702g-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SESSION="l702g-$(basename "$ROOT" | sed 's/^l702g-//')"
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
INSTALLED_UD="$HOME/Library/Application Support/corral"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
[ -s "$ROOT/fixture.url" ] || { echo "모의 LA 서버 없음 — fixture-server.mts 먼저"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래"; exit 5;; esac
if [ ! -S "$SOCK" ]; then
  sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION"
rm -f "$ROOT/ctl/ctl.sock"
# 추가 인자는 실행 문자열에 바로 싣는다 — env(clean.sh) 로 넘기면 공백에서 갈라져 env 가 둘째 인자를 명령으로 읽는다(g1-g01 첫 회차).
LAUNCH="exec \"\$L702_EL\" \"\$L702_APP\" --user-data-dir=\"\$CORRAL_USER_DATA\" ${L702_EXTRA_ARGS:-}"
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$GUARD" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" \
  CORRAL_LA_MCP_URL="$(cat "$ROOT/fixture.url")" CORRAL_WORK_MOCK=1 CORRAL_WORK_TEST_CIPHER=1 CORRAL_WORK_IPC_TRACE="$ROOT/ipc-trace.ndjson" \
  CORRAL_SETTINGS="$ROOT/ud/settings.json" CORRAL_LOG="$ROOT/ud/corral.ndjson" CORRAL_WORK_CONNECTIONS="$ROOT/ud/work-connections.json" CORRAL_WORK_ACTIVITY="$ROOT/ud/work-activity.json" CORRAL_UI_PREFS="$ROOT/ud/ui-prefs.json" CORRAL_REGISTRY="$ROOT/ud/repos.json" "$@" \
  L702_EL="$EL" L702_APP="${L702_APP_DIR:-$APP}" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID launch=$N at=$(date '+%T')"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
echo "up ok"
