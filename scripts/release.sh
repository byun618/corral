#!/usr/bin/env bash
# release.sh <하위 명령> [인자]   — 출고 (LIFE-574 → LIFE-703 release 브랜치 흐름)
#   cut    [--bump patch|minor|major | --version X.Y.Z] [--dry-run]       ① 자르기 — origin/main 끝에서 release/vX.Y.Z + worktree, 버전 커밋
#   gather --prs "<번호> <번호> …" [--dry-run]                            ② 모으기 — 고른 PR head 를 release 브랜치에 로컬 merge(merge commit)
#   ship   --notes <릴리즈 노트 파일> [--skip-build] [--skip-apk] [--dry-run] ③ 출고 — release→main PR 머지 · 태그 · Release · ff · 원래 PR 처리 · dmg · APK · Release 에 올리기
#   finish [--leave-open]                                                ④ 정리 — 출고 확인 뒤 release 브랜치(로컬·원격)·worktree 삭제
#          (--leave-open: MERGED 로 확인 안 된 원래 PR 이 남아도 그 head 는 두고 release 브랜치만 정리 — 사람이 확인한 뒤에만)
#   abort                                                                ⑤ 접기 — 출고 전 release 브랜치(로컬·원격)·worktree 삭제, PR 은 열린 채
#   모든 하위 명령: [--base throwaway/<이름> --tag-prefix rehearsal-<이름>-v]  ← 리허설. 둘은 짝으로만 받는다
#
# 흐름 — release 브랜치는 출고 1회 수명이고 한 번에 하나다(로컬·원격 어디든 열린 것이 있으면 cut 거절).
# 실 출고: base main · 태그 vX.Y.Z · release 브랜치 release/vX.Y.Z · worktree <본체>/.claude/worktrees/release-vX.Y.Z
# 리허설: base throwaway/<이름> · 태그 rehearsal-…X.Y.Z · release 브랜치 <base>-release/<태그> — 이름이 전부 throwaway/·rehearsal- 아래다.
#
# 설계 (LIFE-703 00-analysis §5 — 기준):
# - PR 집합의 출처는 release 브랜치 자신이다. gather 의 merge 커밋마다 「Release-PR: <번호> <head SHA>」 줄을 남기고,
#   ship·finish 는 release 브랜치의 first-parent 이력(자르기 커밋 「Release-Cut: <태그>」 까지)에서 그 줄을 읽는다 — --prs 를 다시 받지 않는다.
#   같은 PR 이 여러 번 모였으면(출고 중 수정) 마지막 줄의 SHA 가 기록이다.
# - head 고정: gather 는 점검 시점 head SHA 를 fetch 해 그 SHA 를 merge 한다. ship 직전에 PR 마다 **지금 head 가 release 브랜치에 있는지** 다시 본다 —
#   모은 뒤 head 가 움직였는데 다시 모으지 않았으면 거절(exit 2). release→main 머지는 release 끝 SHA 로 --match-head-commit 고정.
#   머지 가능 판정 뒤 gh pr merge 직전에 한 번 더 본다. 그 확인과 머지 사이에 남는 짧은 창의 이동은 막을 수 없다 — 그 PR 은 OPEN 으로 남고 exit 13 이 받는다.
# - 원래 PR 은 head 가 main 에 닿으면 GitHub 가 MERGED 로 바꾼다(간접 머지). ship 은 정해진 시간 동안 다시 조회해 **MERGED 를 본 뒤에만**
#   원격 head 를 지운다(그 전에 지우면 CLOSED 가 될 수 있다). 끝내 안 되면 지우지 않고 남은 PR 을 알리고 exit 13 — finish 가 다시 본다.
#   대기 시계는 한 실행에 하나(RELEASE_INDIRECT_WAIT_S, 모든 PR 이 같이 쓴다) — 시계가 다 돼도 PR 마다 최소 1회 조회. head 삭제 실패도 미해결로 센다.
# - 태그 = main 끝(release→main 머지 커밋). 그 커밋의 app/package.json = 태그 버전(버전 커밋은 cut 이 release 브랜치에 둔다).
#   「이미 태그됨」·「출고 확인」은 태그 커밋이 origin/<base> 위 merge commit 이고 둘째 부모 = release 끝일 때만이다.
#   main 에 직접 push 하는 것은 태그뿐이다 — main 의 새 커밋은 release PR 머지 커밋 하나다.
# - 멱등: 단계마다 「어디까지 됐나」를 원격 상태(원격 태그·release PR 상태·Release 유무)로 보고, 같은 명령 재실행이 이어 간다.
#
# 종료코드 (app/INSTALL.md 「출고」 표와 같다):
#   0 완료 · 1 인자·환경 오류(ref·push 전) · 2 점검 거절(대부분 변경 0 — ship 머지 직전 재확인은 push·PR 생성 뒤) · 3 충돌(gather: release worktree 에 남김 / ship: release PR 충돌)
#   5 머지 가능 판정 없음 · 6 release PR 머지 거절·결과 이상 · 7 태그 만들기·push·fetch 실패 · 8 dmg·임시 worktree 실패 · 9 GitHub Release 실패 · 10 APK 실패
#   11 release 브랜치 push·삭제 실패 · 12 release PR 생성·조회 실패 · 13 원래 PR 처리 미완 — MERGED 미확인·head 조회/삭제 실패(출고 자체는 끝남)
#   14 Release 에 dmg·APK 올리기 실패(머지·태그·Release·dmg·APK 끝)
# 재실행 안내의 명령은 설명과 다른 줄에 홀로, 경로는 단일 따옴표로 인용한다(LIFE-599).
#
# 검사 없이 순서 머지다 — PR CI(LIFE-575)는 참고 신호라 여기서 보지 않는다(모으기 전 확인은 release 스킬 2). ruleset 「main 보호」(LIFE-718)는 서버에서 강제되고(공개 뒤 — LIFE-729), required check 는 걸지 않는다 — ship 이 release PR 을 만든 직후 머지하고 CI 를 기다리지 않는다(LIFE-707).
# 본체 checkout fast-forward 는 release-ff.sh(LIFE-672), dmg 는 release-dmg.sh, APK 는 release-apk.sh, Release 에 올리기는 release-upload.sh(LIFE-729) — 넷 다 태그 하나를 입력으로 받는다.
set -euo pipefail

die() { local code="${2:-1}"; echo "✖ $1" >&2; exit "$code"; }
note() { echo "· $1"; }
shq() { local s="$1" q="'\\''"; printf "'%s'" "${s//\'/$q}"; }
NL=$'\n'

USAGE="사용법: release.sh cut|gather|ship|finish|abort [인자] — 머리 주석·app/INSTALL.md 「출고」"
CMD="${1:-}"
case "$CMD" in
  cut|gather|ship|finish|abort) shift ;;
  ""|-h|--help) echo "$USAGE"; exit 0 ;;
  --*) die "하위 명령이 필요하다(LIFE-703 — 옛 'release.sh --prs …' 한 번 출고는 없다: cut → gather → ship). $USAGE" ;;
  *) die "모르는 하위 명령: $CMD. $USAGE" ;;
esac

PRS=""; NOTES=""; BASE="main"; PREFIX="v"; BUMP="patch"; VERSION=""; SKIP_BUILD=0; SKIP_APK=0; DRY_RUN=0; LEAVE_OPEN=0
allow() { case " $1 " in *" $CMD "*) ;; *) die "$2 는 $CMD 에서 받지 않는다. $USAGE" ;; esac; }
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:?--base 값 없음}"; shift 2 ;;
    --tag-prefix) PREFIX="${2:?--tag-prefix 값 없음}"; shift 2 ;;
    --bump) allow cut "$1"; BUMP="${2:?--bump 값 없음}"; shift 2 ;;
    --version) allow cut "$1"; VERSION="${2:?--version 값 없음}"; shift 2 ;;
    --prs) allow gather "$1"; PRS="${2:?--prs 값 없음}"; shift 2 ;;
    --notes) allow ship "$1"; NOTES="${2:?--notes 값 없음}"; shift 2 ;;
    --skip-build) allow ship "$1"; SKIP_BUILD=1; shift ;;
    --skip-apk) allow ship "$1"; SKIP_APK=1; shift ;;
    --dry-run) allow "cut gather ship" "$1"; DRY_RUN=1; shift ;;
    --leave-open) allow finish "$1"; LEAVE_OPEN=1; shift ;;
    *) die "모르는 인자: $1. $USAGE" ;;
  esac
done

