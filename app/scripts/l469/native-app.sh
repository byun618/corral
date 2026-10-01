#!/bin/sh
# LIFE-469 K8 — 네이티브 앱만 (재)기동한다. 떠 있는 우리 앱(app.pid)이 있으면 **그 빌드 경로의 프로세스인지 확인하고** 끈 뒤
# 지정 빌드로 다시 띄운다(이전 빌드 → 구현 빌드 교체, 재시작 보존 관측). herdr default·profile 은 native-up 이 준비한다.
# 사용: sh native-app.sh <ROOT> <app 디렉터리> <raw 폴더> <꼬리표>
set -eu
ROOT=$1; APP=$2; RAWD=$3; LABEL=$4
HERE=$(cd "$(dirname "$0")" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
SOCK="$HOME/.config/herdr/herdr.sock"
alive() { kill -0 "$1" 2>/dev/null; }
if [ -f "$ROOT/app.pid" ]; then
  A=$(cat "$ROOT/app.pid"); PREV=$(cat "$ROOT/app.dir")
  if alive "$A"; then
    ps -o command= -p "$A" | grep -qF -- "$PREV" || { echo "✘ app pid $A 가 $PREV 의 프로세스가 아니다 — 죽이지 않는다"; exit 3; }
    kill "$A"; i=0; while alive "$A"; do i=$((i+1)); [ $i -gt 150 ] && { echo "✘ app $A 가 30초 안에 끝나지 않았다"; exit 3; }; sleep 0.2; done
    echo "app $A 종료($PREV)" | tee -a "$RAWD/app-process.txt"
  fi
  i=0; while [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 50 ] && { rm -f "$ROOT/ctl.sock"; break; }; sleep 0.2; done
fi
sh "$HERE/clean.sh" CORRAL_BACKEND_SOCKET="$SOCK" CORRAL_SESSION=default CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" -- "$NODE $APP/cli/corral.mjs open --json" > "$ROOT/open-$LABEL.json"
"$NODE" -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(!d.ok){console.log(JSON.stringify(d));process.exit(1)}require('fs').writeFileSync(process.argv[2],String(d.result.runtime.pid))" "$ROOT/open-$LABEL.json" "$ROOT/app.pid"
printf '%s' "$APP" > "$ROOT/app.dir"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "control socket 없음"; exit 1; }; sleep 0.2; done
echo "[$LABEL] $(ps -o pid=,ppid=,lstart=,command= -p "$(cat "$ROOT/app.pid")" | cut -c1-260)" | tee -a "$RAWD/app-process.txt"
