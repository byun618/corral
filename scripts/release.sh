#!/usr/bin/env bash
# release.sh --prs "<번호> <번호> …" [--base main] [--tag-prefix v] [--bump patch|minor|major | --version X.Y.Z] [--skip-build]
# 출고 (LIFE-574) — 사용자가 고른 PR 을 그 순서대로 머지하고, 버전 올림 커밋 + 태그 <접두>X.Y.Z 를 push 한 뒤
# 그 태그 위 깨끗한 트리에서 dmg 를 빌드한다. 출고 머지는 이 스크립트 한 경로로만 한다(웹 UI 머지 금지).
#
# **검사 없이 순서 머지다** (범위 변경 r1, 2026-10-08). PR CI 는 아직 없다 — 후속 일감 LIFE-575(맥미니 self-hosted 러너).
# 브랜치 보호(required check)도 Free 플랜 private 레포에서 쓸 수 없다(403). 검증은 작업 플로우의 리뷰·관문이 한다.
#
# 0) 머지 전에 고른 PR 전부를 본다 — 닫힘·draft·포크·base 불일치가 하나라도 있으면 아무것도 머지하지 않는다(exit 2).
#    이미 머지된 PR 은 건너뛴다 — 중간에 멈추면 같은 명령을 다시 돌리면 된다
# PR 마다:
#   1) GitHub 의 머지 가능 판정(mergeable)을 본다 — 앞 PR 머지로 충돌이 생겼으면(CONFLICTING) 거기서 멈추고
#      그 PR 과 뒤 PR 은 머지하지 않는다(exit 3). 판정이 끝내 안 나오면 멈춘다(exit 5)
#   2) gh pr merge --merge --match-head-commit <본 SHA> — 본 뒤 head 가 바뀌었으면 GitHub 가 거절한다(exit 6). 검사가 아니라 안전장치다
#   3) 머지 커밋 부모 2개 확인(squash·rebase 아님), 원격 head 브랜치 삭제
# 남은 PR 에 base 를 합쳐 push 하지 않는다 — CI 가 없어 다시 돌릴 것이 없고, 남의 작업 브랜치를 건드리지 않는다.
# 충돌은 그 작업 브랜치에서 base 를 merge(rebase 금지)해 풀고 push 한 뒤 남은 PR 로 다시 돌린다.
# 리허설은 --base throwaway/… --tag-prefix rehearsal-574-v 로 main·v 태그를 건드리지 않고 돌린다.
set -euo pipefail

die() { local code="${2:-1}"; echo "✖ $1" >&2; exit "$code"; }
note() { echo "· $1"; }

PRS=""; BASE="main"; PREFIX="v"; BUMP="patch"; VERSION=""; SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prs) PRS="${2:?--prs 값 없음}"; shift 2 ;;
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --bump) BUMP="${2:?--bump 값 없음}"; shift 2 ;;
    --version) VERSION="${2:?--version 값 없음}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) die "모르는 인자: $1" ;;
  esac
done
PRS="$(echo "$PRS" | tr ',' ' ')"
[ -n "$(echo "$PRS" | tr -d ' ')" ] || die "사용법: release.sh --prs \"12 15\" [--base main] [--tag-prefix v] [--bump patch|minor|major|--version X.Y.Z]"
for n in $PRS; do case "$n" in *[!0-9]*) die "PR 번호가 아님: $n" ;; esac; done
case "$BUMP" in patch|minor|major) ;; *) die "--bump 는 patch|minor|major" ;; esac
[ -z "$VERSION" ] || echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version 은 X.Y.Z"

# 레포 = 본체 checkout. 작업 worktree 의 사본이나 `git show … > 파일` 로 꺼낸 사본으로 돌려도 본체를 가리키게
# 스크립트 위치(없으면 cwd)의 git 공통 디렉터리에서 역산한다
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --path-format=absolute --git-common-dir)" \
  || { echo "✖ git 레포 안에서 실행한다" >&2; exit 1; }
REPO="$(dirname "$COMMON")"
cd "$REPO"
git fetch -q --tags origin
git rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null || die "원격 base 없음: origin/$BASE"