# 이름 공간 — 실 출고(main + v) 와 리허설(throwaway/<이름> + rehearsal-<…>) 만. 한쪽만 바꾸면 실 레포의 main·v 태그·release/v 를 칠 수 있다.
# 글자를 먼저 좁히고(패턴 우회 차단 — LIFE-703 r1: '|' 든 값이 짝 패턴을 속였다) BASE·PREFIX 를 따로 분류해 같은 쪽일 때만 받는다.
# release 브랜치 접두(RP)는 짝에서 파생한다 — 따로 받지 않아 세 번째 어긋남이 생기지 않는다
NS_BAD="--base '$BASE' 와 --tag-prefix '$PREFIX' 짝이 맞지 않는다 — 실 출고는 둘 다 기본값(main·v), 리허설은 --base throwaway/<이름> --tag-prefix rehearsal-<이름>-v"
# case 로 본다 — 줄 단위 grep 은 개행 든 값의 첫 줄만 보고 통과시켰다(LIFE-703 r2)
NS_CH=ok; case "$BASE" in ""|*[!A-Za-z0-9._/-]*) NS_CH=bad ;; esac; case "$PREFIX" in ""|*[!A-Za-z0-9._-]*) NS_CH=bad ;; esac
[ "$NS_CH" = ok ] || die "--base '$BASE' 또는 --tag-prefix '$PREFIX' 에 쓸 수 없는 글자가 있다 — 영숫자·. _ - (base 는 / 도)만" # guard:ns-chars
case "$BASE" in main) BK=real ;; throwaway/?*) BK=rehearsal ;; *) BK=bad ;; esac
case "$PREFIX" in v) PK=real ;; rehearsal-?*) PK=rehearsal ;; *) PK=bad ;; esac
[ "$BK" = "$PK" ] && [ "$BK" != bad ] || die "$NS_BAD" # guard:namespace
RP="release/"; [ "$BK" = real ] || RP="$BASE-release/"
git check-ref-format "refs/heads/$BASE" && git check-ref-format "refs/tags/${PREFIX}0.0.0" \
  || die "--base '$BASE' 또는 --tag-prefix '$PREFIX' 가 git 이름으로 쓸 수 없다"
# 릴리즈 노트는 부른 곳 기준 — 아래에서 cd 하므로 절대경로로
[ -z "$NOTES" ] || [ ! -f "$NOTES" ] || NOTES="$(cd "$(dirname "$NOTES")" && pwd)/$(basename "$NOTES")"
RARGS=""; [ "$BASE" = main ] || RARGS=" --base $(shq "$BASE") --tag-prefix $(shq "$PREFIX")"
case "$BUMP" in patch|minor|major) ;; *) die "--bump 는 patch|minor|major" ;; esac
[ -z "$VERSION" ] || echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version 은 X.Y.Z"

# 레포 = 본체 checkout. 작업 worktree 의 사본으로 돌려도 본체를 가리키게 스크립트 위치의 git 공통 디렉터리에서 역산한다
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
  || die "이 스크립트는 git 레포 안의 사본으로 실행한다(scripts/release.sh)"
REPO="$(dirname "$COMMON")"
[ "$(git -C "$REPO" rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || die "본체 checkout($REPO)이 작업 트리가 아니다" 2
# 오용 — 다른 레포 안에서 이 레포의 스크립트를 부르면 어느 레포를 출고하는지 헷갈린다
CWD_COMMON="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -z "$CWD_COMMON" ] || [ "$CWD_COMMON" = "$COMMON" ] \
  || die "지금 폴더는 다른 git 레포다($CWD_COMMON) — 이 스크립트의 레포($REPO) 안이나 레포 밖에서 부른다" 2  # guard:other-repo
cd "$REPO"
WT_ROOT="$REPO/.claude/worktrees"
# 폴더가 지워지고 등록만 남은 worktree 를 먼저 정리한다 — 남아 있으면 재부착(worktree add)·브랜치 삭제가 막힌다(LIFE-703 r3). 폴더 없는 등록만 지운다
[ "$DRY_RUN" = 1 ] || git worktree prune # guard:wt-prune

# ── 공용 ──
# 다음 버전 — package.json 본문에서. 출력: "<지금> <다음>"
next_version() {
  local cur ma mi pa
  cur="$(pkg_version "$1")"
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
pkg_version() { awk 'match($0, /^  "version": "[0-9.]+",$/) { v = $0; sub(/^  "version": "/, "", v); sub(/",$/, "", v); print v; exit }' <<J
$1
J
}
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
# 원격 태그가 가리키는 커밋(주석 태그는 벗긴다). 없으면 빈 값, 조회 실패면 1
remote_tag_commit() {
  local out
  out="$(git ls-remote --tags origin "refs/tags/$1" "refs/tags/$1^{}")" || return 1
  echo "$out" | awk -v t="refs/tags/$1" '$2 == t "^{}" {p = $1} $2 == t {l = $1} END {print (p != "" ? p : l)}'
}
remote_head() { # 원격 브랜치 끝 SHA(없으면 빈 값), 조회 실패면 1
  local out
  out="$(git ls-remote --heads origin "refs/heads/$1")" || return 1
  echo "$out" | awk -v r="refs/heads/$1" '$2 == r {print $1}'
}
is_ancestor() { git merge-base --is-ancestor "$1" "$2" 2>/dev/null; }
# 이 release 의 머지된 release PR — 출력 "번호 head 머지커밋"(없으면 빈 값), 조회 실패면 1.
# 이름만 보지 않는다: 같은 이름의 옛 회차 PR 은 GitHub 에 MERGED 로 영구히 남는다 — 그 head 가 지금 $RB 안에 있는 것만 이 release 의 것(LIFE-703 r3)
merged_rp() {
  local rows ref n h m
  rows="$(gh pr list --head "$RB" --base "$BASE" --state merged --json number,headRefOid,mergeCommit --jq '.[] | "\(.number) \(.headRefOid) \(.mergeCommit.oid)"')" || return 1
  [ -n "$rows" ] || return 0
  ref="refs/heads/$RB"
  if ! git rev-parse -q --verify "$ref" >/dev/null; then
    ref="refs/remotes/origin/$RB"; git fetch -q origin "+refs/heads/$RB:$ref" 2>/dev/null || return 0
  fi
  while read -r n h m; do
    [ -n "$n" ] || continue
    is_ancestor "$h" "$ref" && { echo "$n $h $m"; return 0; } # guard:merged-link
  done <<R
$rows
R
  return 0
}

# 열린 release 브랜치 — 로컬·원격에서 <RP><PREFIX> 로 시작하는 이름 전부(X.Y.Z 가 아닌 이름도 센다 — 한 번에 하나). 출력: 이름 한 줄씩(중복 없음)
open_releases() {
  local remote name ver
  remote="$(git ls-remote --heads origin)" || die "origin 조회 실패(git ls-remote)"
  { git for-each-ref --format='%(refname)' refs/heads/; echo "$remote" | awk '{print $2}'; } \
    | sed -n 's|^refs/heads/||p' | sort -u | while read -r name; do
      case "$name" in "$RP$PREFIX"*) echo "$name" ;; esac
    done
}
# 하나뿐인 열린 release 브랜치를 RB·VER·TAG·WT 로. 없으면 빈 RB
pick_release() {
  local names n
  names="$(open_releases)"
  n="$(echo "$names" | grep -c . || true)"
  RB=""; VER=""; TAG=""; WT=""
  [ "$n" -le 1 ] || die "열린 release 브랜치가 여러 개다 — 한 번에 하나만(접을 것을 abort 로 정리):${NL}$names" 2
  [ "$n" = 1 ] || return 0
  RB="$names"; VER="${RB#"$RP$PREFIX"}"; TAG="$PREFIX$VER"; WT="$WT_ROOT/release-$TAG"
  echo "$VER" | grep -qxE '[0-9]+\.[0-9]+\.[0-9]+' \
    || die "열린 release 브랜치 $RB 의 버전 자리가 X.Y.Z 가 아니다 — 이 스크립트가 자른 것이 아니다. 직접 확인해 정리한다(git branch -D · git push origin --delete)" 2
}
wt_on_rb() { [ -d "$WT" ] && [ "$(git -C "$WT" symbolic-ref -q --short HEAD 2>/dev/null)" = "$RB" ]; }
# release worktree 가 깨끗한가 — 해소 중 merge·미커밋 변경이면 사유를 내고 멈춘다(exit 2)
wt_clean_or_die() {
  local what="$1"
  if git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    die "release worktree 에 해소 중인 merge 가 있다 — $what 하지 않음. 충돌을 풀고 커밋하거나(git -C $(shq "$WT") commit --no-edit) 그 PR 을 빼려면 git -C $(shq "$WT") merge --abort" 2
  fi
  local dirty; dirty="$(git -C "$WT" status --porcelain)"
  [ -z "$dirty" ] || die "release worktree 에 커밋 안 된 변경이 있다 — $what 하지 않음:${NL}$(echo "$dirty" | head -10)${NL}($WT)" 2  # guard:wt-dirty
}
# release 브랜치 기록 — first-parent 로 자르기 커밋까지 내려가며 「Release-PR: <번호> <SHA>」 를 모은다.
# 자르기 커밋 = 「Release-Cut: <태그>」 줄을 가진 **가장 오래된** first-parent 커밋 — 뒤 커밋 메시지가 그 줄을 인용해도(예: 회고 커밋) 기록이 잘리지 않는다.
# 출력: "<번호> <마지막 SHA>" 한 줄씩, 처음 모은 순서. $2 = cut 이면 자르기 커밋 SHA 만. 자르기 커밋이 없으면 1.
# awk 는 입력을 끝까지 읽는다(일찍 끝내면 git log 가 SIGPIPE)
# 기록 줄은 gather 가 만든 커밋에서만 센다(LIFE-703 r2 — 아무 커밋 본문의 줄이 번호를 더하고 그 head 를 지우게 했다):
#   모으기 merge(둘째 부모 = 그 SHA) 또는 기록 커밋(제목 「release: #<번호> 기록」). 아닌 줄이 있으면 "BAD <커밋> <번호> <SHA>" 를 내고 3.
read_record() {
  git log --first-parent --format='@@C %H %P%n%B' "$1" | awk -v cut="Release-Cut: $TAG" -v mode="${2:-rec}" '
    /^@@C / { c++; h[c] = $2; p2[c] = $4; first = 1; next }
    first { subj[c] = $0; first = 0 }
    # 최신부터 읽으므로 마지막 대입이 가장 오래된 일치
    $0 == cut { cutc = c } # guard:cut-oldest
    /^Release-PR: [0-9]+ [0-9a-f]+$/ && length($3) == 40 { rec[++k] = $2 " " $3; rc[k] = c }
    END {
      if (!cutc) exit 1
      if (mode == "cut") { print h[cutc]; exit 0 }
      bad = 0
      for (i = 1; i <= k; i++) {
        if (rc[i] >= cutc) continue
        split(rec[i], a, " "); x = rc[i]
        ok = (p2[x] == a[2]) || (index(subj[x], "release: #" a[1] " 기록") == 1) # guard:record-valid
        if (!ok) { print "BAD", h[x], a[1], a[2]; bad = 1 }
      }
      if (bad) exit 3
      for (i = k; i >= 1; i--) { if (rc[i] >= cutc) continue; split(rec[i], a, " "); if (!(a[1] in s)) o[++m] = a[1]; s[a[1]] = a[2] }
      for (i = 1; i <= m; i++) print o[i], s[o[i]]
    }'
}
# RECORD 를 읽고 검사한다 — 자르기 커밋 없음·gather 가 만들지 않은 줄·release 브랜치에 없는 SHA 는 exit 2
load_record() {
  local out rc=0 n sha bad=""
  out="$(read_record "$RB")" || rc=$?
  case "$rc" in
    0) ;;
    1) die "$RB 에 자르기 커밋(Release-Cut: $TAG)이 없다 — 이 스크립트가 자른 브랜치가 아니다. 확인 뒤 abort" 2 ;;
    3) die "release 브랜치에 gather 가 만들지 않은 Release-PR 줄이 있다 — 출고 집합에 넣지 않고 멈춘다. 접고(abort) 다시 자른 뒤 모은다(revert 로는 풀리지 않는다 — 원 커밋이 이력에 남는다):${NL}$(echo "$out" | awk '$1 == "BAD" {printf "  커밋 %s — #%s %s\n", substr($2, 1, 7), $3, substr($4, 1, 7)}')" 2 ;;
    *) die "release 브랜치 기록을 읽지 못했다(rc $rc)" ;;
  esac
  while read -r n sha; do
    [ -n "$n" ] || continue
    is_ancestor "$sha" "$RB" || bad="$bad${NL}  #$n ${sha:0:7}"
  done <<R
