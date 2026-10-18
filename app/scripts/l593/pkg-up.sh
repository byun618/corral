#!/bin/sh
# LIFE-593 E9ⓒ — 패키지 앱(dist .app) 격리 기동. g-up.sh 사본: 실행 파일만 패키지 바이너리(L593_PKG), herdr 는 g-up 과 같은 격리 이름 세션(guard). app/ 에서:
#   L593_PKG=<.app/Contents/MacOS/corral> sh scripts/l593/pkg-up.sh <ROOT=/tmp/l593g-*> <FAKE=/tmp/l593g-f*> [KEY=VALUE ...]
# - userData = <ROOT>/ud · 제어 소켓 = <ROOT>/ctl/ctl.sock(폴더 0700) · 샷 = <ROOT>/shots · 로그 = <ROOT>/ud/corral.ndjson(기본 경로)
# - herdr = 레포 guard 바이너리의 이름 세션 `l577g-<ROOT 꼬리>`(없으면 띄운다, 있으면 재사용). herdr-dev default·설치본 herdr 무접촉.
# - tailscale = 가짜 CLI(`CORRAL_TAILSCALE_BIN=scripts/l577/fake-tailscale.mjs`, 상태 `FAKE_TAILSCALE_DIR=<FAKE>`). 덧붙인 KEY=VALUE 가 우선
#   (예: `CORRAL_TAILSCALE_BIN=/nonexistent` — A7 CLI 없음).
# - 로그인 셸·실제 HOME(l470/clean.sh) — 워커 세션 env(CLAUDE_CODE_* 등)는 넘기지 않는다. 설치본 corral·그 userData 무접촉.
set -u
ROOT=$1; FAKE=$2; shift 2
case "$ROOT" in /tmp/l593g-*) ;; *) echo "ROOT 는 /tmp/l593g-*"; exit 2 ;; esac
case "$FAKE" in /tmp/l593g-f*) ;; *) echo "FAKE 는 /tmp/l593g-f*"; exit 2 ;; esac
[ -x "${L593_PKG:-}" ] || { echo "L593_PKG 없음"; exit 2; }
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
SESSION="l577g-$(basename "$ROOT" | sed 's/^l577g-//')"
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
INSTALLED_UD="$HOME/Library/Application Support/corral"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl" "$FAKE"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
echo "# 충돌 없음 확인 $(date '+%F %T')"
echo "installed_userData=~/Library/Application Support/corral installed_rpc_sock_exists=$([ -S "$INSTALLED_UD/runtime/rpc.sock" ] && echo yes || echo no)"
echo "isolated_userData=$ROOT/ud isolated_ctl=$ROOT/ctl/ctl.sock isolated_herdr_session=$SESSION fake=$FAKE"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래"; exit 5;; esac
echo "installed_procs:"; ps -axo pid=,command= | grep -E '/Applications/corral.app/Contents/(MacOS/corral$|Resources/backend/herdr)' | grep -v grep | sed "s#$HOME#~#g" | cut -c1-160
if [ ! -S "$SOCK" ]; then
  sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION"
# SIGKILL 뒤엔 죽은 앱의 제어 소켓 파일이 남는다 — 지우지 않으면 아래 대기가 새 앱을 기다리지 않고 통과한다(a6 1회차).
rm -f "$ROOT/ctl/ctl.sock"
# L577_ELECTRON_ARGS(덧붙인 KEY=VALUE 로) — 시험이 Electron 인자를 더할 때(LIFE-591 r1: `--remote-debugging-port=0` 으로 CDP IME 주입).
# L577_KEEP_PAINTING=1 — 격리 창이 다른 창에 가려져도 렌더러가 그리게(Chromium `--disable-backgrounding-occluded-windows`). 사용자가 다른 창을 쓰는 동안
# 가려진 격리 창은 document hidden·rAF 정지라 Monaco 가 다시 마운트 뒤 줄을 그리지 않는다(LIFE-591 r3 진단 — 창을 앞으로 가져오는 것은 사용자 화면 침범이라 쓰지 않는다).
# L593_PATH(덧붙인 KEY=VALUE 로) — 앱 PATH 를 그 값으로(LIFE-593 수정 r2: 느린 git shim). 로그인 셸이 PATH 를 다시 짜므로 exec 직전에 env 로 준다.
LAUNCH='exec env PATH="${L593_PATH:-$PATH}" "$L593_PKG" --user-data-dir="$CORRAL_USER_DATA" ${L577_KEEP_PAINTING:+--disable-backgrounding-occluded-windows}'
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
date +%s000 > "$ROOT/app.started"
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" CORRAL_SESSION="$SESSION" CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$GUARD" \
  CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" \
  CORRAL_TAILSCALE_BIN="$APP/scripts/l577/fake-tailscale.mjs" FAKE_TAILSCALE_DIR="$FAKE" "$@" \
  L593_PKG="$L593_PKG" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "app_pid=$APID launch=$N at=$(date '+%T')"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^(CORRAL_[A-Z_]+|FAKE_TAILSCALE_DIR)=' | sed "s#$HOME#~#g"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
echo "up ok"
