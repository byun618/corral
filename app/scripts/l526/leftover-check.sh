#!/bin/sh
# LIFE-526 K4ⓐ — l516 복사(ROOT 꼴 /tmp/l526n*·잔존 검색어 l526·이 빌드 경로만 sed 로 바꿈). 아래는 원 주석.
# LIFE-515 K8 (q2 조건 3) — 네이티브 회차 뒤 잔존 점검(보고만, 끄지 않는다). ① orphan-check(PPID 1·fixture cwd provider) ② 복구로 떴던 세션(restored-agents.txt 의 pid) 생존
# ③ herdr default 서버 ④ 이 빌드 Electron. 하나라도 있으면 exit 1. 사용: sh leftover-check.sh <fixture realpath> <raw 폴더>
FX=$1; RAWD=$2; found=0
echo "# ① orphan-check"; sh "$(dirname "$0")/orphan-check.sh" "$FX" || found=1
echo "# ② 복구 세션 pid 생존"
while read -r pid ppid cmd; do [ -n "$pid" ] || continue; if kill -0 "$pid" 2>/dev/null; then echo "ALIVE $pid $(ps -o command= -p "$pid" | cut -c1-120)"; found=1; else echo "gone $pid ($(echo "$cmd" | cut -c1-60))"; fi; done < "$RAWD/restored-agents.txt"
echo "# ③ herdr default 서버"; ps -Ao pid=,ppid=,command= | grep -F "herdr --session default server" | grep -v grep && found=1 || echo "없음"
echo "# ④ 이 빌드 Electron"; ps -Ao pid=,ppid=,command= | grep -F "LIFE-526-footer-icons-claude/app/node_modules/electron" | grep -v grep && found=1 || echo "없음"
echo "# (참고) pgrep -fl 'claude --resume|grok --resume' — 사용자 다른 세션일 수 있다"; pgrep -fl 'claude --resume|grok --resume' || echo "없음"
exit $found