$out
R
  [ -z "$bad" ] || die "기록 SHA 가 release 브랜치에 없다 — 출고 집합에 넣지 않고 멈춘다:$bad" 2 # guard:record-anc
  RECORD="$out"
}
rec_sha() { echo "$RECORD" | awk -v n="$1" '$1 == n {print $2}'; }
# 원격 태그 커밋이 이 release 의 출고 머지인가 — origin/<base> 위의 merge commit(부모 2)이고 둘째 부모 = release 끝(TIP)
tag_is_release_merge() {
  local p; p="$(git rev-list --parents -n 1 "$1" 2>/dev/null)" || return 1
  set -- $p
  [ $# = 3 ] && [ "$3" = "$TIP" ] && is_ancestor "$1" "origin/$BASE"
}
RECUT() { echo "$(shq "$SCRIPT_DIR/release.sh") cut --version $VER$RARGS"; }

git fetch -q --tags origin || die "git fetch origin 실패"
git rev-parse --verify -q "refs/remotes/origin/$BASE" >/dev/null || die "원격 base 없음: origin/$BASE"

# ════════════════════════════ cut ════════════════════════════
if [ "$CMD" = cut ]; then
  NV="$(next_version "$(git show "origin/$BASE:app/package.json")")" || die "origin/$BASE 의 app/package.json 버전을 못 읽음" 2
  CUR="${NV% *}"; VER="${NV#* }"; TAG="$PREFIX$VER"; RB="$RP$TAG"; WT="$WT_ROOT/release-$TAG"
  NAMES="$(open_releases)"
  if [ -n "$NAMES" ] && [ "$NAMES" != "$RB" ]; then
    die "열린 release 브랜치가 이미 있다 — 한 번에 하나다. 그것을 출고(ship·finish)하거나 접고(abort) 다시 자른다. 출고는 끝났는데 원래 PR 처리가 남아(exit 13) 남은 것이면 finish(확인 뒤 finish --leave-open):${NL}$NAMES" 2  # guard:open-release
  fi
  if [ "$NAMES" = "$RB" ]; then
    # 재실행 — 같은 버전으로 다시 쳤다. 있는 것을 재사용하고 두 번째를 만들지 않는다
    if [ "$DRY_RUN" = 1 ]; then
      echo "── dry-run (ref·worktree 변경 없음) ──"
      echo "release 브랜치 $RB 가 이미 있다 — 재사용(새로 만들지 않음)$(git rev-parse -q --verify "refs/heads/$RB" >/dev/null || echo ' · 로컬에 없어 원격에서 붙인다')"
      echo "worktree $WT $(wt_on_rb && echo '(있음)' || echo '(없음 — 붙인다)')"
      exit 0
    fi
    if ! git rev-parse -q --verify "refs/heads/$RB" >/dev/null; then
      git fetch -q origin "refs/heads/$RB:refs/heads/$RB" || die "원격 release 브랜치 $RB 를 가져오지 못했다"
      note "원격 $RB 를 로컬 브랜치로 붙였다"
    fi
    load_record
    if wt_on_rb; then note "release worktree 가 이미 있다: $WT"
    else
      [ ! -e "$WT" ] || die "worktree 자리에 다른 것이 있다: $WT" 2
      git worktree add -q "$WT" "$RB" || die "release worktree 를 붙이지 못했다: $WT"
      note "release worktree 를 붙였다: $WT"
    fi
    echo "✔ release 브랜치 $RB 가 이미 있다(재사용 — 새로 자르지 않음) @ $(git rev-parse --short "$RB"), worktree $WT"
    echo "□ 다음: $(shq "$SCRIPT_DIR/release.sh") gather --prs '<번호…>'$RARGS"
    exit 0
  fi
  ver_gt "$VER" "$CUR" || die "다음 버전 $VER 이 지금 버전 $CUR 보다 크지 않다(--version 확인) — 자르지 않음" 2  # guard:version-gt
  TC="$(remote_tag_commit "$TAG")" || die "원격 태그 조회 실패"
  [ -z "$TC" ] || die "원격에 태그 $TAG 가 이미 있다 — 자르지 않음(--version 으로 다른 버전)" 2  # guard:tag-exists
  [ ! -e "$WT" ] || die "worktree 자리에 이미 무언가 있다: $WT — 자르지 않음" 2
  if [ "$DRY_RUN" = 1 ]; then
    echo "── dry-run (ref·worktree 변경 없음) ──"
    echo "base $BASE @ $(git rev-parse --short "origin/$BASE"), 버전 $CUR → $VER, 태그 $TAG"
    echo "release 브랜치 $RB (로컬만 — push 는 ship 이 한다)"
    echo "worktree $WT"
    exit 0
  fi
  BASE_SHA="$(git rev-parse "origin/$BASE")"
  git worktree add -q --no-track -b "$RB" "$WT" "origin/$BASE" || die "release 브랜치·worktree 를 만들지 못했다"
  cut_rollback() {
    git worktree remove --force "$WT" >/dev/null 2>&1 || true
    git branch -D "$RB" >/dev/null 2>&1 || true
    die "$1 — 만든 release 브랜치·worktree 를 지웠다(push 한 것 없음)"
  }
  (cd "$WT/app" && npm version "$VER" --no-git-tag-version --allow-same-version >/dev/null) || cut_rollback "버전 올림(npm version) 실패"
  [ "$(pkg_version "$(cat "$WT/app/package.json")")" = "$VER" ] || cut_rollback "버전 올림 결과가 $VER 이 아니다"
  git -C "$WT" add app/package.json || cut_rollback "git add 실패"
  [ ! -f "$WT/app/package-lock.json" ] || git -C "$WT" add app/package-lock.json || cut_rollback "git add 실패"
  git -C "$WT" commit -q -m "release: $TAG" -m "scripts/release.sh cut — base $BASE @ ${BASE_SHA:0:7}, $CUR → $VER" -m "Release-Cut: $TAG" \
    || cut_rollback "버전 커밋 실패"
  echo "✔ 자르기 $RB @ $(git rev-parse --short "$RB") (버전 $CUR → $VER, base $BASE @ ${BASE_SHA:0:7})"
  echo "  worktree $WT — 통합 확인(빌드·실행)은 여기서"
  echo "□ 다음: $(shq "$SCRIPT_DIR/release.sh") gather --prs '<번호…>'$RARGS"
  exit 0
fi

# ── cut 밖 하위 명령은 열린 release 브랜치 하나를 다룬다 ──
pick_release

# ════════════════════════════ gather ════════════════════════════
if [ "$CMD" = gather ]; then
  [ -n "$(echo "$PRS" | tr -d ' ,')" ] || die "사용법: release.sh gather --prs \"12 15\"$RARGS"
  UNIQ=""
  for n in $(echo "$PRS" | tr ',' ' '); do
    case "$n" in *[!0-9]*) die "PR 번호가 아님: $n" ;; esac
    case " $UNIQ " in *" $n "*) note "PR #$n 중복 — 한 번만 처리" ;; *) UNIQ="$UNIQ $n" ;; esac
  done
  [ -n "$RB" ] || die "열린 release 브랜치가 없다 — 먼저 $(shq "$SCRIPT_DIR/release.sh") cut$RARGS" 2
  git rev-parse -q --verify "refs/heads/$RB" >/dev/null || die "$RB 가 원격에만 있다 — 같은 버전으로 다시 자르면 로컬에 붙인다:${NL}$(RECUT)" 2
  wt_on_rb || die "release worktree 가 없거나 $RB 가 아니다: $WT — 같은 버전으로 다시 자르면 붙인다:${NL}$(RECUT)" 2
  wt_clean_or_die "모으기"
  TC="$(remote_tag_commit "$TAG")" || die "원격 태그 조회 실패"
  [ -z "$TC" ] || die "원격에 태그 $TAG 가 이미 있다 — 이 release 는 출고됐다. 새 PR 은 다음 출고(finish 뒤 cut)" 2
  MERGED_RP="$(merged_rp)" || die "release PR 조회 실패" 12; MERGED_RP="${MERGED_RP%% *}"
  [ -z "$MERGED_RP" ] || die "release PR #$MERGED_RP 가 이미 머지됐다(태그 전에 멈춘 출고) — 더 모으지 않는다. 같은 ship 으로 출고를 이어 간다:${NL}$(shq "$SCRIPT_DIR/release.sh") ship --notes <파일>$RARGS" 2 # guard:gather-merged
  load_record
  TIP="$(git rev-parse "$RB")"

  # 0. 사전 일괄 점검 — 하나라도 어긋나면 release 브랜치 변경 0건. head SHA 는 여기서 고정하고 그 SHA 를 fetch 해 둔다
  PLAN=""  # "번호 동작 SHA head" — 동작: merge(새로 모음) · rec(이미 들어 있어 기록만) · skip(이미 모아 기록됨)
  for n in $UNIQ; do
    info="$(gh pr view "$n" --json state,baseRefName,headRefName,isDraft,isCrossRepository,headRefOid --jq '"\(.state) \(.baseRefName) \(.headRefName) \(.isDraft) \(.isCrossRepository) \(.headRefOid)"')" \
      || die "PR #$n 조회 실패 — 아무것도 모으지 않음" 2
    set -- $info
    [ "$1" = OPEN ] || die "PR #$n 상태가 $1 — 열린 PR 만 모은다 — 아무것도 모으지 않음" 2  # guard:pr-open
    [ "$2" = "$BASE" ] || die "PR #$n 의 base 가 $2 — $BASE 대상 PR 만 모은다 — 아무것도 모으지 않음" 2
    [ "$4" = false ] || die "PR #$n 은 draft — ready 로 바꾼 뒤 다시 — 아무것도 모으지 않음" 2
    [ "$5" = false ] || die "PR #$n 은 포크 PR — 출고 대상 아님 — 아무것도 모으지 않음" 2
    head="$3"; pin="$6"
    git fetch -q origin "refs/heads/$head" || die "PR #$n head $head 를 가져오지 못했다 — 아무것도 모으지 않음" 2
    [ "$(git rev-parse FETCH_HEAD)" = "$pin" ] \
      || die "PR #$n head 가 점검 중에 움직였다(${pin:0:7} → $(git rev-parse --short FETCH_HEAD)) — 아무것도 모으지 않음. 다시 친다" 2
    if is_ancestor "$pin" "$TIP"; then
      if [ "$(rec_sha "$n")" = "$pin" ]; then act=skip; else act=rec; fi
    else act=merge; fi
    PLAN="$PLAN$n $act $pin $head$NL"
  done

  if [ "$DRY_RUN" = 1 ]; then
    echo "── dry-run (release 브랜치 변경 없음) ──"
    echo "release 브랜치 $RB @ ${TIP:0:7}, worktree $WT"
    echo "$PLAN" | while read -r n act pin head; do
      [ -n "$n" ] || continue
      case "$act" in
        merge) echo "  모을 예정 #$n ($head) @ ${pin:0:7}" ;;
        rec) echo "  기록만 #$n ($head) @ ${pin:0:7} — head 가 이미 release 브랜치에 있다" ;;
        skip) echo "  건너뜀 #$n ($head) @ ${pin:0:7} — 이미 모음" ;;
      esac
    done
    exit 0
  fi

  DONE_LIST=""
  REST="$UNIQ"
  while read -r n act pin head; do
    [ -n "$n" ] || continue
    REST="${REST# }"; REST="${REST#"$n"}"
    # 동작을 처리 직전에 다시 정한다 — 앞 PR 이 이 PR 의 head 를 품었으면 merge 가 「Already up to date」로 커밋 없이 끝나 기록이 빠진다(LIFE-703 r1)
    CUR_TIP="$(git -C "$WT" rev-parse HEAD)" # guard:stacked
    load_record
    if is_ancestor "$pin" "$CUR_TIP"; then
      if [ "$(rec_sha "$n")" = "$pin" ]; then act=skip; else act=rec; fi
    else act=merge; fi
    case "$act" in
      skip) note "PR #$n ($head) @ ${pin:0:7} 는 이미 모음 — 건너뜀" ;;
      rec)
        git -C "$WT" commit -q --allow-empty -m "release: #$n 기록 — $head @ ${pin:0:7} 가 이미 들어 있다" -m "Release-PR: $n $pin" \
          || die "PR #$n 기록 커밋 실패"
        note "PR #$n ($head) @ ${pin:0:7} — head 가 이미 들어 있어 기록만 남겼다"; DONE_LIST="$DONE_LIST #$n" ;;
      merge)
        if ! git -C "$WT" merge -q --no-ff --no-edit -m "release: #$n 모으기 — $head @ ${pin:0:7}" -m "Release-PR: $n $pin" "$pin"; then
          if git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null; then
            FILES="$(git -C "$WT" diff --name-only --diff-filter=U)"
            die "PR #$n ($head) 가 release 브랜치와 충돌 — 여기서 멈춘다(뒤 PR 은 모으지 않음)${DONE_LIST:+. 이번에 모음:$DONE_LIST}${NL}충돌 파일:${NL}$FILES${NL}release worktree 에서 풀고 커밋한다(커밋 메시지의 Release-PR 줄이 모으기 기록이다 — --no-edit 로 그대로 둔다):${NL}git -C $(shq "$WT") add -- <푼 파일>${NL}git -C $(shq "$WT") commit --no-edit${NL}그 뒤 남은 PR 을 모은다(이미 모은 PR 은 넣어도 건너뛴다):${NL}$(shq "$SCRIPT_DIR/release.sh") gather --prs $(shq "$n$REST")$RARGS${NL}해소가 기능을 바꿀 만큼 크면 이 PR 을 빼고(git -C $(shq "$WT") merge --abort) 나머지만 모은다" 3
          fi
          die "PR #$n merge 실패(충돌 아님) — 위 git 출력을 본다${DONE_LIST:+. 이번에 모음:$DONE_LIST}"
        fi
        note "PR #$n ($head) @ ${pin:0:7} 모음 → $(git -C "$WT" rev-parse --short HEAD)"; DONE_LIST="$DONE_LIST #$n" ;;
    esac
  done <<P
