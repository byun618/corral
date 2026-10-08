#!/usr/bin/env bash
# release.sh --prs "<번호> <번호> …" [--base main] [--tag-prefix v] [--bump patch|minor|major | --version X.Y.Z]
#            [--ci-timeout <초>] [--workflow pr-ci.yml] [--skip-build]
# 출고 (LIFE-574) — 사용자가 고른 PR 을 그 순서대로 머지하고, 버전 올림 커밋 + 태그 <접두>X.Y.Z 를 push 한 뒤
# 그 태그 위 깨끗한 트리에서 dmg 를 빌드한다. 출고 머지는 이 스크립트 한 경로로만 한다(웹 UI 머지 금지).
#
# PR 마다:
#   1) head 에 base 가 없으면 임시 worktree 에서 base 를 head 에 **merge**(rebase 아님)해 push — 충돌이면 멈춘다(exit 3)
#   2) 그 head SHA 의 CI(workflow) 결과를 본다 — success 만 통과. failure·cancelled 는 거절(exit 4),
#      진행 중·결과 없음은 --ci-timeout 초까지 기다린 뒤 거절(exit 5). 0 이면 기다리지 않는다
#   3) gh pr merge --merge --match-head-commit <확인한 SHA> — 확인 뒤 head 가 바뀌었으면 GitHub 가 머지를 거절한다
#   4) 머지 커밋 부모 2개 확인, 원격 head 브랜치 삭제
# 이미 머지된 PR 은 건너뛴다 — 중간에 멈추면 같은 명령을 다시 돌리면 된다.
# 브랜치 보호(required check)는 Free 플랜 private 레포에서 쓸 수 없어(403) 이 스크립트의 확인이 머지 차단 수단이다(D1(a)).
# 리허설은 --base throwaway/… --tag-prefix rehearsal-574-v 로 main·v 태그를 건드리지 않고 돌린다.
set -euo pipefail

die() { local code="${2:-1}"; echo "✖ $1" >&2; exit "$code"; }
note() { echo "· $1"; }

PRS=""; BASE="main"; PREFIX="v"; BUMP="patch"; VERSION=""; CI_TIMEOUT=1800; WORKFLOW="pr-ci.yml"; SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prs) PRS="${2:?--prs 값 없음}"; shift 2 ;;
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --bump) BUMP="${2:?--bump 값 없음}"; shift 2 ;;
    --version) VERSION="${2:?--version 값 없음}"; shift 2 ;;
    --ci-timeout) CI_TIMEOUT="${2:?--ci-timeout 값 없음}"; shift 2 ;;
    --workflow) WORKFLOW="${2:?--workflow 값 없음}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) die "모르는 인자: $1" ;;
  esac
done
PRS="$(echo "$PRS" | tr ',' ' ')"
[ -n "$(echo "$PRS" | tr -d ' ')" ] || die "사용법: release.sh --prs \"12 15\" [--base main] [--tag-prefix v] [--bump patch|minor|major|--version X.Y.Z]"
for n in $PRS; do case "$n" in *[!0-9]*) die "PR 번호가 아님: $n" ;; esac; done
case "$BUMP" in patch|minor|major) ;; *) die "--bump 는 patch|minor|major" ;; esac
[ -z "$VERSION" ] || echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version 은 X.Y.Z"
case "$CI_TIMEOUT" in *[!0-9]*|"") die "--ci-timeout 은 초(정수)" ;; esac

# 레포 = 본체 checkout. 작업 worktree 의 사본이나 `git show … > 파일` 로 꺼낸 사본으로 돌려도 본체를 가리키게
# 스크립트 위치(없으면 cwd)의 git 공통 디렉터리에서 역산한다
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --path-format=absolute --git-common-dir)" \
  || { echo "✖ git 레포 안에서 실행한다" >&2; exit 1; }
REPO="$(dirname "$COMMON")"
cd "$REPO"
git fetch -q --tags origin
git rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null || die "원격 base 없음: origin/$BASE"