# 0. 사전 확인 — 모든 PR 이 열려 있고(이미 머지된 것은 건너뜀) base 가 맞고 draft·포크가 아니다. 하나라도 어긋나면 머지 0건
TODO=""
for n in $PRS; do
  info="$(gh pr view "$n" --json state,baseRefName,headRefName,isDraft,isCrossRepository --jq '"\(.state) \(.baseRefName) \(.headRefName) \(.isDraft) \(.isCrossRepository)"')" \
    || die "PR #$n 조회 실패 — 아무것도 머지하지 않음" 2
  set -- $info
  case "$1" in
    MERGED) note "PR #$n 은 이미 머지됨 — 건너뜀"; continue ;;
    OPEN) ;;
    *) die "PR #$n 상태가 $1 — 열린 PR 만 출고한다 — 아무것도 머지하지 않음" 2 ;;
  esac
  [ "$2" = "$BASE" ] || die "PR #$n 의 base 가 $2 — 요청 base $BASE 와 다르다 — 아무것도 머지하지 않음" 2
  [ "$4" = "false" ] || die "PR #$n 은 draft — ready 로 바꾼 뒤 다시 — 아무것도 머지하지 않음" 2
  [ "$5" = "false" ] || die "PR #$n 은 포크 PR — 출고 대상 아님 — 아무것도 머지하지 않음" 2
  TODO="$TODO $n"
done

# 임시 worktree — 본체 checkout 을 건드리지 않고 버전 커밋·빌드를 한다
TMPWT="$REPO/.claude/worktrees/_release-$(date +%Y%m%d-%H%M%S)"
cleanup() { [ -d "$TMPWT" ] && git -C "$REPO" worktree remove --force "$TMPWT" >/dev/null 2>&1; git -C "$REPO" worktree prune; }
trap cleanup EXIT
git worktree add -q --detach "$TMPWT" "origin/$BASE"

# GitHub 머지 가능 판정 — UNKNOWN 이면 계산될 때까지 잠시 기다린다(앞 PR 머지 직후 흔하다)
mergeable_state() {
  local n="$1" st=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    st="$(gh pr view "$n" --json mergeable --jq .mergeable)"
    [ "$st" != "UNKNOWN" ] && break
    sleep 3
  done
  echo "$st"
}

MERGED_LIST=""
for n in $TODO; do
  head="$(gh pr view "$n" --json headRefName --jq .headRefName)"
  sha="$(gh pr view "$n" --json headRefOid --jq .headRefOid)"

  # 1. 머지 가능 판정 — 앞 PR 머지로 충돌이 생겼으면 여기서 멈춘다
  case "$(mergeable_state "$n")" in
    MERGEABLE) ;;
    CONFLICTING) die "PR #$n ($head) 가 $BASE 와 충돌 — 머지 안 함(이 PR 과 뒤 PR 모두). 그 작업 브랜치에 $BASE 를 merge 해 풀고 push 한 뒤 남은 PR 로 다시${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 3 ;;
    *) die "PR #$n 머지 가능 판정이 나오지 않음 — 머지 안 함. 잠시 뒤 남은 PR 로 다시${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 5 ;;
  esac

  # 2. 머지 — 본 SHA 로 고정(안전장치). head 가 바뀌었으면 GitHub 가 거절한다
  gh pr merge "$n" --merge --match-head-commit "$sha" || die "PR #$n 머지 거절 — head 가 바뀌었거나 머지 불가. PR 상태를 보고 남은 PR 로 다시${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 6
  mc="$(gh pr view "$n" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
  [ -n "$mc" ] || die "PR #$n 이 MERGED 가 아니다" 6
  git fetch -q origin "$BASE"
  parents="$(git rev-list --parents -n 1 "$mc" | wc -w | tr -d ' ')"
  [ "$parents" = "3" ] || die "PR #$n 머지 커밋 ${mc:0:7} 부모가 2개가 아니다 — squash·rebase 머지 설정 확인" 6
  note "PR #$n 머지 → ${mc:0:7} (merge commit)"
  git push -q origin --delete "$head" 2>/dev/null && note "원격 브랜치 삭제: $head" || note "원격 브랜치 $head 삭제 건너뜀(이미 없음)"
  MERGED_LIST="$MERGED_LIST #$n($head)"