$PLAN
P
  load_record
  echo "✔ 모으기 $RB @ $(git rev-parse --short "$RB")${DONE_LIST:+ — 이번에:$DONE_LIST}"
  echo "  기록(출고 집합): $(echo "$RECORD" | awk '{printf "#%s@%s ", $1, substr($2, 1, 7)}')"
  echo "□ 다음: 통합 확인은 release worktree 에서($WT) → $(shq "$SCRIPT_DIR/release.sh") ship --notes <파일>$RARGS"
  exit 0
fi

# ── 원래 PR 처리 (ship·finish) — MERGED 를 본 뒤에만 원격 head 를 지운다 ──
# 남은 PR 은 UNRESOLVED("#번호(사유)" 목록) — MERGED 미확인·head 조회/삭제 실패. 대기 시계는 **한 실행에 하나**(모든 PR 이 함께 쓴다):
# RELEASE_INDIRECT_WAIT_S(기본 120초) · RELEASE_INDIRECT_STEP_S(기본 10초). 시계가 다 돼도 PR 마다 최소 1회는 조회한다
process_prs() {
  local wait="${RELEASE_INDIRECT_WAIT_S:-120}" step="${RELEASE_INDIRECT_STEP_S:-10}" start now n sha st head oid rh raw
  start="$(date +%s)"; UNRESOLVED=""
  while read -r n sha; do
    [ -n "$n" ] || continue
    while :; do
      st="$(gh pr view "$n" --json state,headRefName,headRefOid --jq '"\(.state) \(.headRefName) \(.headRefOid)"')" || st="ERROR - -"
      set -- $st; st="$1"; head="$2"; oid="$3"
      [ "$st" = OPEN ] || [ "$st" = ERROR ] || break
      now="$(date +%s)"; [ $((now - start)) -lt "$wait" ] || break # guard:wait-loop
      sleep "$step"
    done
    raw="$(gh pr view "$n" --json state,mergedAt,mergeCommit,mergedBy 2>&1 || true)"
    note "PR #$n $raw"
    if [ "$st" != MERGED ]; then UNRESOLVED="$UNRESOLVED #$n($st)"; continue; fi # guard:merged-only
    # 지우는 것은 원격 head 가 **기록 SHA**(모은 그 커밋)이자 gh 의 head oid 일 때만 — 그 뒤 push 된 새 커밋은 건드리지 않는다
    case "$head" in "$BASE"|"$RB"|main|release/*) note "PR #$n head $head — 지우지 않는 이름"; continue ;; esac # guard:protected-head
    # 리허설은 throwaway/ 아래 head 만 지운다(이름 공간 — C7)
    if [ "$BK" = rehearsal ]; then case "$head" in throwaway/*) ;; *) note "PR #$n head $head — 리허설은 throwaway/ 아래만 지운다(그대로 둠)"; continue ;; esac; fi # guard:rehearsal-head
    rh="$(remote_head "$head")" || { UNRESOLVED="$UNRESOLVED #$n(head 조회 실패)"; note "⚠ PR #$n head $head 원격 조회 실패 — 지우지 않음"; continue; }
    if [ -z "$rh" ]; then note "PR #$n MERGED — 원격 head $head 는 이미 없다"
    elif [ "$rh" = "$oid" ] && [ "$rh" = "$sha" ]; then # guard:head-oid
      if git push -q origin --delete "$head"; then note "PR #$n MERGED — 원격 head 삭제: $head"
      else UNRESOLVED="$UNRESOLVED #$n(head 삭제 실패)"; note "⚠ PR #$n 원격 head $head 삭제 실패"; fi # guard:delete-fail
    else note "⚠ PR #$n MERGED 인데 원격 head $head(${rh:0:7})가 모은 커밋(${sha:0:7})·gh head(${oid:0:7})와 다르다 — 지우지 않음"; fi
  done <<R
$RECORD
R
}
unresolved_msg() {
  echo "원래 PR 처리가 끝나지 않았다(MERGED 미확인·head 조회/삭제 실패):$UNRESOLVED — 그 head 는 지우지 않았다(또는 못 지웠다).${NL}GitHub 가 간접 머지를 늦게 반영할 수 있다. 확인:${NL}$(for n in $(echo "$UNRESOLVED" | tr -c '0-9\n' ' '); do echo "gh pr view $n --json state,mergedAt,mergeCommit"; done)${NL}MERGED 가 되면 다시 본다(MERGED 인 PR 의 head 만 지우고 release 브랜치를 정리한다):${NL}$(shq "$SCRIPT_DIR/release.sh") finish$RARGS${NL}끝내 OPEN 이면 app/INSTALL.md 「출고」 — 간접 머지가 안 될 때(확인 뒤 finish --leave-open)"
}

# ════════════════════════════ abort ════════════════════════════
if [ "$CMD" = abort ]; then
  [ -n "$RB" ] || { echo "✔ 접을 release 브랜치가 없다"; exit 0; }
  TC="$(remote_tag_commit "$TAG")" || die "원격 태그 조회 실패"
  [ -z "$TC" ] || die "원격에 태그 $TAG 가 있다 — 이미 출고됐다. 접지 않는다(정리는 finish)" 2
  MERGED_RP="$(merged_rp)" || die "release PR 조회 실패" 12; MERGED_RP="${MERGED_RP%% *}"
  [ -z "$MERGED_RP" ] || die "release PR #$MERGED_RP 가 이미 머지됐다 — 접지 않는다. 출고를 이어 간다: $(shq "$SCRIPT_DIR/release.sh") ship --notes <파일>$RARGS" 2 # guard:abort-merged
  if [ -d "$WT" ]; then
    wt_on_rb || die "worktree 자리 $WT 가 $RB 가 아니다 — 지우지 않음" 2
    wt_clean_or_die "접기"
    git worktree remove --force "$WT" || die "release worktree 삭제 실패: $WT — 로컬·원격 $RB 는 그대로 뒀다"
    note "release worktree 삭제: $WT"
  fi
  if git rev-parse -q --verify "refs/heads/$RB" >/dev/null; then
    git branch -q -D "$RB" || die "로컬 $RB 삭제 실패(다른 worktree 가 쓰는지 git worktree list 로 본다) — 원격 $RB 는 그대로 뒀다"
    note "로컬 $RB 삭제"
  fi
  RH="$(remote_head "$RB")" || die "원격 조회 실패"
  if [ -n "$RH" ]; then
    git push -q origin --delete "$RB" || die "원격 $RB 삭제 실패" 11
    note "원격 $RB 삭제(열려 있던 release PR 은 GitHub 가 닫는다)"
  fi
  echo "✔ 접기 $RB — 모았던 PR 은 열린 채 남는다. main·태그 변경 없음"
  exit 0
fi

# ════════════════════════════ finish ════════════════════════════
if [ "$CMD" = finish ]; then
  [ -n "$RB" ] || { echo "✔ 정리할 release 브랜치가 없다"; exit 0; }
  git rev-parse -q --verify "refs/heads/$RB" >/dev/null || git fetch -q origin "refs/heads/$RB:refs/heads/$RB" || die "$RB 를 가져오지 못했다"
  TIP="$(git rev-parse "$RB")"
  TC="$(remote_tag_commit "$TAG")" || die "원격 태그 조회 실패"
  { [ -n "$TC" ] && tag_is_release_merge "$TC"; } \
    || die "출고가 확인되지 않았다 — 원격 태그 $TAG 가 없거나 $RB 끝(${TIP:0:7})을 둘째 부모로 둔 origin/$BASE 위 머지 커밋이 아니다. 정리하지 않음(출고 전에 그만두려면 abort)" 2  # guard:finish-shipped
  if [ -d "$WT" ]; then
    wt_on_rb || die "worktree 자리 $WT 가 $RB 가 아니다 — 지우지 않음" 2
    wt_clean_or_die "정리"
  fi
  load_record
  process_prs
  if [ -n "$UNRESOLVED" ]; then
    [ "$LEAVE_OPEN" = 1 ] || die "$(unresolved_msg)${NL}release 브랜치·worktree 는 기록을 위해 남겨 둔다" 13
    note "⚠ --leave-open — MERGED 로 확인 안 된 PR:$UNRESOLVED — 그 head 는 지우지 않고 release 브랜치만 정리한다(PR 처리는 사람이)"
  fi
  if [ -d "$WT" ]; then
    git worktree remove --force "$WT" || die "release worktree 삭제 실패: $WT — 로컬·원격 $RB 는 그대로 뒀다"
    note "release worktree 삭제: $WT"
  fi
  git branch -q -D "$RB" || die "로컬 $RB 삭제 실패(다른 worktree 가 쓰는지 git worktree list 로 본다) — 원격 $RB 는 그대로 뒀다"
  note "로컬 $RB 삭제"
  RH="$(remote_head "$RB")" || die "원격 조회 실패"
  [ -z "$RH" ] || { git push -q origin --delete "$RB" || die "원격 $RB 삭제 실패" 11; note "원격 $RB 삭제"; }
  echo "✔ 정리 $RB — 출고 $TAG"
  exit 0
fi

# ════════════════════════════ ship ════════════════════════════
[ -n "$RB" ] || die "열린 release 브랜치가 없다 — cut → gather 먼저" 2
git rev-parse -q --verify "refs/heads/$RB" >/dev/null || die "$RB 가 원격에만 있다 — 같은 버전으로 다시 자르면 로컬에 붙인다:${NL}$(RECUT)" 2
[ ! -d "$WT" ] || { wt_on_rb || die "worktree 자리 $WT 가 $RB 가 아니다" 2; wt_clean_or_die "출고"; } # guard:ship-dirty
# 릴리즈 노트 — 실 실행은 필수(dry-run 은 노트를 쓰기 전 점검이라 없어도 된다)
if [ -n "$NOTES" ]; then
  [ -s "$NOTES" ] || die "릴리즈 노트 파일이 없거나 비었다: $NOTES" 2
elif [ "$DRY_RUN" != 1 ]; then
  die "--notes <릴리즈 노트 파일> 필수 — 모은 PR 본문을 읽고 쓴다(release 스킬). 머지 전에 거절" 2
fi
TIP="$(git rev-parse "$RB")"
load_record
[ -n "$RECORD" ] || die "$RB 에 모은 PR 이 없다 — gather 먼저" 2
# 기록 없는 merge — first-parent merge 의 둘째 부모가 origin/<base> 에 없고 어느 기록 SHA 에도 들어 있지 않으면 그 PR 은 출고 집합 밖이다
# (예: 충돌 해소를 --no-edit 대신 -m 으로 커밋). 출고 머지 전이면 거절(exit 2), dry-run·출고 뒤 재실행은 보고만. 그 PR 을 gather 로 다시 모으면 기록만 남는다
CUT_C="$(read_record "$RB" cut)"
UNREC=""
while read -r m _ p2 _rest; do
  [ -n "$m" ] || continue
  is_ancestor "$p2" "origin/$BASE" && continue # guard:unrec-main-parent
  hit=0; for r in $(echo "$RECORD" | awk '{print $2}'); do if is_ancestor "$p2" "$r"; then hit=1; break; fi; done
  [ "$hit" = 1 ] || UNREC="$UNREC${NL}  merge ${m:0:7}(둘째 부모 ${p2:0:7}) — git -C $(shq "$REPO") log -1 ${m:0:7}"
done <<M
$(git rev-list --first-parent --merges --parents "$CUT_C..$TIP")
M

# 어디까지 됐나 — 원격 태그 → release PR 머지 여부
TC="$(remote_tag_commit "$TAG")" || die "원격 태그 조회 실패"
STAGE=premerge; MC=""
if [ -n "$TC" ]; then
  tag_is_release_merge "$TC" \
    || die "원격 태그 $TAG(${TC:0:7})가 이 release 의 출고 머지 커밋(origin/$BASE 위 merge commit, 둘째 부모 = $RB 끝 ${TIP:0:7})이 아니다 — 출고하지 않음. 태그를 직접 확인한다:${NL}git -C $(shq "$REPO") ls-remote --tags origin $(shq "refs/tags/$TAG*")" 2 # guard:tag-merge
  STAGE=tagged; MC="$TC"
else
  RPM="$(merged_rp)" || die "release PR 조회 실패" 12
  if [ -n "$RPM" ]; then
    set -- $RPM
    [ "$2" = "$TIP" ] || die "release PR #$1 은 머지됐는데 그때 head(${2:0:7})가 지금 $RB 끝(${TIP:0:7})과 다르다 — 머지 뒤 release 브랜치에 커밋이 생겼다. 직접 확인한다" 2 # guard:rpm-tip
    STAGE=merged; RPN="$1"; MC="$3"
  fi
fi

if [ -n "$UNREC" ]; then
  if [ "$STAGE" = premerge ] && [ "$DRY_RUN" != 1 ]; then
    die "기록 없는 merge 가 있다 — 그 PR 은 출고 집합 밖이라 출고하지 않음(LA 전이·head 처리에서 빠진다). 어느 PR 인지 보고 그 PR 을 gather 로 다시 모은 뒤 ship:$UNREC${NL}$(shq "$SCRIPT_DIR/release.sh") gather --prs '<그 PR 번호>'$RARGS" 2 # guard:unrecorded
  fi
  note "⚠ 기록 없는 merge — 어느 PR 인지 보고 그 PR 을 gather 로 다시 모으면 출고 집합에 들어간다:$UNREC"
fi

# 빌드 전제 — 머지(되돌릴 수 없음) 전에 본다. 이미 Release 까지 끝났으면 빌드하지 않으므로(재실행 안내만) 보지 않는다
REL_URL=""; [ "$STAGE" != tagged ] || REL_URL="$(gh release view "$TAG" --json url --jq .url 2>/dev/null || true)"
WILL_BUILD=1; [ -z "$REL_URL" ] || WILL_BUILD=0
if [ "$WILL_BUILD" = 1 ] && [ "$SKIP_BUILD" = 0 ]; then
  NODE_V="$(node -p 'process.versions.node' 2>/dev/null)" || die "node 가 없다 — dmg 빌드에 필요(--skip-build 면 생략)" 2
  case "$NODE_V" in 24.*) ;; 22.*) note "node $NODE_V — 로컬 관문 기준은 v24 다(경고만)" ;;
    *) die "node $NODE_V — engines(>=22.12)·로컬 관문(v24) 밖이라 dmg 빌드를 거절한다. v24 를 PATH 앞에 두거나 --skip-build" 2 ;; esac
  command -v clang >/dev/null 2>&1 || die "clang 이 없다 — dmg 빌드(메모리 도우미)에 필요. xcode-select --install 또는 --skip-build" 2
fi
if [ "$WILL_BUILD" = 1 ] && [ "$SKIP_APK" = 0 ]; then
  [ -x "$SCRIPT_DIR/release-apk.sh" ] || die "scripts/release-apk.sh 가 없다 — APK 를 빼려면 --skip-apk — 아무것도 머지하지 않음" 2
  APK_PRE="$("$SCRIPT_DIR/release-apk.sh" --preflight 2>&1)" \
    || die "APK 전제 미달 — 아무것도 머지하지 않음(APK 를 빼려면 --skip-apk): $(echo "$APK_PRE" | tail -1)" 2
  APK_PRE="$(echo "$APK_PRE" | grep '^· APK 전제' | head -1 || true)"
fi
if [ "$WILL_BUILD" = 1 ]; then
  [ -x "$SCRIPT_DIR/release-upload.sh" ] || die "scripts/release-upload.sh 가 없다 — dmg·APK 를 Release 에 올릴 수 없다 — 아무것도 머지하지 않음" 2 # guard:upload-present
fi

# 기록된 PR 마다 지금 head 가 release 끝(TIP)에 들어 있는가 → MOVED(움직인 PR 목록)·PRLIST(PR 본문용). 닫힘·base 변경은 exit 2
check_heads() {
  local n sha info
  MOVED=""; PRLIST=""
  while read -r n sha; do
    [ -n "$n" ] || continue
    info="$(gh pr view "$n" --json state,baseRefName,headRefName,headRefOid --jq '"\(.state) \(.baseRefName) \(.headRefName) \(.headRefOid)"')" \
      || die "PR #$n 조회 실패 — 아무것도 머지하지 않음" 2
    set -- $info
    case "$1" in
      OPEN) ;;
      MERGED) note "PR #$n 은 이미 머지됨(release 밖에서) — 그대로 둔다"; PRLIST="$PRLIST- #$n ($3) @ ${4:0:7}$NL"; continue ;;
      *) die "모은 PR #$n 상태가 $1 — 출고하지 않음. 다시 열거나, 접고(abort) 다시 자른다" 2 ;;
    esac
    [ "$2" = "$BASE" ] || die "모은 PR #$n 의 base 가 $2 로 바뀌었다 — 출고하지 않음" 2 # guard:base-changed
    git cat-file -e "$4^{commit}" 2>/dev/null || git fetch -q origin "refs/heads/$3" 2>/dev/null || true
    is_ancestor "$4" "$TIP" || MOVED="$MOVED${NL}  #$n ($3): 모은 ${sha:0:7} → 지금 ${4:0:7}"  # guard:head-moved
    PRLIST="$PRLIST- #$n ($3) @ ${4:0:7}$NL"
  done <<R
$RECORD
R
}
GATHER_AGAIN() { echo "$(shq "$SCRIPT_DIR/release.sh") gather --prs $(shq "$(echo "$RECORD" | awk '{printf "%s%s", (NR > 1 ? " " : ""), $1}')")$RARGS"; }

# 머지 전 점검 — release 브랜치가 main 을 품는가 · 버전 · 원격 release 브랜치 · 기록된 PR 마다 지금 head 가 들어 있는가
if [ "$STAGE" = premerge ]; then
  is_ancestor "origin/$BASE" "$TIP" \
    || die "origin/$BASE 가 자른 뒤 움직였다 — $RB 가 $BASE 끝을 품지 않는다. release worktree 에서 $BASE 를 merge 한 뒤 다시(rebase 금지):${NL}git -C $(shq "$WT") merge origin/$BASE${NL}$(shq "$SCRIPT_DIR/release.sh") ship --notes <파일>$RARGS" 2  # guard:base-contained
  [ "$(pkg_version "$(git show "$TIP:app/package.json")")" = "$VER" ] \
    || die "$RB 끝의 app/package.json 버전이 $VER 이 아니다 — 모은 PR 이 버전을 바꿨는지 본다" 2 # guard:pkg-version
  RH="$(remote_head "$RB")" || die "원격 조회 실패"
  if [ -n "$RH" ] && [ "$RH" != "$TIP" ]; then
    git cat-file -e "$RH^{commit}" 2>/dev/null || git fetch -q origin "refs/heads/$RB" || true
    is_ancestor "$RH" "$TIP" || die "원격 $RB(${RH:0:7})가 로컬(${TIP:0:7})에 없는 커밋을 가졌다 — 직접 확인한다" 2 # guard:remote-ahead
  fi
  check_heads
  [ -z "$MOVED" ] || die "모은 뒤 head 가 움직인 PR 이 있다 — 그대로 내보내면 그 PR 은 열린 채 남고 새 커밋은 출고되지 않는다. 다시 모은 뒤 ship(아무것도 머지하지 않음):$MOVED${NL}$(GATHER_AGAIN)" 2
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "── dry-run (push·PR·머지·태그 없음) ──"
  echo "release 브랜치 $RB @ ${TIP:0:7} → base $BASE @ $(git rev-parse --short "origin/$BASE"), 태그 $TAG"
  echo "단계: $STAGE"
  echo "$RECORD" | while read -r n sha; do [ -n "$n" ] && echo "  출고 집합 #$n @ ${sha:0:7}"; done
  [ "$SKIP_BUILD" = 1 ] && echo "dmg: 건너뜀(--skip-build)" || echo "dmg: node ${NODE_V:-?} 로 빌드 예정"
  [ "$SKIP_APK" = 1 ] && echo "APK: 건너뜀(--skip-apk)" || echo "APK: 매 출고 빌드 예정(preview 로컬 빌드, dmg 뒤) — ${APK_PRE:-전제 점검 생략(이미 Release 까지 끝남)}"
  [ "$SKIP_BUILD" = 1 ] && echo "올리기: 건너뜀(--skip-build — dmg 뒤 명령 안내)" || echo "올리기: dmg$([ "$SKIP_APK" = 1 ] || echo "·APK") 뒤 Release 에(release-upload.sh)"
  [ -n "$NOTES" ] && echo "릴리즈 노트: $NOTES" || echo "릴리즈 노트: 아직 없음 — 실 실행에는 --notes 필수"
  exit 0
fi

# 재실행 안내 (LIFE-599) — 명령은 홀로 한 줄, 단일 따옴표 인용
rerun_cmds() {
  local tag="$1" wt
  OUT_DIR="$REPO/app/dist/release/$tag"
  APK_RERUN="$(shq "$SCRIPT_DIR/release-apk.sh") --from-tag $(shq "$tag") --tag-prefix $(shq "$PREFIX") --out $(shq "$OUT_DIR")"
  wt="$WT_ROOT/_dmg-$tag-$(date +%Y%m%d-%H%M%S)"
  DMG_RERUN="git -C $(shq "$REPO") fetch origin $(shq "refs/tags/$tag:refs/tags/$tag") && git -C $(shq "$REPO") worktree add --detach $(shq "$wt") $(shq "refs/tags/$tag") && $(shq "$wt/scripts/release-dmg.sh") --tag-prefix $(shq "$PREFIX") --out $(shq "$OUT_DIR")"
  DMG_DONE="git -C $(shq "$REPO") worktree remove --force $(shq "$wt")"
  # Release 에 올리기 — UPLOAD_ALL 은 dmg·APK 둘 다, UPLOAD_RERUN 은 이번 플래그대로(--skip-apk 면 dmg 만)
  UPLOAD_ALL="$(shq "$SCRIPT_DIR/release-upload.sh") --tag $(shq "$tag") --tag-prefix $(shq "$PREFIX") --dir $(shq "$OUT_DIR")"
  UPLOAD_RERUN="$UPLOAD_ALL$([ "$SKIP_APK" = 0 ] || echo ' --no-apk')"
}
SHIP_RERUN="$(shq "$SCRIPT_DIR/release.sh") ship --notes $(shq "${NOTES:-<파일>}")$RARGS$([ "$SKIP_BUILD" = 0 ] || echo ' --skip-build')$([ "$SKIP_APK" = 0 ] || echo ' --skip-apk')"

if [ "$STAGE" = premerge ]; then
  # 1. release 브랜치 push
  if [ "$(remote_head "$RB")" != "$TIP" ]; then
    git push -q origin "$TIP:refs/heads/$RB" || die "release 브랜치 $RB push 실패 — main·태그는 그대로다. 원인을 보고 같은 명령을 다시:${NL}$SHIP_RERUN" 11
    note "release 브랜치 push: $RB @ ${TIP:0:7}"
  fi
  # 2. release → base PR (열린 것이 있으면 재사용, 한 개)
  RPN="$(gh pr list --head "$RB" --base "$BASE" --state open --json number --jq '.[0].number // empty')" || die "release PR 조회 실패" 12
  if [ -z "$RPN" ]; then
    BODY="출고 $TAG — scripts/release.sh ship. 머지·태그·Release 는 이 스크립트 한 경로로만 한다(웹 UI 머지 금지).${NL}${NL}모은 PR(PR 을 만들 때의 참고용 — 재사용하면 갱신하지 않는다. 출고 집합은 release 브랜치의 Release-PR 기록이다):${NL}$PRLIST"
    URL="$(gh pr create --base "$BASE" --head "$RB" --title "release: $TAG" --body "$BODY")" \
      || die "release PR 생성 실패 — $RB 는 push 됐다. 같은 명령을 다시(열린 release PR 이 있으면 재사용한다):${NL}$SHIP_RERUN" 12
    RPN="${URL##*/}"
    case "$RPN" in ''|*[!0-9]*) die "release PR 번호를 읽지 못했다: $URL" 12 ;; esac
    note "release PR #$RPN 생성 ($URL)"
  else note "release PR #$RPN 재사용"; fi
  # 3. 머지 가능 판정 → 머지(release 끝 SHA 고정)
  TRIES="${RELEASE_MERGEABLE_TRIES:-10}"; MST=""
  for _ in $(seq 1 "$TRIES"); do # guard:mergeable-loop
    MST="$(gh pr view "$RPN" --json mergeable --jq .mergeable)" || MST=""
    [ "$MST" != UNKNOWN ] && [ -n "$MST" ] && break
    sleep "${RELEASE_MERGEABLE_STEP_S:-3}"
  done
  case "$MST" in
    MERGEABLE) ;;
    CONFLICTING) die "release PR #$RPN 이 $BASE 와 충돌 — 머지 안 함. release worktree 에서 git -C $(shq "$WT") merge origin/$BASE 로 풀고 커밋한 뒤 다시:${NL}$SHIP_RERUN" 3 ;;
    *) die "release PR #$RPN 머지 가능 판정이 나오지 않음($MST) — 머지 안 함. 잠시 뒤 같은 명령을 다시:${NL}$SHIP_RERUN" 5 ;;
  esac
  # 머지 직전 다시 — push·PR 생성·판정 대기 사이에 원래 PR head 가 움직였으면 머지하지 않는다. 이 확인과 gh pr merge 사이에
  # 남는 짧은 창의 이동은 막을 수 없다 — 그 PR 은 OPEN 으로 남고 원래 PR 처리가 exit 13 으로 받는다
  check_heads
  [ -z "$MOVED" ] || die "머지 직전 다시 보니 모은 뒤 head 가 움직인 PR 이 있다 — 머지하지 않음(release PR #$RPN 은 열린 채 둔다). 다시 모은 뒤 같은 ship(release PR 재사용):$MOVED${NL}$(GATHER_AGAIN)${NL}$SHIP_RERUN" 2 # guard:late-head
  gh pr merge "$RPN" --merge --match-head-commit "$TIP" \
    || die "release PR #$RPN 머지 거절 — head 가 바뀌었거나 머지 불가. PR 상태를 보고 같은 명령을 다시:${NL}$SHIP_RERUN" 6
  MC="$(gh pr view "$RPN" --json state,mergeCommit --jq 'select(.state == "MERGED") | .mergeCommit.oid')" \
    || die "release PR #$RPN 머지 결과 조회 실패 — 머지는 됐을 수 있다. 같은 명령을 다시 돌리면 이어 간다:${NL}$SHIP_RERUN" 6
  [ -n "$MC" ] || die "release PR #$RPN 이 MERGED 가 아니다" 6
  STAGE=merged
