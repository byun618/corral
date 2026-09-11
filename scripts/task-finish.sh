#!/usr/bin/env bash
# task-finish.sh <LIFE-NNN-슬러그> — 출고 승인 후 마무리 (main 머지 → push → worktree·브랜치 정리)
# 본체 밖 어디서 실행해도 됨 (레포 위치는 스크립트 경로에서 역산). 멱등 — 이미 처리된 단계는 건너뜀.
set -euo pipefail

TASK="${1:?사용법: task-finish.sh <LIFE-NNN-슬러그>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="$REPO/.claude/worktrees"

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

# 0. 안전 확인
case "$PWD/" in "$WT/$TASK"*) die "작업 worktree 안에서 실행 금지 — 본체나 다른 위치에서 실행" ;; esac
git -C "$REPO" rev-parse --verify -q "refs/heads/$TASK" >/dev/null || note "브랜치 $TASK 없음 (이미 정리됐으면 정상)"
[ -z "$(git -C "$REPO" status --porcelain)" ] || die "본체가 clean 이 아님 — 먼저 수습 필요"
[ "$(git -C "$REPO" branch --show-current)" = "main" ] || die "본체가 main 이 아님"

# 1. main 머지 (작업 브랜치가 남아 있을 때만)
if git -C "$REPO" rev-parse --verify -q "refs/heads/$TASK" >/dev/null; then
  if [ -n "$(git -C "$REPO" log main.."$TASK" --oneline)" ]; then
    git -C "$REPO" merge --no-edit "$TASK" && note "main ← $TASK 머지"
  else
    note "머지할 커밋 없음 (이미 머지됨)"
  fi
fi

# 2. push
git -C "$REPO" push origin main && note "origin/main push"

# 3. worktree 정리 (작업 + 경쟁 2개, 있는 것만)
for w in "$TASK" "$TASK-claude" "$TASK-codex"; do
  if [ -d "$WT/$w" ]; then
    git -C "$REPO" worktree remove --force "$WT/$w" && note "worktree 제거: $w"
  fi
done
git -C "$REPO" worktree prune

# 4. 브랜치 정리 (태그 LIFE-NNN-*-final 은 유지)
for b in "$TASK-claude" "$TASK-codex"; do
  git -C "$REPO" rev-parse --verify -q "refs/heads/$b" >/dev/null && git -C "$REPO" branch -D "$b" && note "브랜치 삭제: $b" || true
done
git -C "$REPO" rev-parse --verify -q "refs/heads/$TASK" >/dev/null && git -C "$REPO" branch -d "$TASK" && note "브랜치 삭제: $TASK" || true

echo "✔ $TASK 마무리 완료 — main $(git -C "$REPO" log --oneline -1 | cut -c1-40)"
echo "□ 확인: LA 일감이 '완료' 로 전이됐는가 (코디네이터 담당 — 누락 시 수동 전이)"
