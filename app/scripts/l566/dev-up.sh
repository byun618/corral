#!/bin/sh
# LIFE-566 G3 — 구현 worktree 의 개발 실행(Electron)을 실제 HOME 으로 띄운다. userData 만 /tmp/l566n-*.
# herdr 는 레포 guard 바이너리의 **전용 세션 l566** 에 붙는다 — herdr-dev default 는 다른 작업이 쓰고 있어(관측 시점 pid 24475) 건드리지 않는다.
# 사용자 설정(외관)은 사용자 userData 의 settings.json 을 **읽어 복사**만 한다(사용자 화면 조건 재현). 설치본 corral·그 userData·provider 설정 무접촉.
# 사용: sh scripts/l566/dev-up.sh <ROOT=/tmp/l566n-*>   (app/ 에서, out/ 은 미리 빌드)
set -eu
ROOT=$1
case "$ROOT" in /tmp/l566n-*) ;; *) echo "ROOT 는 /tmp/l566n-*"; exit 2 ;; esac
[ -e "$ROOT" ] && { echo "$ROOT 이미 있음"; exit 2; }
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
SESSION=l566
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
"$GUARD" session list 2>/dev/null | awk -v s=$SESSION '$1==s' | grep -q . && { echo "herdr 세션 $SESSION 이 이미 있다 — 멈춘다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots"; chmod 700 "$ROOT"
cp "$HOME/Library/Application Support/corral/settings.json" "$ROOT/ud/settings.json"
echo "# herdr $SESSION 서버"
nohup "$GUARD" --session $SESSION server > "$ROOT/backend.log" 2>&1 &
echo $! > "$ROOT/backend.pid"
i=0; until "$GUARD" session list 2>/dev/null | awk -v s=$SESSION '$1==s{print $2}' | grep -q running; do i=$((i+1)); [ $i -gt 150 ] && { echo "backend 안 뜸"; exit 1; }; sleep 0.2; done
SOCK=$("$GUARD" session list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const x=(j.sessions??j).find(e=>e.name==='$SESSION');console.log(x?.socket??x?.socket_path??'')}catch{console.log('')}})")
[ -n "$SOCK" ] || SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
[ -S "$SOCK" ] || { echo "소켓 없음 $SOCK"; "$GUARD" session list; exit 1; }
echo "backend pid $(cat "$ROOT/backend.pid") sock $SOCK"
echo "# 개발 실행"
env HOME="$HOME" CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_HERDR_BIN="$GUARD" \
  nohup "$EL" "$APP" --user-data-dir="$ROOT/ud" > "$ROOT/electron.log" 2>&1 &
echo $! > "$ROOT/app.pid"; echo "$APP" > "$ROOT/app.dir"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "ctl 안 뜸"; exit 1; }; sleep 0.2; done
echo "app pid $(cat "$ROOT/app.pid") ctl $ROOT/ctl.sock"