fi

if [ "$STAGE" = merged ]; then
  # 4. 머지 결과 확인 — merge commit(부모 2개, 둘째 부모 = release 끝) · 버전
  git fetch -q origin "$BASE" || die "release PR 머지 뒤 origin/$BASE 를 가져오지 못했다 — 머지는 끝났다. 같은 명령을 다시 돌리면 태그부터 이어 간다:${NL}$SHIP_RERUN" 7
  git cat-file -e "$MC^{commit}" 2>/dev/null || die "머지 커밋 ${MC:0:7} 을 가져오지 못했다" 6
  set -- $(git rev-list --parents -n 1 "$MC")
  [ $# = 3 ] || die "release PR 머지 커밋 ${MC:0:7} 부모가 2개가 아니다 — squash·rebase 머지 설정 확인" 6
  [ "$3" = "$TIP" ] || die "머지 커밋 ${MC:0:7} 의 둘째 부모가 $RB 끝(${TIP:0:7})이 아니다 — 태그를 달지 않음. release PR·main 을 직접 확인한다" 6 # guard:second-parent
  [ "$(pkg_version "$(git show "$MC:app/package.json")")" = "$VER" ] || die "머지 커밋의 app/package.json 버전이 $VER 이 아니다" 6
  note "release PR #${RPN:-?} 머지 → ${MC:0:7} (merge commit)"
  # 5. 태그 = main 끝(머지 커밋). main 에 직접 push 하는 것은 이 태그뿐이다
  if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    git tag -d "$TAG" >/dev/null && note "원격에 없는 로컬 태그 $TAG 삭제(앞선 push 실패 잔재)"
  fi
  git tag -a "$TAG" "$MC" -m "release $TAG" -m "PR:$(echo "$RECORD" | awk '{printf " #%s", $1}')" \
    || die "로컬 태그 $TAG 를 만들지 못했다 — release PR 머지는 끝났다(${MC:0:7}). 원인을 보고 같은 명령을 다시(태그부터 이어 간다):${NL}$SHIP_RERUN" 7
  if ! git push -q origin "refs/tags/$TAG"; then
    git tag -d "$TAG" >/dev/null 2>&1 || true
    die "태그 $TAG push 실패 — release PR 머지는 끝났다(${MC:0:7}). 로컬 태그는 지웠다 — 같은 명령을 다시 돌리면 태그부터 이어 간다:${NL}$SHIP_RERUN" 7
  fi
  note "버전 $VER, 태그 $TAG push (${MC:0:7})"
  STAGE=tagged
fi
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git fetch -q origin "refs/tags/$TAG:refs/tags/$TAG" || true

# 6. GitHub Release — 리허설 태그는 prerelease. 이미 있으면 앞선 실행이 여기까지 왔다 — 빌드하지 않고 안내만
rerun_cmds "$TAG"
if [ -n "$REL_URL" ]; then
  note "GitHub Release $TAG 는 이미 있다($REL_URL) — 출고는 앞선 실행에서 끝났다. 원래 PR 처리만 다시 본다"
else
  REL_FLAG=""; [ "$PREFIX" = "v" ] || REL_FLAG="--prerelease"
  gh release create "$TAG" --verify-tag --title "$TAG" --notes-file "$NOTES" $REL_FLAG >/dev/null \
    || die "GitHub Release 생성 실패 — 머지·태그 $TAG push 는 끝났다. 같은 명령을 다시 돌리면 Release 부터 이어 간다:${NL}$SHIP_RERUN" 9 # guard:verify-tag
  note "GitHub Release $TAG ($(gh release view "$TAG" --json url --jq .url))"
fi

# 7. 본체 checkout fast-forward — release-ff.sh(LIFE-672). 실패해도 경고만
if [ -x "$SCRIPT_DIR/release-ff.sh" ]; then
  FF_RC=0; "$SCRIPT_DIR/release-ff.sh" --repo "$REPO" --base "$BASE" --tag "$TAG" || FF_RC=$?
  case "$FF_RC" in
    0|3|7) ;;
    *) note "⚠ 본체 $BASE 는 fast-forward 하지 않았다(위 원인) — 출고(원격)는 끝났다. 본체를 손으로 맞춘다" ;;
  esac