# 0. 사전 확인 — 모든 PR 이 열려 있고(이미 머지된 것은 건너뜀) base 가 맞고 draft·포크가 아니다
TODO=""
for n in $PRS; do
  info="$(gh pr view "$n" --json state,baseRefName,headRefName,isDraft,isCrossRepository --jq '"\(.state) \(.baseRefName) \(.headRefName) \(.isDraft) \(.isCrossRepository)"')" \
    || die "PR #$n 조회 실패"
  set -- $info
  case "$1" in
    MERGED) note "PR #$n 은 이미 머지됨 — 건너뜀"; continue ;;
    OPEN) ;;
    *) die "PR #$n 상태가 $1 — 열린 PR 만 출고한다" ;;
  esac
  [ "$2" = "$BASE" ] || die "PR #$n 의 base 가 $2 — 요청 base $BASE 와 다르다"
  [ "$4" = "false" ] || die "PR #$n 은 draft — ready 로 바꾼 뒤 다시"
  [ "$5" = "false" ] || die "PR #$n 은 포크 PR — 출고 대상 아님"
  TODO="$TODO $n"
done

# 임시 worktree — 본체 checkout 을 건드리지 않고 base 합치기·버전 커밋·빌드를 한다
TMPWT="$REPO/.claude/worktrees/_release-$(date +%Y%m%d-%H%M%S)"
cleanup() { [ -d "$TMPWT" ] && git -C "$REPO" worktree remove --force "$TMPWT" >/dev/null 2>&1; git -C "$REPO" worktree prune; }
trap cleanup EXIT
git worktree add -q --detach "$TMPWT" "origin/$BASE"

# head SHA 의 CI 결과 — 가장 최근 run 하나. 출력: "success" | "failure:<결론>" | "pending:<사유>"
ci_state() {
  local sha="$1" head="$2" line
  line="$(gh run list --workflow "$WORKFLOW" --commit "$sha" --event pull_request --limit 20 \
    --json databaseId,status,conclusion,createdAt,headBranch \
    --jq "[.[] | select(.headBranch == \"$head\")] | sort_by(.createdAt) | last | if . == null then \"\" else \"\(.databaseId) \(.status) \(.conclusion)\" end")"
  if [ -z "$line" ]; then echo "pending:결과 없음(run 0건)"; return; fi
  set -- $line
  if [ "$2" != "completed" ]; then echo "pending:run $1 $2"; return; fi
  if [ "$3" = "success" ]; then echo "success:run $1"; else echo "failure:run $1 $3"; fi
}

wait_ci() {
  local n="$1" sha="$2" head="$3" waited=0 st
  while :; do
    st="$(ci_state "$sha" "$head")"
    case "$st" in
      success:*) note "PR #$n CI ${st#success:} success @ ${sha:0:7}"; return 0 ;;
      failure:*) die "PR #$n CI 실패(${st#failure:}) @ ${sha:0:7} — 머지 안 함. 원인을 보고 고친 뒤 다시(자동 재시도 없음)" 4 ;;
    esac
    [ "$waited" -lt "$CI_TIMEOUT" ] || die "PR #$n CI 미완(${st#pending:}) @ ${sha:0:7} — ${CI_TIMEOUT}초 안에 결과가 없어 머지 안 함" 5
    sleep 20; waited=$((waited + 20))
  done
}

