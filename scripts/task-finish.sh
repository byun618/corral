#!/usr/bin/env bash
# task-finish.sh <LIFE-NNN-슬러그> [--into feature/LIFE-MMM-<슬러그>] | task-finish.sh feature/LIFE-MMM-<슬러그>
# 게이트 ② 뒤 작업 정리 — worktree·로컬 브랜치·격리 herdr 세션 (LIFE-574 에서 PR 흐름으로 바꿈).
# main 에 머지·push 하지 않는다. main 반영은 출고 때 scripts/release.sh 가 PR 머지로만 한다.
#   기본      : 작업 브랜치 PR 이 있어야 한다(scripts/task-pr.sh). 로컬 작업 브랜치 = origin 사본임을 확인하고 지운다
#               — 작업 브랜치는 원격(PR head)에 남는다. 출고 뒤 다시 돌리면 남은 원격 브랜치도 지운다(이미 머지된 PR)
#   --into F  : 묶음(feature 브랜치)의 자식 작업 — PR 없이 작업 브랜치를 F 에 로컬 merge 해 origin F 에 push 한 뒤 정리
#   feature/… : 묶음 자신 — feature PR 이 있어야 한다. feature worktree·로컬 feature 정리(아래 finish_feature)
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
[ -n "$TASK" ] || { echo "✖ 사용법: task-finish.sh <LIFE-NNN-슬러그> [--into feature/LIFE-MMM-슬러그] | task-finish.sh feature/LIFE-MMM-슬러그" >&2; exit 1; }
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

