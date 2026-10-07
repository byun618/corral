#!/bin/sh
# LIFE-507 K6ⓐ — 네이티브 회차 중 herdr `default` 서버를 한 번 재기동한다(corral 은 그대로 — K1 의 「corral 실행 중 herdr 재기동」).
# native-up.sh 가 띄운 서버(backend.pid)만 끈다 — 명령줄이 `herdr --session default server` 가 아니면 아무것도 하지 않고 exit 3.
# 다시 띄우는 길은 native-up.sh ② 와 같다(clean.sh nohup, 설치 herdr 0.9.0, 사용자 기본 설정). 새 pid 를 backend.pid 에 쓰고(native-down.sh 가 그것을 끈다),
# 재기동 전 복구 대상 세션 수(session-restore-check)와 재기동 뒤 복구로 뜬 provider 프로세스 목록을 원자료로 남긴다. 복구 pane 에는 입력하지 않는다.
# 사용: sh native-herdr-restart.sh <ROOT=/tmp/l507n*> <raw 폴더> <꼬리표>
set -eu
ROOT=$1; RAWD=$2; LABEL=$3
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
HERDR=/opt/homebrew/bin/herdr
HCFG="$HOME/.config/herdr"
SOCK="$HCFG/herdr.sock"
. "$(dirname "$0")/path-check.sh"
l507_real_dir "$ROOT" /tmp/l507n || { echo "✘ ROOT 는 /tmp/l507n 아래 정규형 실제 폴더만: $ROOT"; exit 2; }
B=$(cat "$ROOT/backend.pid")
ps -o command= -p "$B" | grep -qF -- "$HERDR --session default server" || { echo "✘ backend pid $B 가 우리 herdr default 가 아니다 — 건드리지 않는다"; exit 3; }
"$NODE" "$(dirname "$0")/../l477/session-restore-check.mjs" "$HCFG/session.json" --allow-session-restore > "$RAWD/herdr-restart-$LABEL-restore-check.txt" || true
cat "$RAWD/herdr-restart-$LABEL-restore-check.txt"
kill "$B"
i=0; while kill -0 "$B" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && { echo "✘ backend $B 가 30초 안에 끝나지 않았다"; exit 1; }; sleep 0.2; done
echo "backend $B 종료 $(date '+%H:%M:%S')"
i=0; while "$HERDR" session list 2>/dev/null | awk '$1=="default"{print $2}' | grep -q running; do i=$((i+1)); [ $i -gt 100 ] && { echo "✘ default 가 running 으로 남았다"; exit 1; }; sleep 0.2; done
sh "$HERE/clean.sh" -- "nohup $HERDR --session default server >> $ROOT/backend.log 2>&1 & echo \$! > $ROOT/backend.pid"
i=0; until [ -S "$SOCK" ] && "$HERDR" session list 2>/dev/null | awk '$1=="default"{print $2}' | grep -q running; do i=$((i+1)); [ $i -gt 150 ] && { echo "✘ backend 안 뜸"; exit 1; }; sleep 0.2; done
ps -o pid=,ppid=,lstart=,command= -p "$(cat "$ROOT/backend.pid")" | tee "$RAWD/herdr-restart-$LABEL.txt"
sleep 3
"$NODE" "$(dirname "$0")/restored-agents.mjs" "$ROOT" "$RAWD"
cp "$RAWD/restored-agents.txt" "$RAWD/herdr-restart-$LABEL-restored-agents.txt"
echo "복구로 뜬 provider 프로세스 $(grep -c . "$RAWD/restored-agents.txt" | tr -d ' ')개 (restored-agents.txt)"