MERGED_LIST=""
for n in $TODO; do
  head="$(gh pr view "$n" --json headRefName --jq .headRefName)"
  git fetch -q origin "$BASE" "$head"
  sha="$(git rev-parse "origin/$head")"

  # 1. head 에 base 가 없으면 base 를 merge 해 push (rebase 금지 — 살아 있는 worktree·리뷰 근거 커밋 보존)
  if ! git merge-base --is-ancestor "origin/$BASE" "$sha"; then
    git -C "$TMPWT" checkout -q --detach "$sha"
    if ! git -C "$TMPWT" merge --no-ff --no-edit -m "Merge $BASE into $head (release.sh)" "origin/$BASE" >/dev/null 2>&1; then
      conflicts="$(git -C "$TMPWT" diff --name-only --diff-filter=U | tr '\n' ' ')"
      git -C "$TMPWT" merge --abort || true
      die "PR #$n ($head) 에 $BASE 를 합치다 충돌: $conflicts— 머지 안 함. 그 작업 브랜치에서 충돌을 풀어 push 한 뒤 남은 PR 로 다시" 3
    fi
    git -C "$TMPWT" push -q origin "HEAD:refs/heads/$head"
    sha="$(git -C "$TMPWT" rev-parse HEAD)"
    note "PR #$n 에 $BASE 를 merge 해 push → ${sha:0:7} (CI 재실행 대기)"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ "$(gh pr view "$n" --json headRefOid --jq .headRefOid)" = "$sha" ] && break
      sleep 3
    done
  fi

  # 2. 그 SHA 의 CI 확인
  [ "$(gh pr view "$n" --json headRefOid --jq .headRefOid)" = "$sha" ] || die "PR #$n head 가 ${sha:0:7} 가 아니다 — 누가 push 했다. 다시 돌린다" 6
  wait_ci "$n" "$sha" "$head"

  # 3. 머지 — 확인한 SHA 로 고정. head 가 바뀌었으면 GitHub 가 거절한다
  gh pr merge "$n" --merge --match-head-commit "$sha" || die "PR #$n 머지 거절 — head 가 바뀌었거나 머지 불가. PR 상태를 보고 다시" 6
  mc="$(gh pr view "$n" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')"
  [ -n "$mc" ] || die "PR #$n 이 MERGED 가 아니다" 6
  git fetch -q origin "$BASE"
  parents="$(git rev-list --parents -n 1 "$mc" | wc -w | tr -d ' ')"
  [ "$parents" = "3" ] || die "PR #$n 머지 커밋 ${mc:0:7} 부모가 2개가 아니다 — squash·rebase 머지 설정 확인" 6
  note "PR #$n 머지 → ${mc:0:7} (merge commit)"
  git push -q origin --delete "$head" 2>/dev/null && note "원격 브랜치 삭제: $head" || note "원격 브랜치 $head 삭제 건너뜀(이미 없음)"
  MERGED_LIST="$MERGED_LIST #$n($head)"
done

# 4. 버전 올림 커밋 + 태그 — 태그 = <접두>X.Y.Z = app/package.json 버전
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

# 5. 본체 checkout 이 base 이고 깨끗하면 fast-forward
if [ "$(git branch --show-current)" = "$BASE" ] && [ -z "$(git status --porcelain)" ]; then
  git fetch -q origin "$BASE" && git merge -q --ff-only "origin/$BASE" && note "본체 $BASE fast-forward → $TAG"
else
  note "본체 checkout 은 $BASE 가 아니거나 미커밋이 있어 fast-forward 하지 않음"
fi

# 6. dmg — 그 태그 위 깨끗한 트리(임시 worktree)에서만. 산출물은 본체 app/dist/release/<태그>/ 로 복사(git 무시)
if [ "$SKIP_BUILD" = 1 ]; then
  note "--skip-build — dmg 는 나중에: 태그 $TAG 를 체크아웃한 깨끗한 트리에서 scripts/release-dmg.sh --tag-prefix $PREFIX"
else
  "$TMPWT/scripts/release-dmg.sh" --tag-prefix "$PREFIX" --out "$REPO/app/dist/release/$TAG"
fi

echo "✔ 출고 $TAG —$MERGED_LIST"
echo "□ 다음: ① dmg 설치(app/INSTALL.md 「설치」) ② 머지된 PR 의 LIFE 일감마다 LA '완료' 전이 ③ 남은 로컬 정리 scripts/task-finish.sh <LIFE-NNN-슬러그>"
