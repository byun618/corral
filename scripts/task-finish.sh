#!/usr/bin/env bash
# task-finish.sh <LIFE-NNN-슬러그> [--into feature/LIFE-MMM-<슬러그>]
# 게이트 ② 뒤 작업 정리 — worktree·로컬 브랜치·격리 herdr 세션 (LIFE-574 에서 PR 흐름으로 바꿈).
# main 에 머지·push 하지 않는다. main 반영은 출고 때 scripts/release.sh 가 PR 머지로만 한다.
#   기본      : 작업 브랜치 PR 이 있어야 한다(scripts/task-pr.sh). 로컬 작업 브랜치 = origin 사본임을 확인하고 지운다
#               — 작업 브랜치는 원격(PR head)에 남는다. 출고 뒤 다시 돌리면 남은 원격 브랜치도 지운다(이미 머지된 PR)
#   --into F  : 묶음(feature 브랜치)의 자식 작업 — PR 없이 작업 브랜치를 F 에 로컬 merge 해 origin F 에 push 한 뒤 정리
# 본체 밖 어디서 실행해도 됨 (레포 위치는 스크립트의 git 공통 디렉터리에서 역산). 멱등 — 이미 처리된 단계는 건너뜀.
#
# 2026-09-14 (LIFE-357 인계 §3-①) — 변형 브랜치 발견을 하드코딩 3종에서 접두 매칭으로 일반화.
# -claude/-codex(경쟁 구현) 는 원래부터 미머지 상태로 버려도 되는 게 설계다 — 강제 삭제 유지.
# 그 외 변형(-fix 등, 코디네이터가 게이트①수정 라운드용으로 만든 것)은 작업 브랜치에 이미
# 머지돼 있어야 정상이므로, 작업 브랜치(PR head) 조상인지 확인하고 아니면 멈춘다(미머지 작업 유실 방지).
set -euo pipefail

TASK=""; INTO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --into) INTO="${2:?--into 값 없음}"; shift 2 ;;
    -*) echo "✖ 모르는 옵션: $1" >&2; exit 1 ;;
    *) TASK="$1"; shift ;;
  esac
done
[ -n "$TASK" ] || { echo "✖ 사용법: task-finish.sh <LIFE-NNN-슬러그> [--into feature/LIFE-MMM-슬러그]" >&2; exit 1; }
# 레포 = 본체 checkout. 작업 worktree 의 사본이나 `git show … > 파일` 로 꺼낸 사본으로 돌려도 본체를 가리키게
# 스크립트 위치(없으면 cwd)의 git 공통 디렉터리에서 역산한다
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --path-format=absolute --git-common-dir)" \
  || { echo "✖ git 레포 안에서 실행한다" >&2; exit 1; }
REPO="$(dirname "$COMMON")"
WT="$REPO/.claude/worktrees"
NNN="$(echo "$TASK" | grep -oE '^LIFE-[0-9]+' | grep -oE '[0-9]+' || true)"

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

is_throwaway() { [ "$1" = "$TASK-claude" ] || [ "$1" = "$TASK-codex" ]; }
has_local() { git -C "$REPO" rev-parse --verify -q "refs/heads/$1" >/dev/null; }
has_remote() { [ -n "$(git -C "$REPO" ls-remote --heads origin "refs/heads/$1")" ]; }

# 0. 안전 확인
case "$PWD/" in "$WT/$TASK"*) die "작업 worktree 안에서 실행 금지 — 본체나 다른 위치에서 실행" ;; esac
cd "$REPO"
git fetch -q --prune origin
if [ -d "$WT/$TASK" ]; then
  [ -z "$(git -C "$WT/$TASK" status --porcelain)" ] || die "작업 worktree 에 미커밋 변경 — 먼저 커밋(인계 문서 포함)"
fi

# 1. 작업 브랜치가 어디에 보존됐는지 확인 — 그 기준(KEEP)으로 변형 브랜치를 검사한다
if [ -n "$INTO" ]; then
  # 묶음 자식: feature 에 로컬 merge → push (임시 worktree, rebase 금지)
  git rev-parse --verify -q "refs/remotes/origin/$INTO" >/dev/null || die "원격 feature 브랜치 없음: origin/$INTO"
  KEEP="origin/$INTO"
  if has_local "$TASK" && ! git merge-base --is-ancestor "$TASK" "origin/$INTO"; then
    TMPWT="$WT/_finish-$TASK"
    git worktree add -q --detach "$TMPWT" "origin/$INTO"
    if ! git -C "$TMPWT" merge --no-ff --no-edit "$TASK" >/dev/null; then
      git -C "$TMPWT" merge --abort || true; git worktree remove --force "$TMPWT"
      die "$TASK → $INTO 충돌 — feature 쪽을 작업 브랜치에 merge 해 풀고 다시"
    fi
    git -C "$TMPWT" push -q origin "HEAD:refs/heads/$INTO" || { git worktree remove --force "$TMPWT"; die "origin/$INTO push 실패"; }
    git worktree remove --force "$TMPWT"
    git fetch -q origin "$INTO"
    note "$INTO ← $TASK 머지·push"
  else
    note "$TASK 는 이미 $INTO 에 들어 있음"
  fi