else
  note "⚠ scripts/release-ff.sh 가 없어 본체 $BASE fast-forward 를 건너뜀 — 출고(원격)는 끝났다. 본체를 손으로 맞춘다"
fi

# 8. 원래 PR 처리 — 간접 머지 확인 뒤에만 head 삭제. 결과는 끝에서 판정(dmg·APK 는 막지 않는다)
process_prs

if [ -n "$REL_URL" ]; then
  echo "✔ 출고 $TAG 는 이미 끝났다 — dmg·APK 가 빠졌다면 아래 명령을 그대로 붙여 넣는다"
  echo "dmg 만:"; echo "$DMG_RERUN"; echo "dmg 가 끝나면 임시 worktree 정리:"; echo "$DMG_DONE"
  echo "APK 만:"; echo "$APK_RERUN"
  echo "dmg·APK 뒤 Release 에 올리기(이미 올라간 것은 건너뛴다):"; echo "$UPLOAD_RERUN"
  [ -z "$UNRESOLVED" ] || die "$(unresolved_msg)" 13
  echo "□ 다음: 설치 확인 뒤 $(shq "$SCRIPT_DIR/release.sh") finish$RARGS"
  exit 0
fi
PR_TAIL=""; [ -z "$UNRESOLVED" ] || PR_TAIL="${NL}그리고 $(unresolved_msg)"

