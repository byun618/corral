#!/usr/bin/env bash
# task-pr.sh <브랜치> [--base <base>] [--pr <레포 상대경로>] [--verdict <레포 상대경로>] [--draft]
# 게이트 ② 출고 승인 = PR 생성 (LIFE-574). 머지는 하지 않는다 — 머지는 출고 때 scripts/release.sh 만 한다.
#   <브랜치>  작업 브랜치 LIFE-NNN-<슬러그> 또는 묶음 브랜치 feature/LIFE-NNN-<슬러그>
#   --base    PR 대상. 기본 main. 출고 리허설은 throwaway base 를 준다
#   --pr      PR 원고. 기본 specs/<브랜치에서 feature/ 를 뗀 이름>/pr.md — 코디네이터가 쓰고 브랜치에 커밋한다.
#             첫 줄 `# <제목>` = PR 제목, 나머지 = 본문. 스크립트는 판정문 링크·head/base·서명만 덧붙인다
#   --verdict 판정문 경로. 기본 specs/<…>/verdict.md (존재 확인·링크용)
#   --draft   draft 로 연다 (검증용 PR)
# 흐름은 life-assistant issue-merge Phase 0~2 모양: 상태 파악 → 미커밋 거절 → push -u → 같은 head 의 열린 PR 재사용/없으면 생성.
# 멱등 — 다시 돌리면 같은 PR 의 본문만 갱신하고 PR 을 하나 더 만들지 않는다. 본체 밖 어디서 실행해도 된다.
set -euo pipefail

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

HEAD_BRANCH=""; BASE="main"; PR_DOC=""; VERDICT=""; DRAFT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --pr) PR_DOC="${2:?--pr 값 없음}"; shift 2 ;;
    --verdict) VERDICT="${2:?--verdict 값 없음}"; shift 2 ;;
    --draft) DRAFT=1; shift ;;
    -*) die "모르는 옵션: $1" ;;
    *) [ -z "$HEAD_BRANCH" ] || die "브랜치는 하나만"; HEAD_BRANCH="$1"; shift ;;
  esac
done
[ -n "$HEAD_BRANCH" ] || die "사용법: task-pr.sh <LIFE-NNN-슬러그|feature/LIFE-NNN-슬러그> [--base main] [--pr …] [--verdict …] [--draft]"
[ "$HEAD_BRANCH" != "$BASE" ] || die "head 와 base 가 같다: $BASE"
[ "$HEAD_BRANCH" != "main" ] || die "main 은 head 가 될 수 없다"

# 레포 = 본체 checkout. 작업 worktree 의 사본이나 `git show … > 파일` 로 꺼낸 사본으로 돌려도 본체를 가리키게
# 스크립트 위치(없으면 cwd)의 git 공통 디렉터리에서 역산한다
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --path-format=absolute --git-common-dir)" \
  || { echo "✖ git 레포 안에서 실행한다" >&2; exit 1; }
REPO="$(dirname "$COMMON")"
cd "$REPO"   # gh 가 이 레포를 보게
SPEC_ID="${HEAD_BRANCH#feature/}"
# LIFE 번호 — 이름 어디에 있든 첫 것(리허설 throwaway/LIFE-574-… 도 받는다). 파이프 없이 한 프로세스
LIFE="$(awk 'match($0, /LIFE-[0-9]+/) { print substr($0, RSTART, RLENGTH) }' <<<"$SPEC_ID")"
[ -n "$LIFE" ] || die "브랜치 이름에서 LIFE 번호를 못 찾음: $HEAD_BRANCH"
[ -n "$VERDICT" ] || VERDICT="specs/$SPEC_ID/verdict.md"
[ -n "$PR_DOC" ] || PR_DOC="specs/$SPEC_ID/pr.md"

# 0. 상태 파악 — 브랜치·미커밋·판정문
git -C "$REPO" fetch -q origin
git -C "$REPO" rev-parse --verify -q "refs/heads/$HEAD_BRANCH" >/dev/null || die "로컬 브랜치 없음: $HEAD_BRANCH"
git -C "$REPO" rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null || die "원격 base 없음: origin/$BASE"
WT_PATH="$(git -C "$REPO" worktree list --porcelain | awk -v b="branch refs/heads/$HEAD_BRANCH" '/^worktree /{p=substr($0,10)} $0==b{print p}')"
if [ -n "$WT_PATH" ]; then
  [ -z "$(git -C "$WT_PATH" status --porcelain)" ] || die "미커밋 변경 있음: $WT_PATH — 커밋한 뒤 다시"