else
  PR="$(gh pr list --head "$TASK" --state all --json number,state,baseRefName --jq 'sort_by(.number) | last | if . == null then "" else "\(.number) \(.state) \(.baseRefName)" end')"
  [ -n "$PR" ] || die "$TASK 의 PR 이 없다 — 먼저 scripts/task-pr.sh $TASK"
  set -- $PR; PR_NUM="$1"; PR_STATE="$2"; PR_BASE="$3"
  case "$PR_STATE" in
    OPEN) KEEP="origin/$TASK"
          git rev-parse --verify -q "refs/remotes/origin/$TASK" >/dev/null || die "PR 이 열려 있는데 원격 $TASK 가 없다" ;;
    MERGED) KEEP="origin/$PR_BASE" ;;
    *) die "$TASK 의 PR #$PR_NUM 상태가 $PR_STATE — 열림·머지만 정리한다" ;;
  esac
  if has_local "$TASK"; then
    git merge-base --is-ancestor "$TASK" "$KEEP" || die "로컬 $TASK 에 $KEEP 에 없는 커밋이 있다 — push(task-pr.sh) 뒤 다시"
  fi
  note "$TASK 보존 위치: $KEEP (PR #$PR_NUM $PR_STATE → $PR_BASE)"
fi

# 2. 변형 브랜치·worktree 전수 발견 ($TASK-* 접두 — -claude/-codex/-fix 등 이름 안 가림)
# macOS 기본 /bin/bash 가 3.2(GPLv3 회피)라 `mapfile` 이 없다 — while-read 로 배열 구성
VARIANTS=()
while IFS= read -r v; do [ -n "$v" ] && VARIANTS+=("$v"); done < <(
  { find "$WT" -maxdepth 1 -type d -name "$TASK-*" -exec basename {} \; 2>/dev/null ;
    git branch --list "$TASK-*" --format='%(refname:short)' ; } | sort -u
)

# 안전: throwaway(-claude/-codex) 가 아닌 변형이 보존 위치의 조상이 아니면 멈춘다 — 미머지 작업일 수 있다
for v in "${VARIANTS[@]:-}"; do
  [ -z "$v" ] && continue
  is_throwaway "$v" && continue
  has_local "$v" || continue
  git merge-base --is-ancestor "$v" "$KEEP" || \
    die "$v 가 $KEEP 조상이 아님 — 미머지 작업일 수 있다, 수동 확인 후 재실행(자동 삭제 안 함)"
done

# 3. worktree 제거 — $TASK 자신 + 변형 전부
for w in "$TASK" "${VARIANTS[@]:-}"; do
  [ -n "$w" ] && [ -d "$WT/$w" ] && { git worktree remove --force "$WT/$w" && note "worktree 제거: $w"; }
done
git worktree prune

# 4. 로컬 브랜치 정리 (변형은 확인됐으니 삭제, $TASK 는 보존 위치 확인 뒤 삭제. 태그 LIFE-NNN-*-final 은 유지)
#    원격 throwaway 사본(-claude 등 CI 검증용 push)도 지운다
for v in "${VARIANTS[@]:-}"; do
  [ -z "$v" ] && continue
  has_local "$v" && git branch -D "$v" >/dev/null && note "브랜치 삭제: $v"
  has_remote "$v" && git push -q origin --delete "$v" && note "원격 브랜치 삭제: $v"
done
has_local "$TASK" && git branch -D "$TASK" >/dev/null && note "브랜치 삭제: $TASK (보존 위치 $KEEP)"
# 출고(머지) 뒤 또는 feature 로 들어간 뒤에는 원격 작업 브랜치도 필요 없다
if [ "$KEEP" != "origin/$TASK" ] && has_remote "$TASK"; then
  git merge-base --is-ancestor "origin/$TASK" "$KEEP" && git push -q origin --delete "$TASK" && note "원격 브랜치 삭제: $TASK"
fi

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

echo "✔ $TASK 정리 완료 — 보존 위치 $KEEP"
if [ "$KEEP" = "origin/$TASK" ]; then
  echo "□ 다음: 출고 대기(열린 PR). LA 는 '검증 중' 유지 — '완료' 는 출고(scripts/release.sh) 머지 뒤 본체 세션이 전이"
fi
