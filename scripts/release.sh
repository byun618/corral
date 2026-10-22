#!/usr/bin/env bash
# release.sh --prs "<번호> <번호> …" --notes <릴리즈 노트 파일> [--bump patch|minor|major | --version X.Y.Z] [--skip-build] [--skip-apk] [--dry-run]
#            [--base throwaway/<이름> --tag-prefix rehearsal-<이름>-v]   ← 리허설. 둘은 짝으로만 받는다
# 출고 (LIFE-574) — 사용자가 고른 PR 을 그 순서대로 머지하고, 버전 올림 커밋 + 태그 <접두>X.Y.Z 를 push 한 뒤
# 그 태그 위 깨끗한 트리에서 dmg 와 모바일 APK 를 빌드한다(LIFE-599). 출고 머지는 이 스크립트 한 경로로만 한다(웹 UI 머지 금지).
# --skip-build 는 dmg 만, --skip-apk 는 APK 만 건너뛴다 — 둘 다 빼려면 둘 다 준다.
#
# **검사 없이 순서 머지다** (범위 변경 r1, 2026-10-08). PR CI 는 아직 없다 — 후속 일감 LIFE-575(맥미니 self-hosted 러너).
# 브랜치 보호(required check)도 Free 플랜 private 레포에서 쓸 수 없다(403). 검증은 작업 플로우의 리뷰·관문이 한다.
#
# 0) 머지 전에 고른 PR 전부를 본다 — 닫힘·draft·포크·base 불일치가 하나라도 있으면 아무것도 머지하지 않는다(exit 2).
#    이때 각 PR 의 head SHA 를 고정한다. 이미 머지된 PR 은 건너뛴다 — 중간에 멈추면 같은 명령을 다시 돌리면 된다.
#    APK 를 만들 거면 그 툴체인 전제(JDK·Android SDK·eas 로그인·작업 폴더)도 여기서 본다(release-apk.sh --preflight) — 미달이면 머지 0건(exit 2).
#    --dry-run 은 여기까지 보고 대상 PR·순서·head·다음 버전·태그·dmg·APK 계획을 출력하고 끝난다(머지·커밋·push 0건)
# PR 마다:
#   1) GitHub 의 머지 가능 판정(mergeable)을 본다 — 앞 PR 머지로 충돌이 생겼으면(CONFLICTING) 거기서 멈추고
#      그 PR 과 뒤 PR 은 머지하지 않는다(exit 3). 판정이 끝내 안 나오면 멈춘다(exit 5)
#   2) gh pr merge --merge --match-head-commit <0) 에서 고정한 SHA> — 그 뒤 head 가 바뀌었으면 GitHub 가 거절한다(exit 6). 검사가 아니라 안전장치다
#   3) 머지 커밋 부모 2개 확인(squash·rebase 아님), 원격 head 브랜치 삭제
# 남은 PR 에 base 를 합쳐 push 하지 않는다 — CI 가 없어 다시 돌릴 것이 없고, 남의 작업 브랜치를 건드리지 않는다.
# 충돌 해소 절차는 app/INSTALL.md 「출고」 — 원격 작업 브랜치로 worktree 를 다시 만들어 base 를 merge(rebase 금지)·push 한 뒤 다시 돌린다.
# 4) 본체 checkout fast-forward 는 release-ff.sh — index.lock 을 총 30초·0.5초 간격으로 기다린다(관측 lock 유지 최대 1.55초, LIFE-672).
#    실패해도 경고로 남고 dmg 로 간다. lock 은 지우지 않는다
# 버전 커밋·태그 push 가 실패하면(exit 7) 로컬 태그를 지우고 멈춘다 — 같은 명령 재실행이 태그만 다시 만든다.
# dmg 가 실패하면(exit 8) 머지·태그는 끝난 상태다 — 안내대로 release-dmg.sh 만 다시 돌린다(그 뒤 APK 도 — 안내에 있다).
# APK 가 실패하면(exit 10) 머지·태그·dmg 는 끝난 상태다 — 안내대로 release-apk.sh 만 다시 돌린다.
# 릴리즈 노트(--notes)는 release 스킬이 고른 PR 본문을 읽고 쓴 원고다 — 태그 push 뒤 GitHub Release 로 올린다
# (리허설은 prerelease). 실패하면(exit 9) 머지·태그는 끝난 상태다 — 안내대로 gh release create 만 다시 돌린다.
set -euo pipefail

