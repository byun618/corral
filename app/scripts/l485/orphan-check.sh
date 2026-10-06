#!/bin/sh
# LIFE-485 — 회차 뒤 고아 확인 (검사기 자신의 행 — orphan-check·rec.sh — 은 뺀다, r19 에서 자기 행 4개를 셌다): 격리 루트(/tmp/l485)·이 worktree 의 Electron·herdr server 행. life417-native 는 양성 대조로만 보인다.
echo "## ps -Ao pid,ppid,etime,command (필터: l485 · herdr server · LIFE-485 worktree Electron)"
ps -Ao pid,ppid,etime,command | grep -E 'l485|/[h]erdr( --session [^ ]+)? server$|LIFE-485-herdr-autostart-claude/app/node_modules/[e]lectron' | grep -v -e grep -e orphan-check -e rec.sh | cut -c1-220
echo "## 남은 l485 프로세스 수(life417 제외): $(ps -Ao pid,command | grep -E 'l485|LIFE-485-herdr-autostart-claude/app/node_modules/[e]lectron|/[h]erdr( --session [^ ]+)? server$' | grep -v -e grep -e life417-native -e orphan-check -e rec.sh | wc -l | tr -d ' ')"
