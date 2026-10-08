#!/bin/sh
# LIFE-490 K8 — l485/native-app.sh 복사(코드 줄의 l485→l490·L485→L490·ROOT 꼴 /tmp/l490n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 K8 — l470/native-app.sh 복사·수정: CORRAL_BACKEND_SOCKET·CORRAL_SESSION 을 주지 않고 최소 PATH(GUI 기동과 같은)로 Electron 을 직접 띄운다.
# 사용자 userData(--user-data-dir 기본 경로). 제어 소켓만 붙인다. 사용: sh native-app.sh <ROOT> <app 디렉터리> <raw 폴더> <꼬리표>
# LIFE-561 fix1 M1 — 바인딩 없는 개발 실행은 이제 레포 guard 로 풀려 실제 ~/.config/herdr-dev 에 서버를 띄운다. 이 드라이버가 검증한 백엔드
# (로그인 셸로 풀리던 brew herdr, ~/.config/herdr default)를 지키려고 CORRAL_HERDR_BIN 으로 그 바이너리를 고정한다.
set -eu
ROOT=$1; APP=$2; RAWD=$3; LABEL=$4
UD="$HOME/Library/Application Support/corral"
EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
rm -f "$ROOT/ctl.sock"
env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" LANG=en_US.UTF-8 SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" CORRAL_HERDR_BIN=/opt/homebrew/bin/herdr \
  "$EL" "$APP" --user-data-dir="$UD" > "$ROOT/electron-$LABEL.log" 2>&1 &
echo $! > "$ROOT/app.pid"; printf '%s' "$APP" > "$ROOT/app.dir"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "control socket 없음"; exit 1; }; sleep 0.2; done
echo "[$LABEL] $(ps -o pid=,ppid=,lstart=,command= -p "$(cat "$ROOT/app.pid")" | cut -c1-220)" | tee -a "$RAWD/app-process.txt"
echo "[$LABEL] $(ps eww -o command= -p "$(cat "$ROOT/app.pid")" | tr " " "\n" | grep "^PATH=") · env 키: $(ps eww -o command= -p "$(cat "$ROOT/app.pid")" | tr ' ' '\n' | grep -E '^[A-Z_]+=' | cut -d= -f1 | sort | tr '\n' ' ')" | tee -a "$RAWD/app-process.txt"