# 9. dmg·APK — 그 태그 위 깨끗한 임시 worktree 에서만
TMPWT="$WT_ROOT/_release-$(date +%Y%m%d-%H%M%S)"
cleanup() { [ -d "$TMPWT" ] && git -C "$REPO" worktree remove --force "$TMPWT" >/dev/null 2>&1; git -C "$REPO" worktree prune; }
trap cleanup EXIT
git worktree add -q --detach "$TMPWT" "refs/tags/$TAG" \
  || die "dmg·APK 용 임시 worktree 를 만들지 못했다($TMPWT) — 머지·태그 $TAG push·Release 는 끝났다(다시 출고하지 않는다). 원인(디스크·권한)을 풀고 아래 명령을 그대로 붙여 넣는다${NL}dmg 만:${NL}$DMG_RERUN${NL}dmg 가 끝나면 임시 worktree 정리:${NL}$DMG_DONE${NL}APK 만:${NL}$APK_RERUN${NL}dmg·APK 뒤 Release 에 올리기:${NL}$UPLOAD_RERUN$PR_TAIL" 8
if [ "$SKIP_BUILD" = 1 ]; then
  note "--skip-build — dmg 는 나중에(그대로 붙여 넣는다):"
  echo "$DMG_RERUN"
  echo "$DMG_DONE"
  UP_LATER="${NL}dmg$([ "$SKIP_APK" = 1 ] || echo "·APK") 뒤 Release 에 올리기:${NL}$UPLOAD_RERUN"