die() { local code="${2:-1}"; echo "✖ $1" >&2; exit "$code"; }
note() { echo "· $1"; }

PRS=""; NOTES=""; BASE="main"; PREFIX="v"; BUMP="patch"; VERSION=""; SKIP_BUILD=0; SKIP_APK=0; DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prs) PRS="${2:?--prs 값 없음}"; shift 2 ;;
    --notes) NOTES="${2:?--notes 값 없음}"; shift 2 ;;
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --bump) BUMP="${2:?--bump 값 없음}"; shift 2 ;;
    --version) VERSION="${2:?--version 값 없음}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-apk) SKIP_APK=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "모르는 인자: $1" ;;
  esac
done
[ -n "$(echo "$PRS" | tr -d ' ,')" ] || die "사용법: release.sh --prs \"12 15\" --notes <파일> [--bump patch|minor|major|--version X.Y.Z] [--skip-build] [--skip-apk] [--dry-run]"
# 릴리즈 노트 — 실 실행은 필수(dry-run 은 노트를 쓰기 전 점검이라 없어도 된다). 아래에서 cd 하므로 절대경로로
if [ -n "$NOTES" ]; then
  [ -s "$NOTES" ] || die "릴리즈 노트 파일이 없거나 비었다: $NOTES"
  NOTES="$(cd "$(dirname "$NOTES")" && pwd)/$(basename "$NOTES")"
elif [ "$DRY_RUN" != 1 ]; then
  die "--notes <릴리즈 노트 파일> 필수 — 고른 PR 본문을 읽고 쓴다(release 스킬). 머지 전에 거절"
fi
# 번호 검사 + 중복 제거(처음 나온 순서 유지)
UNIQ=""
for n in $(echo "$PRS" | tr ',' ' '); do
  case "$n" in *[!0-9]*) die "PR 번호가 아님: $n" ;; esac
  case " $UNIQ " in *" $n "*) echo "· PR #$n 중복 — 한 번만 처리" ;; *) UNIQ="$UNIQ $n" ;; esac