# 묶음(feature/LIFE-MMM-<슬러그>) — 출고 승인(PR 생성) 직후 묶음 코디의 마지막 실행, 출고 뒤엔 본체의 안전망 (LIFE-724).
# PR(head = feature) 확인 → 로컬 feature 가 보존 위치에 다 있음 → feature worktree 깨끗 → 남은 자식 0 → feature worktree·로컬 feature 정리.
# 원격 feature 는 PR 이 열려 있는 동안 남긴다(PR head). 검사를 다 통과한 뒤에만 지우고, 지우는 단계가 실패하면 성공을 보고하지 않는다.
# 지우기는 검사한 값에 묶는다 — 로컬 feature 는 update-ref 구 값 비교, 원격 feature 는 --force-with-lease(검사 뒤 움직였으면 멈춘다).
# 자식 = feature 가 아닌 로컬 브랜치·worktree 가운데 ⓐ upstream 이 origin/<feature> 이거나(task-start 2단계 블록이 origin/feature 에서 -b 로 따면
# git 기본값으로 그렇게 된다) ⓑ feature 고유 커밋(<PR base>..<feature> 의 가장 오래된 것)을 품은 것(push -u 로 upstream 이 바뀌었거나
# --no-track·로컬 feature 에서 딴 자식, 자식의 구현 변형, 브랜치 없는 worktree). main·release/*·feature/* 는 세지 않는다 — 독립 작업은
# main 에서 따서 ⓐⓑ 둘 다 없다. **한계**: feature 에 base 에 없는 커밋이 하나도 없을 때(갓 연 묶음) upstream 없이 딴 자식은 못 센다.
# ⓑ 는 origin/feature 에서 딴 integration/… throwaway 도 센다(안전 쪽 — 지우고 다시).
# herdr 격리 세션 정리는 하지 않는다 — 묶음 코디는 구현 워커를 띄우지 않고, 체크포인트 번호 접두 매칭은 자식 세션을 잘못 잡는다.
finish_feature() {
  local FWT PR PR_NUM PR_STATE PR_BASE KEEP here wt_list w b up h kids k u FT LOID="" ROID="" did=0
  echo "$TASK" | grep -qE '^feature/LIFE-[0-9]+-[^/]+$' || die "묶음 브랜치는 feature/LIFE-<번호>-<슬러그> 꼴만 받는다 (받은 값: $TASK)" # guard:f-name
  [ -z "$INTO" ] || die "--into 는 자식 작업에만 — 묶음 브랜치($TASK)와 함께 쓰지 않는다" # guard:f-into
  FWT="$(cd "$REPO" && pwd -P)/.claude/worktrees/${TASK#feature/}"
  here="$(pwd -P)"
  case "$here/" in "$FWT/"*) die "feature worktree 안에서 실행 금지 — 본체 경로에서 본체의 스크립트로 실행" ;; esac # guard:f-cwd
  cd "$REPO"
  git fetch -q --prune origin || die "git fetch 실패"

  # 1. PR·보존 위치
  PR="$(gh pr list --head "$TASK" --state all --json number,state,baseRefName --jq 'sort_by(.number) | last | if . == null then "" else "\(.number) \(.state) \(.baseRefName)" end')" \
    || die "gh pr list 실패"
  [ -n "$PR" ] || die "$TASK 의 PR 이 없다 — 먼저 scripts/task-pr.sh $TASK" # guard:f-nopr
  set -- $PR; PR_NUM="$1"; PR_STATE="$2"; PR_BASE="$3"
  case "$PR_STATE" in
    OPEN) KEEP="origin/$TASK"
          git rev-parse --verify -q "refs/remotes/$KEEP" >/dev/null || die "PR #$PR_NUM 이 열려 있는데 원격 $TASK 가 없다" ;;
    MERGED) KEEP="origin/$PR_BASE"
          git rev-parse --verify -q "refs/remotes/$KEEP" >/dev/null || die "PR #$PR_NUM base 원격 $PR_BASE 가 없다" ;;
    *) die "$TASK 의 PR #$PR_NUM 상태가 $PR_STATE — 열림·머지만 정리한다" ;; # guard:f-state
  esac
  if has_local "$TASK"; then
    LOID="$(git rev-parse "refs/heads/$TASK")"
    git merge-base --is-ancestor "$LOID" "$KEEP" || die "로컬 $TASK 에 $KEEP 에 없는 커밋이 있다 — push(task-pr.sh) 뒤 다시" # guard:f-ahead
  fi
  # 원격 feature 유무는 방금 fetch --prune 한 추적 ref 로 본다(ls-remote 조회 실패를 「없음」으로 읽지 않게)
  ROID="$(git rev-parse --verify -q "refs/remotes/origin/$TASK" || true)"
  if [ "$PR_STATE" = MERGED ] && [ -n "$ROID" ]; then
    git merge-base --is-ancestor "$ROID" "$KEEP" || die "원격 $TASK 가 $KEEP 에 다 들어 있지 않다 — 지우지 않는다, 수동 확인" # guard:f-remote-ahead
  fi
  note "$TASK 보존 위치: $KEEP (PR #$PR_NUM $PR_STATE → $PR_BASE)"

  # 2. feature worktree — 기대 경로 + 그 브랜치를 체크아웃한 worktree 전부. 실행 위치가 그 안이 아니고, 본체 checkout 이 아니고,
  #    깨끗해야 한다(미추적 포함), specs/ 파일이 없어야 한다
  wt_list="$(git worktree list --porcelain | awk -v b="refs/heads/$TASK" '
    /^worktree /{w=substr($0,10)} /^branch /{if (substr($0,8)==b) print w}' ; [ ! -d "$FWT" ] || echo "$FWT")"
  wt_list="$(echo "$wt_list" | awk 'NF && !seen[$0]++')"
  while IFS= read -r w; do
    [ -n "$w" ] || continue
    [ "$(cd "$w" 2>/dev/null && pwd -P)" != "$(pwd -P)" ] || die "$TASK 가 본체 checkout 에 체크아웃돼 있다 — 본체를 main 으로 돌린 뒤 다시" # guard:f-main
    case "$here/" in "$w/"*) die "$TASK 를 체크아웃한 worktree($w) 안에서 실행 금지 — 본체 경로에서 실행" ;; esac # guard:f-cwd-wt
    [ -z "$(git -C "$w" status --porcelain)" ] || die "$w 에 미커밋 변경·미추적 파일 — feature 에 커밋·push 하거나 치운 뒤 다시" # guard:f-dirty
    [ -d "$w/specs" ] && [ -n "$(find "$w/specs" -type f -print -quit)" ] \
      && die "$w/specs 에 파일이 있다 — corral-specs 작업 폴더로 옮긴 뒤 비우고 다시(worktree 와 함께 지워진다)" # guard:f-specs
  done <<EOF2
