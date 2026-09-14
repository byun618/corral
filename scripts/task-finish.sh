#!/usr/bin/env bash
# task-finish.sh <LIFE-NNN-슬러그> — 출고 승인 후 마무리 (main 머지 → push → worktree·브랜치·herdr 세션 정리)
# 본체 밖 어디서 실행해도 됨 (레포 위치는 스크립트 경로에서 역산). 멱등 — 이미 처리된 단계는 건너뜀.
#
# 2026-09-14 (LIFE-357 인계 §3-①) — 변형 브랜치 발견을 하드코딩 3종에서 접두 매칭으로 일반화.
# -claude/-codex(경쟁 구현) 는 원래부터 미머지 상태로 버려도 되는 게 설계다 — 강제 삭제 유지.
# 그 외 변형(-fix 등, 코디네이터가 게이트①수정 라운드용으로 만든 것)은 작업 브랜치에 이미
# 머지돼 있어야 정상이므로, main 조상인지 확인하고 아니면 멈춘다(미머지 작업 유실 방지).
set -euo pipefail

TASK="${1:?사용법: task-finish.sh <LIFE-NNN-슬러그>}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT="$REPO/.claude/worktrees"
NNN="$(echo "$TASK" | grep -oE '^LIFE-[0-9]+' | grep -oE '[0-9]+' || true)"

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

is_throwaway() { [ "$1" = "$TASK-claude" ] || [ "$1" = "$TASK-codex" ]; }

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

# 3. 변형 브랜치·worktree 전수 발견 ($TASK-* 접두 — -claude/-codex/-fix 등 이름 안 가림)
# macOS 기본 /bin/bash 가 3.2(GPLv3 회피)라 `mapfile` 이 없다 — while-read 로 배열 구성
VARIANTS=()
while IFS= read -r v; do [ -n "$v" ] && VARIANTS+=("$v"); done < <(
  { find "$WT" -maxdepth 1 -type d -name "$TASK-*" 2>/dev/null -exec basename {} \; ;
    git -C "$REPO" branch --list "$TASK-*" --format='%(refname:short)' ; } | sort -u
)

# 안전: throwaway(-claude/-codex) 가 아닌 변형이 main 조상이 아니면 멈춘다 — 미머지 작업일 수 있다
for v in "${VARIANTS[@]:-}"; do
  is_throwaway "$v" && continue
  git -C "$REPO" rev-parse --verify -q "refs/heads/$v" >/dev/null || continue
  git -C "$REPO" merge-base --is-ancestor "$v" main || \
    die "$v 가 main 조상이 아님 — 미머지 작업일 수 있다, 수동 확인 후 재실행(자동 삭제 안 함)"
done

# worktree 제거 — $TASK 자신 + 변형 전부
for w in "$TASK" "${VARIANTS[@]:-}"; do
  [ -d "$WT/$w" ] && { git -C "$REPO" worktree remove --force "$WT/$w" && note "worktree 제거: $w"; }
done
git -C "$REPO" worktree prune

# 4. 브랜치 정리 (변형은 확인됐으니 삭제, $TASK 자신은 안전삭제. 태그 LIFE-NNN-*-final 은 유지)
for v in "${VARIANTS[@]:-}"; do
  git -C "$REPO" rev-parse --verify -q "refs/heads/$v" >/dev/null && git -C "$REPO" branch -D "$v" && note "브랜치 삭제: $v" || true
done
git -C "$REPO" rev-parse --verify -q "refs/heads/$TASK" >/dev/null && git -C "$REPO" branch -d "$TASK" && note "브랜치 삭제: $TASK" || true

# 5. 격리 herdr 세션 정리 — life<NNN>* (NNN = TASK 의 LIFE 번호). 사용자 default 세션은 불가침.
#    pane 이 많으면 stop 이 15초 안에 안 끝날 수 있어(실측 233 pane 에 4회) 여러 번 재시도한다.
if [ -n "$NNN" ] && command -v herdr >/dev/null 2>&1; then
  session_status() { herdr session list 2>/dev/null | awk -v n="$1" '$1==n{print $2}'; }
  SESSIONS=()
  while IFS= read -r s; do [ -n "$s" ] && SESSIONS+=("$s"); done < <(
    herdr session list 2>/dev/null | awk -v pfx="life$NNN" 'NR>1 && index($1, pfx)==1 {print $1}'
  )
  for s in "${SESSIONS[@]:-}"; do
    [ -z "$s" ] && continue
    [ "$(session_status "$s")" = "running" ] || continue
    for _ in 1 2 3 4; do
      herdr session stop "$s" >/dev/null 2>&1 || true
      [ "$(session_status "$s")" = "stopped" ] && break
      sleep 1
    done
    if [ "$(session_status "$s")" = "stopped" ]; then
      note "herdr 세션 정지: $s"
    else
      echo "⚠ herdr 세션 $s 정지 실패 — 수동 확인 필요 (herdr session stop $s)" >&2
    fi
  done
fi

echo "✔ $TASK 마무리 완료 — main $(git -C "$REPO" log --oneline -1 | cut -c1-40)"
echo "□ 확인: LA 일감이 '완료' 로 전이됐는가 (코디네이터 담당 — 누락 시 수동 전이)"