done
PRS="$UNIQ"
# 실 출고(main + v) 와 리허설(throwaway/* + rehearsal-*) 만 허용 — 한쪽만 바꾸면 실 레포의 main 이나 v 태그를 칠 수 있다
case "$BASE|$PREFIX" in
  "main|v") ;;
  throwaway/*"|"rehearsal-*) ;;
  *) die "--base '$BASE' 와 --tag-prefix '$PREFIX' 짝이 맞지 않는다 — 실 출고는 둘 다 기본값(main·v), 리허설은 --base throwaway/<이름> --tag-prefix rehearsal-<이름>-v" ;;
esac
case "$BUMP" in patch|minor|major) ;; *) die "--bump 는 patch|minor|major" ;; esac
[ -z "$VERSION" ] || echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version 은 X.Y.Z"

# 레포 = 본체 checkout. 작업 worktree 의 사본이나 `git show … > 파일` 로 꺼낸 사본으로 돌려도 본체를 가리키게
# 스크립트 위치(없으면 cwd)의 git 공통 디렉터리에서 역산한다
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --path-format=absolute --git-common-dir)" \
  || { echo "✖ git 레포 안에서 실행한다" >&2; exit 1; }
REPO="$(dirname "$COMMON")"
cd "$REPO"

# ── 재실행 안내 생성 (LIFE-599) ──
# 명령은 설명과 다른 줄에 홀로, 인자는 POSIX 단일 따옴표로 인용한다(' → '\''). printf %q 는 macOS bash 3.2 에서
# 한글 경로를 깨진 UTF-8 바이트로 내보내 화면에서 복사한 명령이 돌지 않았다 — 단일 따옴표 인용은 경로 바이트를 그대로 두므로
# UTF-8 경로는 UTF-8 그대로 나온다. git -C·절대경로라 어느 cwd 에서 붙여 넣어도 돈다
shq() { local s="$1" q="'\\''"; printf "'%s'" "${s//\'/$q}"; }
NL=$'\n'
# rerun_cmds <태그> → APK_RERUN · DMG_RERUN · DMG_DONE (OUT_DIR 도 정한다)
rerun_cmds() {
  local tag="$1" wt
  OUT_DIR="$REPO/app/dist/release/$tag"
  APK_RERUN="$(shq "$SCRIPT_DIR/release-apk.sh") --from-tag $(shq "$tag") --tag-prefix $(shq "$PREFIX") --out $(shq "$OUT_DIR")"
  wt="$REPO/.claude/worktrees/_dmg-$tag-$(date +%Y%m%d-%H%M%S)"
  DMG_RERUN="git -C $(shq "$REPO") fetch origin $(shq "refs/tags/$tag:refs/tags/$tag") && git -C $(shq "$REPO") worktree add --detach $(shq "$wt") $(shq "refs/tags/$tag") && $(shq "$wt/scripts/release-dmg.sh") --tag-prefix $(shq "$PREFIX") --out $(shq "$OUT_DIR")"
  DMG_DONE="git -C $(shq "$REPO") worktree remove --force $(shq "$wt")"
}
# ── 재실행 안내 생성 끝 ──
git fetch -q --tags origin
git rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null || die "원격 base 없음: origin/$BASE"

# dmg 빌드 node — 머지(되돌릴 수 없음) 전에 본다. 기준은 release-dmg.sh 와 같다
if [ "$SKIP_BUILD" = 0 ]; then
  NODE_V="$(node -p 'process.versions.node' 2>/dev/null)" || die "node 가 없다 — dmg 빌드에 필요(--skip-build 면 생략)"
  case "$NODE_V" in 24.*) ;; 22.*) note "node $NODE_V — 로컬 관문 기준은 v24 다(경고만)" ;;
    *) die "node $NODE_V — engines(>=22.12)·로컬 관문(v24) 밖이라 dmg 빌드를 거절한다. v24 를 PATH 앞에 두거나 --skip-build" ;; esac
  # LIFE-676 — Resource Manager 메모리 도우미(app/helper/corral-footprint.c)를 npm run build 가 clang 으로 빌드한다
  command -v clang >/dev/null 2>&1 || die "clang 이 없다 — dmg 빌드(메모리 도우미)에 필요. xcode-select --install 또는 --skip-build"
fi
# APK 툴체인 전제 — 머지 전에 본다. 태그 가드는 태그가 생긴 뒤 release-apk.sh 가 본다
if [ "$SKIP_APK" = 0 ]; then
  [ -x "$SCRIPT_DIR/release-apk.sh" ] || die "scripts/release-apk.sh 가 없다 — APK 를 빼려면 --skip-apk — 아무것도 머지하지 않음" 2
  APK_PRE="$("$SCRIPT_DIR/release-apk.sh" --preflight 2>&1)" \
    || die "APK 전제 미달 — 아무것도 머지하지 않음(APK 를 빼려면 --skip-apk): $(echo "$APK_PRE" | tail -1)" 2
  APK_PRE="$(echo "$APK_PRE" | grep '^· APK 전제' | head -1 || true)"
fi

# 0. 사전 확인 — 모든 PR 이 열려 있고(이미 머지된 것은 건너뜀) base 가 맞고 draft·포크가 아니다. 하나라도 어긋나면 머지 0건.
#    head SHA 를 여기서 고정한다(PINS: "번호=SHA" 목록) — 사용자가 고른 시점의 PR 을 머지한다
TODO=""; PINS=""; SKIPPED=""
for n in $PRS; do
  info="$(gh pr view "$n" --json state,baseRefName,headRefName,isDraft,isCrossRepository,headRefOid --jq '"\(.state) \(.baseRefName) \(.headRefName) \(.isDraft) \(.isCrossRepository) \(.headRefOid)"')" \
    || die "PR #$n 조회 실패 — 아무것도 머지하지 않음" 2
  set -- $info
  case "$1" in
    MERGED) if [ "$2" = "$BASE" ]; then note "PR #$n 은 이미 $2 에 머지됨 — 건너뜀"; SKIPPED="$SKIPPED #$n($3)"
            else note "PR #$n 은 이미 머지됨(base $2 — 요청 base $BASE 와 다르다, 번호 확인) — 건너뜀"; fi
            continue ;;
    OPEN) ;;
    *) die "PR #$n 상태가 $1 — 열린 PR 만 출고한다 — 아무것도 머지하지 않음" 2 ;;
  esac
  [ "$2" = "$BASE" ] || die "PR #$n 의 base 가 $2 — 요청 base $BASE 와 다르다 — 아무것도 머지하지 않음" 2
  [ "$4" = "false" ] || die "PR #$n 은 draft — ready 로 바꾼 뒤 다시 — 아무것도 머지하지 않음" 2
  [ "$5" = "false" ] || die "PR #$n 은 포크 PR — 출고 대상 아님 — 아무것도 머지하지 않음" 2
  TODO="$TODO $n"; PINS="$PINS $n=$6"
done
pin_of() { local kv; for kv in $PINS; do [ "${kv%%=*}" = "$1" ] && { echo "${kv#*=}"; return; }; done; }

# 다음 버전 — base 끝의 app/package.json 에서. 출력: "<지금> <다음>"
next_version() {
  local cur ma mi pa
  cur="$(awk 'match($0, /^  "version": "[0-9.]+",$/) { v = $0; sub(/^  "version": "/, "", v); sub(/",$/, "", v); print v; exit }' <<J
$1
J
)"
  [ -n "$cur" ] || return 1
  if [ -n "$VERSION" ]; then echo "$cur $VERSION"; return; fi
  IFS=. read -r ma mi pa <<V
$cur
V
  case "$BUMP" in
    major) echo "$cur $((ma + 1)).0.0" ;;
    minor) echo "$cur $ma.$((mi + 1)).0" ;;
    patch) echo "$cur $ma.$mi.$((pa + 1))" ;;
  esac
}

# 다음 버전·태그를 머지 전에 본다 — --version 이 지금 이하이거나 태그가 이미 있으면 머지 0건으로 거절(exit 2)
ver_gt() { # $1 > $2 (X.Y.Z)
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<V
$1
V
  IFS=. read -r b1 b2 b3 <<V
$2
V
  [ "$a1" -gt "$b1" ] || { [ "$a1" -eq "$b1" ] && { [ "$a2" -gt "$b2" ] || { [ "$a2" -eq "$b2" ] && [ "$a3" -gt "$b3" ]; }; }; }
}
NV="$(next_version "$(git show "origin/$BASE:app/package.json")")" || die "app/package.json 버전을 못 읽음" 2
ver_gt "${NV#* }" "${NV% *}" || die "다음 버전 ${NV#* } 이 지금 버전 ${NV% *} 보다 크지 않다(--version 확인) — 아무것도 머지하지 않음" 2
[ -z "$(git ls-remote --tags origin "refs/tags/$PREFIX${NV#* }")" ] || die "원격에 태그 $PREFIX${NV#* } 가 이미 있다 — 아무것도 머지하지 않음(--version 으로 다른 버전을 주거나 태그를 확인)" 2

if [ "$DRY_RUN" = 1 ]; then
  set -- "${NV% *}" "${NV#* }"
  echo "── dry-run (머지·커밋·push 없음) ──"
  echo "base $BASE @ $(git rev-parse --short "origin/$BASE"), 태그 접두 $PREFIX"
  for n in $TODO; do echo "  머지 예정 #$n @ $(pin_of "$n" | cut -c1-7)"; done
  [ -n "$TODO" ] || echo "  머지 예정 없음"
  echo "버전 $1 → $2, 태그 $PREFIX$2 (지금 base 기준 — 머지할 PR 이 버전을 바꾸면 달라진다)"
  [ "$SKIP_BUILD" = 1 ] && echo "dmg: 건너뜀(--skip-build)" || echo "dmg: node ${NODE_V:-?} 로 빌드 예정"
  [ "$SKIP_APK" = 1 ] && echo "APK: 건너뜀(--skip-apk)" || echo "APK: 매 출고 빌드 예정(preview 로컬 빌드, dmg 뒤) — ${APK_PRE#· }"
  [ -n "$NOTES" ] && echo "릴리즈 노트: $NOTES" || echo "릴리즈 노트: 아직 없음 — 실 실행에는 --notes 필수"
  exit 0
fi

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
  sha="$(pin_of "$n")"

  # 1. 머지 가능 판정 — 앞 PR 머지로 충돌이 생겼으면 여기서 멈춘다
  case "$(mergeable_state "$n")" in
    MERGEABLE) ;;
    CONFLICTING) die "PR #$n ($head) 가 $BASE 와 충돌 — 머지 안 함(이 PR 과 뒤 PR 모두). 그 작업 브랜치에 $BASE 를 merge 해 풀고 push 한 뒤 남은 PR 로 다시${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 3 ;;
    *) die "PR #$n 머지 가능 판정이 나오지 않음 — 머지 안 함. 잠시 뒤 남은 PR 로 다시${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 5 ;;
  esac

  # 2. 머지 — 본 SHA 로 고정(안전장치). head 가 바뀌었으면 GitHub 가 거절한다
  gh pr merge "$n" --merge --match-head-commit "$sha" || die "PR #$n 머지 거절 — head 가 바뀌었거나 머지 불가. PR 상태를 보고 남은 PR 로 다시${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 6
  mc="$(gh pr view "$n" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')" \
    || die "PR #$n 머지 결과 조회 실패 — 머지는 됐을 수 있다. 같은 명령을 다시 돌리면 머지된 PR 은 건너뛴다${MERGED_LIST:+ (이미 머지:$MERGED_LIST)}" 6
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
  # 버전 커밋 제목 "release: <태그>" 의 태그는 확인될 때만 실행 명령에 넣는다 — 접두가 이번 --tag-prefix 이고
  # 원격 태그가 가리키는 커밋 = origin/$BASE 끝. 하나라도 아니거나 확인할 수 없으면 고르지 않고 직접 확인하게 한다
  LAST_SUBJ="$(git log -1 --format=%s "origin/$BASE")"
  LAST_TAG="$(echo "$LAST_SUBJ" | sed -n 's/^release: //p')"
  WHY=""
  LAST_VER=""; case "$LAST_TAG" in "$PREFIX"?*) LAST_VER="${LAST_TAG#"$PREFIX"}" ;; esac
  if ! echo "$LAST_VER" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    WHY="제목의 태그 '$LAST_TAG' 가 '$PREFIX<X.Y.Z>' 모양이 아니다"
  else
    TAG_PEELED="$(git ls-remote --tags origin "refs/tags/$LAST_TAG" "refs/tags/$LAST_TAG^{}" 2>/dev/null | awk -v t="refs/tags/$LAST_TAG" '$2 == t "^{}" {p = $1} $2 == t {l = $1} END {print (p != "" ? p : l)}')" || TAG_PEELED=""
    BASE_TIP="$(git rev-parse "origin/$BASE^{commit}")"
    [ -n "$TAG_PEELED" ] && [ "$TAG_PEELED" = "$BASE_TIP" ] \
      || WHY="원격 태그 $LAST_TAG 가 없거나(또는 조회 실패) $BASE 끝(${BASE_TIP:0:7})과 다른 커밋(${TAG_PEELED:0:7})을 가리킨다"
  fi
  if [ -n "$WHY" ]; then
    die "머지할 PR 이 없고 $BASE 끝이 이미 버전 커밋($LAST_SUBJ) — 출고할 것 없음. $WHY — 태그를 자동으로 고르지 않는다.${NL}dmg·APK 가 빠졌다면 먼저 $BASE 끝을 가리키는 태그를 직접 확인한다:${NL}git -C $(shq "$REPO") ls-remote --tags origin${NL}확인한 태그를 TAG 에 넣고 실행한다(직접 고쳐 쓰는 명령, dmg 는 app/INSTALL.md 「출고」):${NL}TAG='여기에-확인한-태그'; $(shq "$SCRIPT_DIR/release-apk.sh") --from-tag \"\$TAG\" --tag-prefix $(shq "$PREFIX")"
  fi
  rerun_cmds "$LAST_TAG"
  die "머지할 PR 이 없고 $BASE 끝이 이미 버전 커밋(release: $LAST_TAG, 원격 태그가 $BASE 끝과 같은 커밋) — 출고할 것 없음. 앞선 실행의 push 가 실제로는 반영됐는데 dmg·APK 가 없다면 아래 명령을 그대로 붙여 넣는다${NL}dmg 만:${NL}$DMG_RERUN${NL}dmg 가 끝나면 임시 worktree 정리:${NL}$DMG_DONE${NL}APK 만:${NL}$APK_RERUN"
fi
git -C "$TMPWT" checkout -q --detach "origin/$BASE"
NV="$(next_version "$(cat "$TMPWT/app/package.json")")" || die "app/package.json 버전을 못 읽음"
CUR="${NV% *}"; VERSION="${NV#* }"
TAG="$PREFIX$VERSION"
[ -z "$(git ls-remote --tags origin "refs/tags/$TAG")" ] || die "원격에 태그 $TAG 가 이미 있다"
# 원격에 없는 로컬 태그 = 앞선 실행의 push 실패가 남긴 고아(push 안 된 버전 커밋을 가리킨다) — 지우고 다시 만든다
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag -d "$TAG" >/dev/null && note "원격에 없는 로컬 태그 $TAG 삭제(앞선 push 실패 잔재)"
fi
(cd "$TMPWT/app" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
[ "$(sed -n 's/^  "version": "\([0-9.]*\)",$/\1/p' "$TMPWT/app/package.json" | head -1)" = "$VERSION" ] || die "버전 올림 실패"
git -C "$TMPWT" add app/package.json app/package-lock.json
PR_NOTE="PR:${MERGED_LIST:- (이번 실행 0건)}${SKIPPED:+ / 앞선 실행에서 머지:$SKIPPED}"
git -C "$TMPWT" commit -q -m "release: $TAG" -m "$PR_NOTE" -m "scripts/release.sh — base $BASE, $CUR → $VERSION"
git -C "$TMPWT" tag -a "$TAG" -m "release $TAG" -m "$PR_NOTE"
if ! git -C "$TMPWT" push -q --atomic origin "HEAD:refs/heads/$BASE" "refs/tags/$TAG"; then
  git tag -d "$TAG" >/dev/null 2>&1 || true
  die "버전 커밋·태그 push 실패 — $BASE 가 그새 움직였을 수 있다. 머지는${MERGED_LIST:-(이번 실행 0건)} 끝났다. 로컬 태그는 지웠다 — 같은 명령을 다시 돌리면 버전 커밋·태그만 다시 만든다" 7
fi
note "버전 $CUR → $VERSION, 태그 $TAG push ($(git -C "$TMPWT" rev-parse --short HEAD))"

# 3-1. GitHub Release — 태그에 릴리즈 노트를 붙인다. 리허설 태그는 prerelease 로 표시
REL_FLAG=""; [ "$PREFIX" = "v" ] || REL_FLAG="--prerelease"
rerun_cmds "$TAG"
REL_RERUN="(cd $(shq "$REPO") && gh release create $(shq "$TAG") --verify-tag --title $(shq "$TAG") --notes-file $(shq "$NOTES")${REL_FLAG:+ $REL_FLAG})"
gh release create "$TAG" --verify-tag --title "$TAG" --notes-file "$NOTES" $REL_FLAG >/dev/null \
  || die "GitHub Release 생성 실패 — 머지·버전 커밋·태그 $TAG push 는 끝났다(다시 출고하지 않는다). 아래 명령을 그대로 붙여 넣는다(app/INSTALL.md 「출고」)${NL}노트만 다시:${NL}$REL_RERUN${NL}그 뒤 dmg:${NL}$DMG_RERUN${NL}dmg 가 끝나면 임시 worktree 정리:${NL}$DMG_DONE${NL}그 뒤 APK:${NL}$APK_RERUN" 9
note "GitHub Release $TAG ($(gh release view "$TAG" --json url --jq .url))"

# 4. 본체 checkout 이 base 이고 깨끗하면 fast-forward — release-ff.sh(LIFE-672: index.lock 대기·원인별 문구, lock 은 지우지 않음).
#    실패해도 경고만 — 출고(원격)는 끝났고 5단계로 간다
if [ -x "$SCRIPT_DIR/release-ff.sh" ]; then
  "$SCRIPT_DIR/release-ff.sh" --repo "$REPO" --base "$BASE" --tag "$TAG" \
    || note "⚠ 본체 $BASE 는 fast-forward 하지 않았다(위 원인) — 출고(원격)는 끝났다. 본체를 손으로 맞춘다"
else
  note "⚠ scripts/release-ff.sh 가 없어 본체 $BASE fast-forward 를 건너뜀 — 출고(원격)는 끝났다. 본체를 손으로 맞춘다"
fi

# 5. dmg — 그 태그 위 깨끗한 트리(임시 worktree)에서만. 산출물은 본체 app/dist/release/<태그>/ 로 복사(git 무시)
# 재실행 안내 — 명령은 설명과 다른 줄에 홀로 두고 경로를 셸 인용한다. 어느 cwd 에서 붙여 넣어도 돈다(git -C·절대경로).
# APK 는 release-apk.sh --from-tag 가 정확한 태그 fetch → 매번 새 임시 worktree → 기존 APK 보존까지 맡는다
rerun_cmds "$TAG"
if [ "$SKIP_BUILD" = 1 ]; then
  note "--skip-build — dmg 는 나중에(그대로 붙여 넣는다):"
  echo "$DMG_RERUN"
  echo "$DMG_DONE"
else
  APK_TAIL=""; [ "$SKIP_APK" = 1 ] || APK_TAIL="${NL}APK 는 아직이다 — dmg 뒤 APK:${NL}$APK_RERUN"
  "$TMPWT/scripts/release-dmg.sh" --tag-prefix "$PREFIX" --out "$OUT_DIR" \
    || die "dmg 실패 — 머지·버전 커밋·태그 $TAG push 는 끝났다(다시 출고하지 않는다). 아래 명령을 그대로 붙여 넣는다${NL}dmg 만 다시:${NL}$DMG_RERUN${NL}dmg 가 끝나면 임시 worktree 정리:${NL}$DMG_DONE$APK_TAIL" 8
fi

# 6. APK — dmg 와 같은 태그 worktree 에서. 가드(HEAD = 태그·깨끗한 트리·원격 태그)는 release-apk.sh 가 빌드 전에 본다
if [ "$SKIP_APK" = 1 ]; then
  note "--skip-apk — APK 는 나중에(그대로 붙여 넣는다):"
  echo "$APK_RERUN"
else
  "$TMPWT/scripts/release-apk.sh" --tag-prefix "$PREFIX" --out "$OUT_DIR" \
    || die "APK 실패 — 머지·버전 커밋·태그 $TAG push$([ "$SKIP_BUILD" = 1 ] || echo "·dmg") 는 끝났다(다시 출고하지 않는다). 아래 명령을 그대로 붙여 넣는다${NL}APK 만 다시:${NL}$APK_RERUN" 10
fi

APK_LATER=""; [ "$SKIP_APK" = 0 ] || APK_LATER=" — --skip-apk 였으니 APK 를 먼저 만든다"
echo "✔ 출고 $TAG —$MERGED_LIST${SKIPPED:+ (앞선 실행:$SKIPPED)}"
echo "□ 다음: ① 머지된 PR 의 LIFE 일감마다 LA '완료' 전이(출고 머지 뒤 — D2) ② dmg 설치(app/INSTALL.md 「설치」) ③ 폰 APK 덮어 설치 scripts/release-apk-install.sh --serial <폰 시리얼> --apk $OUT_DIR/corral-mobile-$VERSION.apk (서명 대조 뒤 install -r$APK_LATER) ④ 남은 로컬 정리 scripts/task-finish.sh <LIFE-NNN-슬러그>"