done

# 3. 버전 올림 커밋 + 태그 — 태그 = <접두>X.Y.Z = app/package.json 버전
git fetch -q origin "$BASE"
# 이번에 머지한 것이 없고 base 끝이 이미 버전 커밋이면 출고할 것이 없다 — 같은 명령 재실행이 버전을 또 올리지 않게
if [ -z "$MERGED_LIST" ] && git log -1 --format=%s "origin/$BASE" | grep -q '^release: '; then
  die "머지할 PR 이 없고 $BASE 끝이 이미 버전 커밋($(git log -1 --format=%s "origin/$BASE")) — 출고할 것 없음"
fi
git -C "$TMPWT" checkout -q --detach "origin/$BASE"
CUR="$(sed -n 's/^  "version": "\([0-9.]*\)",$/\1/p' "$TMPWT/app/package.json" | head -1)"
[ -n "$CUR" ] || die "app/package.json 버전을 못 읽음"
if [ -z "$VERSION" ]; then
  IFS=. read -r MA MI PA <<EOF
$CUR
EOF
  case "$BUMP" in
    major) VERSION="$((MA + 1)).0.0" ;;
    minor) VERSION="$MA.$((MI + 1)).0" ;;
    patch) VERSION="$MA.$MI.$((PA + 1))" ;;
  esac
fi
TAG="$PREFIX$VERSION"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "태그 $TAG 가 이미 있다"
[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || die "원격에 태그 $TAG 가 이미 있다"
(cd "$TMPWT/app" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
[ "$(sed -n 's/^  "version": "\([0-9.]*\)",$/\1/p' "$TMPWT/app/package.json" | head -1)" = "$VERSION" ] || die "버전 올림 실패"
git -C "$TMPWT" add app/package.json app/package-lock.json
git -C "$TMPWT" commit -q -m "release: $TAG" -m "PR:$MERGED_LIST" -m "scripts/release.sh — base $BASE, $CUR → $VERSION"
git -C "$TMPWT" tag -a "$TAG" -m "release $TAG" -m "PR:$MERGED_LIST"
git -C "$TMPWT" push -q --atomic origin "HEAD:refs/heads/$BASE" "refs/tags/$TAG" \
  || die "버전 커밋·태그 push 실패 — $BASE 가 그새 움직였을 수 있다. 머지는 끝났다: 태그만 다시(--prs 그대로 재실행)" 7
note "버전 $CUR → $VERSION, 태그 $TAG push ($(git -C "$TMPWT" rev-parse --short HEAD))"

# 4. 본체 checkout 이 base 이고 깨끗하면 fast-forward
if [ "$(git branch --show-current)" = "$BASE" ] && [ -z "$(git status --porcelain)" ]; then
  git fetch -q origin "$BASE" && git merge -q --ff-only "origin/$BASE" && note "본체 $BASE fast-forward → $TAG"
else
  note "본체 checkout 은 $BASE 가 아니거나 미커밋이 있어 fast-forward 하지 않음"
fi

# 5. dmg — 그 태그 위 깨끗한 트리(임시 worktree)에서만. 산출물은 본체 app/dist/release/<태그>/ 로 복사(git 무시)
if [ "$SKIP_BUILD" = 1 ]; then
  note "--skip-build — dmg 는 나중에: 태그 $TAG 를 체크아웃한 깨끗한 트리에서 scripts/release-dmg.sh --tag-prefix $PREFIX"
else
  "$TMPWT/scripts/release-dmg.sh" --tag-prefix "$PREFIX" --out "$REPO/app/dist/release/$TAG"
fi

echo "✔ 출고 $TAG —$MERGED_LIST"
echo "□ 다음: ① dmg 설치(app/INSTALL.md 「설치」) ② 머지된 PR 의 LIFE 일감마다 LA '완료' 전이 ③ 남은 로컬 정리 scripts/task-finish.sh <LIFE-NNN-슬러그>"