fi
git -C "$REPO" cat-file -e "$HEAD_BRANCH:$VERDICT" 2>/dev/null || die "판정문 없음: $HEAD_BRANCH:$VERDICT"
[ -n "$(git -C "$REPO" log --oneline "origin/$BASE..$HEAD_BRANCH")" ] || die "$BASE 에 없는 커밋이 없다 — 이미 반영됐거나 빈 브랜치"

# PR 원고 — 코디네이터가 diff·specs 를 읽고 쓴 제목·본문. 기계적으로 뽑지 않는다. 없으면 push 전에 멈춘다
PR_TEXT="$(git -C "$REPO" show "$HEAD_BRANCH:$PR_DOC" 2>/dev/null)" \
  || die "PR 원고 없음: $HEAD_BRANCH:$PR_DOC — 첫 줄 '# <제목>', 이어서 본문을 쓰고 커밋한 뒤 다시"
TITLE="$(awk 'NF{ if (sub(/^# +/, "")) print; exit }' <<<"$PR_TEXT")"
[ -n "$TITLE" ] || die "PR 원고 첫 줄이 '# <제목>' 이 아니다: $PR_DOC"
BODY="$(awk 'done{print; next} NF{done=1}' <<<"$PR_TEXT")"
[ -n "$(tr -d '[:space:]' <<<"$BODY")" ] || die "PR 원고에 본문이 없다: $PR_DOC"

# 1. push -u (이미 push 됐으면 delta 만)
git -C "$REPO" push -u origin "$HEAD_BRANCH"
[ "$(git -C "$REPO" rev-parse "$HEAD_BRANCH")" = "$(git -C "$REPO" rev-parse "origin/$HEAD_BRANCH")" ] || die "push 뒤 원격과 로컬이 다르다"

# 2. 본문 — 원고 그대로 + 판정문 링크·head/base·서명
SLUG="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
case "$TITLE" in *"$LIFE"*) ;; *) TITLE="$LIFE: $TITLE" ;; esac
BODY_FILE="$(mktemp)"; trap 'rm -f "$BODY_FILE"' EXIT
{
  printf '%s\n' "$BODY"
  echo
  echo "---"
  echo
  echo "- 판정문: [\`$VERDICT\`](https://github.com/$SLUG/blob/$HEAD_BRANCH/$VERDICT)"
  echo "- head \`$HEAD_BRANCH\` @ \`$(git -C "$REPO" rev-parse --short "$HEAD_BRANCH")\` → base \`$BASE\` — 머지는 출고 때 \`scripts/release.sh\` 로만 한다"
  echo
  echo "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
} > "$BODY_FILE"

# 3. 같은 head 의 열린 PR 재사용, 없으면 생성
EXISTING="$(gh pr list --head "$HEAD_BRANCH" --state open --json number,baseRefName --jq '.[] | "\(.number) \(.baseRefName)"')"
if [ -n "$EXISTING" ]; then
  [ "$(printf '%s\n' "$EXISTING" | wc -l | tr -d ' ')" = "1" ] || die "같은 head 의 열린 PR 이 여럿: $EXISTING"
  NUM="${EXISTING%% *}"; EXISTING_BASE="${EXISTING#* }"
  [ "$EXISTING_BASE" = "$BASE" ] || die "열린 PR #$NUM 의 base 가 $EXISTING_BASE — 요청 base $BASE 와 다르다"
  gh pr edit "$NUM" --title "$TITLE" --body-file "$BODY_FILE" >/dev/null
  note "기존 PR #$NUM 재사용 (제목·본문 갱신)"
else
  DRAFT_FLAG=""; [ "$DRAFT" = 1 ] && DRAFT_FLAG="--draft"
  gh pr create --base "$BASE" --head "$HEAD_BRANCH" --title "$TITLE" --body-file "$BODY_FILE" $DRAFT_FLAG >/dev/null
  NUM="$(gh pr list --head "$HEAD_BRANCH" --state open --json number --jq '.[0].number')"
  note "PR #$NUM 생성"
fi

echo "✔ $HEAD_BRANCH → $BASE : $(gh pr view "$NUM" --json url --jq .url)"
case "$HEAD_BRANCH" in
  feature/*) echo "□ 다음: 묶음 PR — 남은 자식 worktree 가 있으면 각 자식을 task-finish.sh <자식> --into $HEAD_BRANCH 로 먼저 넣었는지 확인. 머지·태그·dmg 는 출고 때 scripts/release.sh" ;;
  *) echo "□ 다음: 작업 정리는 scripts/task-finish.sh $HEAD_BRANCH (작업 worktree 밖에서). 머지·태그·dmg 는 출고 때 scripts/release.sh" ;;
esac
