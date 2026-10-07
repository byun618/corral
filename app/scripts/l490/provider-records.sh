#!/bin/sh
# LIFE-490 K8 — l485/provider-records.sh 복사(코드 줄의 l485→l490·L485→L490·ROOT 꼴 /tmp/l490n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 K8ⓒ — provider 기록 파일 중 표식(<ROOT>/marker) 이후 바뀐 것: 경로는 해시만, 크기·mtime 만 (477 방식 — 대화 미열람).
# 사용: sh provider-records.sh <marker 파일>
M=$1
for d in "$HOME/.claude/projects" "$HOME/.grok" "$HOME/.codex/sessions"; do
  [ -d "$d" ] || { echo "absent ${d#$HOME/}"; continue; }
  find "$d" -type f -newer "$M" 2>/dev/null | while IFS= read -r f; do
    printf '%s  %sB  mtime=%s  %s/<%s>\n' "${d#$HOME/}" "$(wc -c <"$f" | tr -d ' ')" "$(stat -f %m "$f")" "$(basename "$(dirname "$f")" | shasum -a 256 | cut -c1-10)" "$(basename "$f" | shasum -a 256 | cut -c1-10)"
  done
done
echo "(끝)"
