#!/bin/sh
# LIFE-485 — 회차 뒤 고아 확인 (검사기 자신의 행 — orphan-check·rec.sh — 은 뺀다, r19 에서 자기 행 4개를 셌다).
# fix1 (r1 G-1): 남은 수가 0 이 아니면 exit 1 — 종료코드가 판정이다(r19·r20·r26 은 늘 exit 0 이라 통과 칸이 고아 없음을 뜻하지 않았다).
# fix2: 검사기를 부르는 시나리오 스크립트 자신(scripts/l485/scenario-*)도 뺀다 — r63 에서 자기 행 1개를 셌다.
# 격리 루트(/tmp/l485)·이 worktree 의 Electron·설치 herdr server 행. life417-native 는 양성 대조로만 보인다.
# 양성 대조용: L485_ORPHAN_EXTRA=<패턴> 을 주면 그 패턴도 센다(일부러 남긴 프로세스를 잡는지 본다).
PAT='l485|LIFE-485-herdr-autostart-claude/app/node_modules/[e]lectron|/[h]erdr( --session [^ ]+)? server$'
[ -n "${L485_ORPHAN_EXTRA:-}" ] && PAT="$PAT|$L485_ORPHAN_EXTRA"
ROWS=$(ps -Ao pid,ppid,etime,command | grep -E "$PAT" | grep -v -e grep -e orphan-check -e rec.sh -e "l485/scenario-" -e life417-native)
echo "## ps -Ao pid,ppid,etime,command (필터: $PAT · 검사기 자신·life417-native 제외)"
[ -n "$ROWS" ] && echo "$ROWS" | cut -c1-220
echo "## life417-native 행(양성 대조, 세지 않음): $(ps -Ao pid,command | grep -E '[h]erdr --session life417-native server' | awk '{print $1}')"
COUNT=$(printf '%s' "$ROWS" | grep -c .)
echo "## 남은 l485 프로세스 수(life417 제외): $COUNT"
[ "$COUNT" -eq 0 ]
