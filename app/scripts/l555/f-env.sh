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
if [ "$LABEL" = post ]; then
  check a12.corral_procs_zero "$COUNT" 0
  check a12.config_hashes_same "$(cut -d' ' -f1 "$OUT/env-post-hashes.txt" | tr '\n' ' ')" "$(cut -d' ' -f1 "$OUT/env-pre-hashes.txt" | tr '\n' ' ')"
  control a12.config_hashes_same "$(cut -d' ' -f1 "$OUT/env-post-hashes.txt" | tr '\n' ' ')" "$(cut -d' ' -f1 "$OUT/env-pre-hashes.txt" | rev | tr '\n' ' ')"
  check a12.herdr_tabs_same "$(cat "$OUT/env-post-tabs.txt")" "$(cat "$OUT/env-pre-tabs.txt")"
  check a12.untouched_same "$(cat "$OUT/env-post-untouched.txt")" "$(cat "$OUT/env-pre-untouched.txt")"
  # 이 일감이 띄운 것: /tmp/l555f* 를 문 프로세스·설치본 헬퍼·격리 herdr — 고아(PPID 1) 포함 전부
  # 검사 자신과 그 조상(이 검사를 부른 셸 — 명령줄에 l555f 가 들어 있을 수 있다)은 뺀다(f16 에서 자기 매칭)
  ANC=" $$ "; P=$$; while [ "$P" -gt 1 ]; do P=$(ps -o ppid= -p "$P" | tr -d ' '); [ -n "$P" ] || break; ANC="$ANC$P "; done
  MINE=$(ps -Ao pid=,ppid=,command= | grep -E 'l555f|/Applications/corral\.app/' | grep -v grep | while read -r pid rest; do case "$ANC" in (*" $pid "*) ;; (*) echo "$pid $rest" ;; esac; done); echo "my_procs: ${MINE:-none}"
  check a12.my_procs_zero "${MINE:-none}" none
  LEFT=$(ls -d /tmp/l555f* 2>/dev/null | tr '\n' ' '); echo "my_tmp: ${LEFT:-none}"
  check a12.my_tmp_zero "${LEFT:-none}" none
  SOCKS=$(find /tmp -maxdepth 3 -name 'ctl.sock' -path '*l555f*' 2>/dev/null); check a12.control_sockets_zero "${SOCKS:-none}" none
  echo "## 관문 뒤 남기는 것(01-criteria 표)"; ls -ld "$INST" "$SHIM_LINK" | sed "s#$HOME#~#"
fi
echo "fails=$FAILS"; exit $FAILS
