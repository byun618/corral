#!/bin/sh
# LIFE-576 최종 관문 G3 — 네이티브 개발 실행 기동. app/ 에서: sh scripts/l576/up.sh <원자료 폴더>
# l565/up.sh 를 옮겼다. 실제 HOME·로그인 셸(l470/clean.sh)·이 worktree 빌드 Electron. userData·제어 소켓·로그·herdr 이름 세션만 격리:
#   userData = /tmp/l576n/ud (레지스트리 repos.json·ui-prefs.json·runtime/rpc.sock 이 그 아래) · herdr = guard 바이너리의 이름 세션 l576-native.
# 설치본 corral(사용자 userData·소켓·herdr)·herdr-dev default·다른 세션은 읽기만 한다. 앱만 다시 띄우는 것은 app-up.sh / app-down.sh.
set -u
OUT=$1; ROOT=/tmp/l576n; SESSION=l576-native
APP=$(pwd -P)
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
SDIR="$HOME/.config/herdr-dev/sessions/$SESSION"; SOCK="$SDIR/herdr.sock"
INSTALLED_UD="$HOME/Library/Application Support/corral"
mkdir -p "$OUT"
echo "# ⓪ 전제 $(date '+%F %T')"
DEV=$(ps -axo pid=,command= | grep -E 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep)
echo "dev_gui_before=${DEV:-none}" | sed "s#$HOME#~#g"
echo "$DEV" | grep -qF "$APP/node_modules/electron" && { echo "이 worktree 의 개발 GUI 가 이미 떠 있다 — 멈춘다"; exit 3; }
{ [ -e "$ROOT" ] || [ -e "$SDIR" ]; } && { echo "$ROOT 또는 $SDIR 이미 있음 — 멈춘다"; exit 2; }
echo "## 충돌 없음 확인(기동 전) — 격리 경로 vs 설치본"
echo "installed_userData=$INSTALLED_UD" | sed "s#$HOME#~#g"
echo "installed_rpc_sock=$INSTALLED_UD/runtime/rpc.sock exists=$([ -S "$INSTALLED_UD/runtime/rpc.sock" ] && echo yes || echo no)" | sed "s#$HOME#~#g"
echo "installed_owner=$(cat "$INSTALLED_UD/runtime/owner.json" 2>/dev/null | head -c 200)" | sed "s#$HOME#~#g"
echo "isolated_userData=$ROOT/ud isolated_rpc_sock=$ROOT/ud/runtime/rpc.sock isolated_registry=$ROOT/ud/repos.json isolated_ui_prefs=$ROOT/ud/ui-prefs.json"
echo "isolated_herdr_session=$SESSION sock=$SOCK" | sed "s#$HOME#~#g"
echo "installed_backend_procs:"; ps -axo pid=,command= | grep -E '/Applications/corral.app/Contents/(MacOS/corral$|Resources/backend/herdr)' | grep -v grep | sed "s#$HOME#~#g"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래 — 멈춘다"; exit 5;; esac
echo "herdr_dev_default_server(읽기만):"; ps -axo pid=,lstart=,command= | grep -F "$GUARD server" | grep -v -- '--session' | grep -v grep | sed "s#$HOME#~#g"
mkdir -p "$ROOT/ud" "$ROOT/shots"; chmod 700 "$ROOT" "$ROOT/ud"
echo "guard=$GUARD sha=$(shasum -a 256 "$GUARD" | cut -c1-64)" | sed "s#$HOME#~#g"
echo "# ① 이름 세션 서버 $SESSION (로그인 셸·실제 HOME)"
sh "$APP/scripts/l470/clean.sh" -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
ps -o pid=,ppid=,command= -p "$(cat "$ROOT/herdr.pid")" | sed "s#$HOME#~#g"
echo "# ② 개발 실행"
sh "$APP/scripts/l576/app-up.sh" "$OUT" || exit 1
echo "up ok"
