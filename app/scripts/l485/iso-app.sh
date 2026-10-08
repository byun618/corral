#!/bin/sh
# LIFE-485 격리 corral 기동 — 최소 PATH(GUI 기동과 같은), 바인딩 env 없음(기본 경로). 사용: sh iso-app.sh <ROOT> <app 디렉터리> [KEY=VALUE ...]
# 추가 env 로 CORRAL_HERDR_BIN·CORRAL_BACKEND_SOCKET·CORRAL_SESSION 등을 줄 수 있다. 앱 pid 는 <ROOT>/app.pid
# LIFE-561 fix1 M1 — 기본 CORRAL_HERDR_BIN 을 brew herdr 로 둔다. 없으면 레포 guard(herdr-dev 폴더)로 풀려 lib.sh herdr_iso(brew·herdr 폴더)와
# 갈린다. 추가 env 의 CORRAL_HERDR_BIN 이 뒤에 오므로 호출자 값이 이긴다(env 는 뒤 값이 이긴다).
set -eu
ROOT=$1; APP=$2; shift 2
EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  XDG_CONFIG_HOME="$ROOT/xdg" CORRAL_USER_DATA="$ROOT/ud" CORRAL_RUNTIME_SOCKET="$ROOT/rt.sock" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" \
  CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" CORRAL_HERDR_BIN=/opt/homebrew/bin/herdr "$@" \
  "$EL" "$APP" --user-data-dir="$ROOT/ud" > "$ROOT/electron.log" 2>&1 &
echo $! > "$ROOT/app.pid"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "control socket 없음"; exit 1; }; sleep 0.2; done
echo "app pid $(cat "$ROOT/app.pid")"
