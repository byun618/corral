#!/bin/sh
# LIFE-555 최종 관문 — 전후 환경 기록 (A12·사전 확인). 사용: sh f-env.sh <pre|post> <원자료 폴더>
# pre: 사용자 userData 로 떠 있는 corral(설치본·레포 Electron 모두)이 있으면 exit 3 — 끄지 않고 멈춘다(02-kickoff 격리 5번).
. "$(dirname "$0")/f-lib.sh"
LABEL=$1; OUT=$2
echo "## $LABEL $(date '+%F %T %Z')"
echo "## 설정 해시 (읽기만)"
shasum -a 256 "$HOME/.orca/keybindings.json" "$HOME/.claude/settings.json" "$HOME/.codex/config.toml" "$HOME/.grok/config.toml" "$HOME/.config/herdr/config.toml" | tee "$OUT/env-$LABEL-hashes.txt"
echo "## herdr 세션 (running)"; "$HERDR" session list --json | json_get 'r.sessions.filter(s=>s.running).map(s=>s.name).join(",")'
TABS=$(herdr_tabs); echo "herdr_default_tabs=$TABS" | tee "$OUT/env-$LABEL-tabs.txt"
echo "## corral 계열 프로세스 (설치본·레포 Electron·CLI)"
ps -Ao pid=,ppid=,command= | grep -E 'corral\.app/Contents/MacOS/corral|electron/dist/Electron\.app/Contents/MacOS/Electron .*corral|cli/corral\.mjs' | grep -v grep | cut -c1-240 > "$OUT/env-$LABEL-corral-procs.txt"
cat "$OUT/env-$LABEL-corral-procs.txt"; COUNT=$(grep -c . "$OUT/env-$LABEL-corral-procs.txt")
echo "corral_procs=$COUNT"
echo "## 설치 Orca·life417-native (무접촉 대조 — 있으면 pid·시작 시각)"
ps -Ao pid=,lstart=,command= | grep -E '/Applications/Orca\.app/Contents/MacOS/Orca$|herdr --session life417-native server' | grep -v grep | cut -c1-200 | tee "$OUT/env-$LABEL-untouched.txt"
echo "## 측정 소켓 잔존 (/tmp/l555*)"; ls -d /tmp/l555* 2>/dev/null || echo none
ps -Ao pid,ppid,etime,command > "$OUT/env-$LABEL-ps.txt"
if [ "$LABEL" = pre ]; then
  check corral_not_running "$COUNT" 0
  control corral_not_running "$COUNT" 1
  [ "$COUNT" = 0 ] || { echo "사용자 corral 이 떠 있다 — 끄지 않고 멈춘다"; exit 3; }
fi
echo "fails=$FAILS"; exit $FAILS