$wt_list
EOF2

  # 3. 남은 자식(위 머리 주석의 ⓐⓑ) — worktree 가 있으면(--into 미처리) 멈추고, worktree 없는 자식 브랜치는 보존 위치에 다 들어 있어야 한다
  FT="$ROID"; [ -n "$FT" ] || FT="$LOID"
  u=""; [ -z "$FT" ] || u="$(git rev-list --reverse "origin/$PR_BASE..$FT" 2>/dev/null | awk 'NR==1')"
  kids=""
  while read -r b up; do
    case "$b" in "$TASK"|main|"$PR_BASE"|release/*|feature/*) continue ;; esac
    if [ "$up" = "refs/remotes/origin/$TASK" ] || { [ -n "$u" ] && git merge-base --is-ancestor "$u" "$b"; }; then kids="$kids $b"; fi
  done < <(git for-each-ref refs/heads --format='%(refname:short) %(upstream)')
  # 브랜치 없는(detached) worktree 가 feature 고유 커밋을 품으면 자식 작업일 수 있다
  if [ -n "$u" ]; then
    while read -r h w; do
      git merge-base --is-ancestor "$u" "$h" 2>/dev/null \
        && die "브랜치 없는 worktree 가 $TASK 의 커밋을 품고 있다: $w — 자식 작업이면 feature 에 넣고 치운 뒤 다시" # guard:f-child-detached
    done < <(git worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^HEAD /{h=substr($0,6)} /^detached/{print h, w}')
  fi
  for k in $kids; do
    while read -r b w; do
      case "$b" in "$k"|"$k"-*) die "자식 worktree 가 남아 있다: $w ($b) — 자식 코디가 task-finish.sh $k --into $TASK 로 넣은 뒤 다시" ;; esac # guard:f-child-wt
    done < <(git worktree list --porcelain | awk '/^worktree /{w=substr($0,10)} /^branch refs\/heads\//{print substr($0,19), w}')
    git merge-base --is-ancestor "$k" "$KEEP" \
      || die "자식 브랜치 $k 가 $KEEP 에 다 들어 있지 않다 — 자식이면 task-finish.sh $k --into $TASK 로 넣고, throwaway(integration/…)면 지운 뒤 다시" # guard:f-child-branch
    note "자식 브랜치 $k 가 남아 있다(이미 $KEEP 에 들어 있음) — 지우지 않는다, 필요하면 task-finish.sh $k --into $TASK"
  done

  # 4. 정리 — 검사를 다 통과한 뒤에만. git worktree remove 는 --force 없이(그새 더러워졌으면 git 이 거절한다)
  while IFS= read -r w; do
    [ -n "$w" ] && [ -d "$w" ] || continue
    git worktree remove "$w" || die "worktree 제거 실패: $w — 원인을 본 뒤 다시(멱등)" # guard:f-wt-remove
    note "worktree 제거: $w"; did=1
  done <<EOF2
$wt_list
EOF2
  git worktree prune
  if [ -n "$LOID" ]; then
    git update-ref -d "refs/heads/$TASK" "$LOID" || die "로컬 $TASK 삭제 실패 — 검사 뒤 움직였을 수 있다, 다시 실행" # guard:f-cas
    note "브랜치 삭제: $TASK (보존 위치 $KEEP)"; did=1
  fi
  # 출고(머지) 뒤에는 원격 feature 도 필요 없다 — release.sh ship 이 대개 먼저 지운다. 열린 PR 이면 head 라 남긴다
  if [ "$PR_STATE" = MERGED ] && [ -n "$ROID" ]; then
    git push -q --force-with-lease="refs/heads/$TASK:$ROID" origin ":refs/heads/$TASK" || die "원격 브랜치 $TASK 삭제 실패" # guard:f-remote-del
    note "원격 브랜치 삭제: $TASK"; did=1
  fi

  [ "$did" = 1 ] || note "정리할 것 없음 — 이미 정리됨"
  echo "✔ $TASK 정리 완료 — 보존 위치 $KEEP"
  if [ "$PR_STATE" = OPEN ]; then
    echo "□ 다음: 출고 대기(열린 PR #$PR_NUM). 묶음 코디는 여기서 끝 — 출고 중 수정이 필요하면 본체가 feature worktree 를 다시 열고 묶음 코디를 재기동한다(bundle.md 6). LA 는 그대로"
  else
    echo "□ 다음: 출고된 묶음의 남은 로컬 정리 끝. LA 전이는 release §7 1번"
  fi
}
case "$TASK" in feature/*) finish_feature; exit 0 ;; esac

# 0. 안전 확인
case "$PWD/" in "$WT/$TASK"*) die "작업 worktree 안에서 실행 금지 — 본체나 다른 위치에서 실행" ;; esac
cd "$REPO"
git fetch -q --prune origin
if [ -d "$WT/$TASK" ]; then
  [ -z "$(git -C "$WT/$TASK" status --porcelain)" ] || die "작업 worktree 에 미커밋 변경 — 먼저 커밋(인계 문서 포함)"
fi
# 산출물은 corral-specs 에만 둔다(LIFE-705). worktree 안 specs/ 는 .gitignore 라 status 에 안 보이는데, 옛 측정 스크립트의
# 기본 출력 경로가 거기라 원자료가 남을 수 있다 — worktree 를 지우기 전에 멈춰서 옮기게 한다
for w in "$WT/$TASK" "$WT/$TASK"-*; do
  [ -d "$w/specs" ] && [ -n "$(find "$w/specs" -type f -print -quit)" ] \
    && die "$w/specs 에 파일이 있다 — corral-specs 작업 폴더로 옮긴 뒤 비우고 다시(worktree 와 함께 지워진다)"
done

# 1. 작업 브랜치가 어디에 보존됐는지 확인 — 그 기준(KEEP)으로 변형 브랜치를 검사한다
if [ -n "$INTO" ]; then
  # 묶음 자식: feature 에 로컬 merge → push (임시 worktree, rebase 금지)
  # feature 브랜치만 받는다 — main 등을 주면 PR 없이 main 에 직접 merge·push 하게 된다(main 반영은 release.sh 의 PR 머지로만)
  case "$INTO" in feature/LIFE-*) ;; *) die "--into 는 feature/LIFE-NNN-<슬러그> 만 받는다 (받은 값: $INTO)" ;; esac
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
  elif has_local "$TASK"; then
    note "$TASK 는 이미 $INTO 에 들어 있음"
  elif git rev-parse --verify -q "refs/remotes/origin/$TASK" >/dev/null; then
    git merge-base --is-ancestor "origin/$TASK" "origin/$INTO" \
      || die "로컬 $TASK 가 없고 origin/$TASK 는 $INTO 에 들어 있지 않다 — 원격 브랜치를 받아(git branch $TASK origin/$TASK) 다시"
    note "로컬 $TASK 없음 — origin/$TASK 는 이미 $INTO 에 들어 있음"
  else
    note "로컬·원격 $TASK 모두 없음 — $INTO 에 넣을 것이 없다(이미 정리됨)"
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
#    원격 throwaway 사본(-claude 등 검증용으로 push 한 것)도 지운다
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
