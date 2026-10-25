#!/bin/sh
# LIFE-532 — 회차 뒤 고아 확인. /tmp/l532 격리 루트·이 worktree 의 Electron·XDG 가 /tmp/l532 인 herdr server 행을 센다. 0 이 아니면 exit 1.
# 양성 대조: L532_ORPHAN_EXTRA=<패턴> 을 주면 그 패턴도 센다.
PAT='/tmp/l532[a-z]|LIFE-532-link-fail-card-claude/app/node_modules/[e]lectron'
[ -n "${L532_ORPHAN_EXTRA:-}" ] && PAT="$PAT|$L532_ORPHAN_EXTRA"
ROWS=$(ps -Ao pid,ppid,etime,command | grep -E "$PAT" | grep -v -e grep -e orphans.sh -e run.sh)
SRV=$(ps -Ao pid=,command= | grep -E '/[h]erdr( --session [^ ]+)? server$' | awk '{print $1}' | while read -r p; do ps eww -o command= -p "$p" | grep -q 'XDG_CONFIG_HOME=/tmp/l532' && ps -o pid=,ppid=,etime=,command= -p "$p"; done)
echo "## ps -Ao pid,ppid,etime,command (필터 $PAT)"; [ -n "$ROWS" ] && echo "$ROWS" | cut -c1-220
echo "## XDG=/tmp/l532* herdr server"; [ -n "$SRV" ] && echo "$SRV"
COUNT=$(printf '%s\n%s' "$ROWS" "$SRV" | grep -c .)
echo "## 남은 l532 프로세스 수: $COUNT"
[ "$COUNT" -eq 0 ]
