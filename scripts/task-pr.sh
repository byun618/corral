#!/usr/bin/env bash
# task-pr.sh <브랜치> [--base <base>] [--title <제목>] [--verdict <레포 상대경로>] [--draft]
# 게이트 ② 출고 승인 = PR 생성 (LIFE-574). 머지는 하지 않는다 — 머지는 출고 때 scripts/release.sh 만 한다.
#   <브랜치>  작업 브랜치 LIFE-NNN-<슬러그> 또는 묶음 브랜치 feature/LIFE-NNN-<슬러그>
#   --base    PR 대상. 기본 main. 출고 리허설은 throwaway base 를 준다
#   --verdict 판정문 경로. 기본 specs/<브랜치에서 feature/ 를 뗀 이름>/verdict.md
#   --draft   draft 로 연다 (검증용 PR)
# 흐름은 life-assistant issue-merge Phase 0~2 모양: 상태 파악 → 미커밋 거절 → push -u → 같은 head 의 열린 PR 재사용/없으면 생성.
# 멱등 — 다시 돌리면 같은 PR 의 본문만 갱신하고 PR 을 하나 더 만들지 않는다. 본체 밖 어디서 실행해도 된다.
set -euo pipefail

die() { echo "✖ $1" >&2; exit 1; }
note() { echo "· $1"; }

HEAD_BRANCH=""; BASE="main"; TITLE=""; VERDICT=""; DRAFT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --title) TITLE="${2:?--title 값 없음}"; shift 2 ;;
    --verdict) VERDICT="${2:?--verdict 값 없음}"; shift 2 ;;
    --draft) DRAFT=1; shift ;;
    -*) die "모르는 옵션: $1" ;;
    *) [ -z "$HEAD_BRANCH" ] || die "브랜치는 하나만"; HEAD_BRANCH="$1"; shift ;;
  esac
done
[ -n "$HEAD_BRANCH" ] || die "사용법: task-pr.sh <LIFE-NNN-슬러그|feature/LIFE-NNN-슬러그> [--base main] [--title …] [--verdict …] [--draft]"
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
LIFE="$(echo "$SPEC_ID" | grep -oE '^LIFE-[0-9]+' || true)"
[ -n "$LIFE" ] || die "브랜치 이름에서 LIFE 번호를 못 찾음: $HEAD_BRANCH"
[ -n "$VERDICT" ] || VERDICT="specs/$SPEC_ID/verdict.md"

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

# 1. push -u (이미 push 됐으면 delta 만)
git -C "$REPO" push -u origin "$HEAD_BRANCH"
[ "$(git -C "$REPO" rev-parse "$HEAD_BRANCH")" = "$(git -C "$REPO" rev-parse "origin/$HEAD_BRANCH")" ] || die "push 뒤 원격과 로컬이 다르다"

# 2. 본문 — 판정문 링크·판정표 요약·서명. 진실의 원천은 specs 이고 본문은 요약이다
SLUG="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
VERDICT_TEXT="$(git -C "$REPO" show "$HEAD_BRANCH:$VERDICT")"
if [ -z "$TITLE" ]; then
  TITLE="$(awk '/^# /{ sub(/^# */, ""); print; exit }' <<<"$VERDICT_TEXT")"   # 파이프 없이 — 일찍 끝나도 SIGPIPE 없음
  [ -n "$TITLE" ] || TITLE="$SPEC_ID"
fi
case "$TITLE" in *"$LIFE"*) ;; *) TITLE="$LIFE: $TITLE" ;; esac
# 판정표 = "| 항목 |" 으로 시작하는 머리줄부터 이어지는 표 줄들 (첫 표 하나)
TABLE="$(awk '/^\| *항목 *\|/{on=1} on&&/^\|/{print; next} on{exit}' <<<"$VERDICT_TEXT")"
[ -n "$TABLE" ] || TABLE="(판정표를 찾지 못함 — 판정문 원문을 본다)"
BODY_FILE="$(mktemp)"; trap 'rm -f "$BODY_FILE"' EXIT
{
  echo "## $LIFE 출고 대기"
  echo
  echo "- 판정문: [\`$VERDICT\`](https://github.com/$SLUG/blob/$HEAD_BRANCH/$VERDICT) — 진실의 원천은 specs 이고 이 본문은 요약이다"
  echo "- head \`$HEAD_BRANCH\` @ \`$(git -C "$REPO" rev-parse --short "$HEAD_BRANCH")\` → base \`$BASE\`"
  echo "- 머지는 출고 때 \`scripts/release.sh\` 로만 한다(merge commit, 지정 순서). PR CI 는 아직 없다(LIFE-575) — 검증 근거는 판정문. 웹 UI 머지·squash 금지"
  echo
  echo "### 판정표"
  echo
  printf '%s\n' "$TABLE"
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