else
  APK_TAIL=""; [ "$SKIP_APK" = 1 ] || APK_TAIL="${NL}APK 는 아직이다 — dmg 뒤 APK:${NL}$APK_RERUN"
  APK_TAIL="$APK_TAIL${NL}dmg$([ "$SKIP_APK" = 1 ] || echo "·APK") 뒤 Release 에 올리기:${NL}$UPLOAD_RERUN"
  "$TMPWT/scripts/release-dmg.sh" --tag-prefix "$PREFIX" --out "$OUT_DIR" \
    || die "dmg 실패 — 머지·태그 $TAG push·Release 는 끝났다(다시 출고하지 않는다). 아래 명령을 그대로 붙여 넣는다${NL}dmg 만 다시:${NL}$DMG_RERUN${NL}dmg 가 끝나면 임시 worktree 정리:${NL}$DMG_DONE$APK_TAIL$PR_TAIL" 8
fi
if [ "$SKIP_APK" = 1 ]; then
  note "--skip-apk — APK 는 나중에(그대로 붙여 넣는다):"
  echo "$APK_RERUN"
  UP_LATER="${UP_LATER:-}${NL}APK 뒤 Release 에 APK 더하기(올라간 dmg 는 건너뛴다):${NL}$UPLOAD_ALL"
else
  "$TMPWT/scripts/release-apk.sh" --tag-prefix "$PREFIX" --out "$OUT_DIR" \
    || die "APK 실패 — 머지·태그 $TAG push·Release$([ "$SKIP_BUILD" = 1 ] || echo "·dmg") 는 끝났다(다시 출고하지 않는다). 아래 명령을 그대로 붙여 넣는다 — APK 가 끝나야 올린다(&&, 올리기만 따로 치지 않는다: 맨 위 APK 는 검증에서 거절된 것일 수 있다)${NL}(맨 위에 APK 가 남아 있으면 새 APK 는 retry-<시각>/ 에 생긴다 — 그때 올리기는 아무것도 올리지 않고 후보 APK 마다 --apk 명령을 보인다. release-apk.sh 가 「✔ $TAG apk: <경로>」 로 낸 것을 고른다)${NL}APK 만 다시 → Release 에 올리기:${NL}$APK_RERUN && $UPLOAD_ALL$PR_TAIL" 10 # guard:apk-chain
fi

# 10. Release 에 dmg·APK·체크섬 올리기 — dmg 가 있어야 한다(--skip-build 면 위 안내의 명령으로 나중에)
#     dmg·APK 와 같이 태그 worktree 사본을 부른다. 재실행 안내(UPLOAD_*)는 임시 worktree 정리 뒤에도 남는 $SCRIPT_DIR 사본이다
UP_FLAG=""; [ "$SKIP_APK" = 0 ] || UP_FLAG=--no-apk # guard:upload-noapk
if [ "$SKIP_BUILD" = 0 ]; then # guard:upload-run
  "$TMPWT/scripts/release-upload.sh" --tag "$TAG" --tag-prefix "$PREFIX" --dir "$OUT_DIR" $UP_FLAG \
    || die "Release 에 올리기 실패 — 머지·태그 $TAG push·Release·dmg$([ "$SKIP_APK" = 1 ] || echo "·APK") 는 끝났다(다시 출고·빌드하지 않는다). 원인을 보고 아래 명령을 그대로 붙여 넣는다(이미 올라간 것은 건너뛴다)${NL}올리기만 다시:${NL}$UPLOAD_RERUN$PR_TAIL" 14 # guard:upload-fail
fi
[ -z "${UP_LATER:-}" ] || echo "${UP_LATER#"$NL"}"

[ -z "$UNRESOLVED" ] || die "출고 $TAG 는 끝났다(태그·Release$([ "$SKIP_BUILD" = 1 ] || echo "·dmg")$([ "$SKIP_APK" = 1 ] || echo "·APK")$([ "$SKIP_BUILD" = 1 ] || echo "·올리기")). 그런데 $(unresolved_msg)" 13
APK_LATER=""; [ "$SKIP_APK" = 0 ] || APK_LATER=" — --skip-apk 였으니 APK 를 먼저 만든다"
echo "✔ 출고 $TAG —$(echo "$RECORD" | awk '{printf " #%s", $1}')"
echo "□ 다음: ① 출고된 PR 의 LIFE 일감마다 LA '완료' 전이 ② dmg 설치(app/INSTALL.md 「설치」) ③ 폰 APK 덮어 설치 scripts/release-apk-install.sh --serial <폰 시리얼> --apk $OUT_DIR/corral-mobile-$VER.apk (서명 대조 뒤 install -r$APK_LATER) ④ release 브랜치·worktree 정리 $(shq "$SCRIPT_DIR/release.sh") finish$RARGS ⑤ 남은 로컬 정리 scripts/task-finish.sh <LIFE-NNN-슬러그>"
