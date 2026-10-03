#!/bin/sh
# LIFE-493 수정 r3 H2 — 네이티브 회차 뒤 고아 점검 (native-ab-cycle.sh · native-ab-built.sh 공용).
# ① 부모가 죽어 PPID 1 이 된 이 일감 프로세스(명령줄에 l493 · fixture 경로 · herdr default 서버)
# ② fixture 경로를 cwd 로 둔 provider 프로세스(claude·grok·codex)
# 찾은 것마다 `ORPHAN <pid> <설명>` 한 줄. 아무것도 끄지 않는다(보고만).
# 사용: sh orphan-check.sh <fixture 경로>
FX=$1
ps -Ao pid=,ppid=,command= | awk '$2==1' | grep -E "l493|$FX|herdr --session default server" | grep -v -e grep -e orphan-check.sh | while read -r pid ppid cmd; do echo "ORPHAN $pid ppid1 $(echo "$cmd" | cut -c1-120)"; done
for p in $(pgrep -x claude) $(pgrep -f "grok|codex"); do
  c=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-)
  case "$c" in "$FX"*) echo "ORPHAN $p cwd $c";; esac
done
