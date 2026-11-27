#!/usr/bin/env bash
# LIFE-703 빠른 확인(C8) — scripts/release.sh 새 흐름(cut·gather·ship·finish·abort)을 로컬 bare 원격 + 가짜 gh 로 케이스별로 돌린다.
# app/scripts/release-check/release-test.sh <원자료 폴더> [케이스 …]   (케이스 생략 = 전부, 목록은 ALL)
# 실제 GitHub·본체 checkout 무접촉. 케이스마다 새 bare origin + clone(= 「본체」 B)을 만들고 release.sh·release-ff.sh 사본을 B 에 커밋한다.
# 가짜 gh = fake-gh.sh(간접 머지·head 삭제 → CLOSED·merge commit 머지 흉내). origin 에 update 훅을 달아 **push 로 들어온 ref 갱신**을
# push-log.txt 에 남긴다 — 가짜 gh 의 머지는 update-ref 라 남지 않으므로, refs/heads/main 줄이 있으면 스크립트가 main 에 직접 push 한 것이다(C3ⓕ).
# 양성 대조: L703_MUTANT=<가드 이름> 이면 B 의 release.sh 사본에서 「# guard:<이름>」 줄의 die 를 true 로 바꾼다(mutate.sh 가 쓴다).
#   L703_MUTANT_SED 가 있으면 그 sed 스크립트를 대신 적용한다(die 가 아닌 가드 — 루프·재계산·플래그).
#   L703_MUTANT_TARGET=upload 면 release.sh 대신 release-upload.sh 사본에 적용한다(LIFE-729).
# Release 올리기(LIFE-729): upload-* 는 B 의 release-upload.sh 사본을 가짜 gh 의 asset 흉내 위에서 직접 돌리고, ship-* 는 ship 이 부르는 경로를 본다.
# 임시 폴더는 /tmp/l703.XXXXXX(짧은 고정 접두). 끝나면 지운다.
set -uo pipefail

ALL="old-usage cut-ok cut-dry cut-rerun cut-minor cut-version cut-ver-low cut-tag-exists cut-open-local cut-open-remote cut-otherrepo cut-reattach
gather-ok gather-dry gather-nocut gather-precheck gather-conflict gather-dirty gather-headmove gather-already
gather-stacked gather-after-exit7 record-cutquote cut-reattach-after-merge
ship-ok ship-dry ship-nonotes ship-headmoved ship-mainmoved ship-closedpr ship-rerun ship-tagfail ship-releasefail ship-mergefail ship-unknown ship-createfail ship-noindirect
ship-dirty ship-headmove-late ship-tag-on-tip ship-unrecorded-merge ship-indirect-late ship-mergeable-late
ship-forged-record ship-forged-record2 ship-build-ok ship-build-dmgfail ship-build-apkfail ship-build-rerun ship-build-prefail
ship-pkgver ship-remote-ahead ship-merged-moved ship-second-parent ship-base-changed ship-tmpwt-fail ship-rerun-unresolved
cut-open-nonsemver cut-after-13 ns-newline ns-rehearsal-realhead
wt-rmrf wt-rmrf-remote wt-rmrf-abort wt-rmrf-finish wt-rmrf-cut-fresh reuse-name forged-abort-recut
ns-bothbad main-merge-recovery main-merge-recovery-gather protected-head
abort-ok abort-pushed abort-dirty abort-shipped abort-after-merge abort-branchbusy finish-leave-open finish-ok finish-unshipped finish-dirty finish-headmoved finish-deletefail finish-tag-on-tip
ns-main-rehearsal ns-throwaway-v ns-base-only ns-prefix-only ns-other-base ns-gather-half ns-ship-half ns-pipe-base ns-pipe-both ns-chars ns-rehearsal ns-rehearsal-default
fakegh-fidelity
upload-empty upload-rerun upload-partial upload-mismatch upload-mismatch-sum upload-open upload-nodigest upload-norelease upload-badtag upload-badprefix
upload-verdiff upload-dirtag upload-noapk-missing upload-apk-later upload-failmid upload-openmid upload-verify-lie upload-dry fakegh-upload-shape
upload-retry-reject upload-apk-place upload-stdin upload-verify-state ship-build-apkbad
ship-build-uploadfail ship-build-skipapk ship-skipbuild-upload ship-noupload"
OUT="${1:?원자료 폴더}"; shift
CASES="${*:-$ALL}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REL="$ROOT/scripts/release.sh"
UPL="$ROOT/scripts/release-upload.sh"
mkdir -p "$OUT" || exit 1
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d /tmp/l703.XXXXXX)" || { echo "mktemp 실패" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
SUMMARY="$OUT/summary.txt"; : > "$SUMMARY"
MUT="${L703_MUTANT:-}"
echo "# release-test $(date '+%F %T') · git $(git --version | cut -d' ' -f3-) · bash $BASH_VERSION · work $WORK · release.sh sha1 $(shasum < "$REL" | cut -c1-12) · release-upload.sh sha1 $(shasum < "$UPL" | cut -c1-12) · fake-gh sha1 $(shasum < "$HERE/fake-gh.sh" | cut -c1-12)${MUT:+ · 변이 $MUT}" | tee -a "$SUMMARY"

# 사용자 git 설정을 끊는다(서명·훅·이름) — 하네스 전용 전역 설정
cat > "$WORK/gitconfig" <<EOF
[user]
	name = l703
	email = l703@example.invalid
[commit]
	gpgsign = false
[tag]
	gpgsign = false
[init]
	defaultBranch = main
[advice]
	detachedHead = false
EOF
export GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CONFIG_NOSYSTEM=1
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

FAILS=0
check() { # check <설명> <명령…>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $d" >> "$LOG"; else echo "  FAIL $d" >> "$LOG"; CASE_FAIL=1; fi
}
has() { grep -qF -- "$1" "$LAST"; }
hasnt() { ! grep -qF -- "$1" "$LAST"; }
not() { ! "$@"; }
eq() { [ "$1" = "$2" ] || { echo "    기대 '$2' · 실제 '$1'" >> "$LOG"; return 1; }; }

setup() {
  W="$WORK/$CASE"; mkdir -p "$W/bin" "$W/gh/pr" "$W/gh/release"
  O="$W/origin.git"; B="$W/main"; H="$W/helper"
  git init -q --bare "$O"
  cat > "$O/hooks/update" <<EOF
#!/bin/sh
echo "\$1 \$2 \$3" >> "$W/push-log.txt"
case "\$1" in refs/tags/*) [ -e "$W/reject-tags" ] && { echo "흉내: 태그 push 거절" >&2; exit 1; } ;; esac
if [ -e "$W/reject-delete" ] && [ "\$1" = "\$(cat "$W/reject-delete")" ] && [ "\$3" = 0000000000000000000000000000000000000000 ]; then echo "흉내: 삭제 거절" >&2; exit 1; fi
exit 0
EOF
  chmod +x "$O/hooks/update"; : > "$W/push-log.txt"
  git clone -q "$O" "$B" 2>/dev/null
  mkdir -p "$B/scripts" "$B/app"
  if [ -n "$MUT" ] && [ "${L703_MUTANT_TARGET:-release}" = release ]; then
    sed "${L703_MUTANT_SED:-/# guard:$MUT\$/ s/die \"/true \"/; /# guard:$MUT\$/ s/|| MOVED=/|| true MOVED=/}" "$REL" > "$B/scripts/release.sh"
  else cp "$REL" "$B/scripts/release.sh"; fi
  if [ -n "$MUT" ] && [ "${L703_MUTANT_TARGET:-release}" = upload ]; then
    sed "${L703_MUTANT_SED:-/# guard:$MUT\$/ s/die \"/true \"/}" "$UPL" > "$B/scripts/release-upload.sh"
  else cp "$UPL" "$B/scripts/release-upload.sh"; fi
  chmod +x "$B/scripts/release.sh" "$B/scripts/release-upload.sh"
  cp "$ROOT/scripts/release-ff.sh" "$B/scripts/"
  printf '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}\n' > "$B/app/package.json"
  printf '{\n  "name": "x",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "0.1.0"\n    }\n  }\n}\n' > "$B/app/package-lock.json"
  printf '.claude/worktrees/\napp/dist/\n' > "$B/.gitignore"
  printf 'a\nb\nc\n' > "$B/shared.txt"
  git -C "$B" add -A; git -C "$B" commit -qm "초기"; git -C "$B" push -q origin HEAD:main
  : > "$W/push-log.txt"
  git clone -q "$O" "$H" 2>/dev/null
  cp "$HERE/fake-gh.sh" "$W/bin/gh"; chmod +x "$W/bin/gh"
  echo "노트" > "$W/notes.md"
  N=0
}
# mkpr <번호> <head> <파일> <내용> [base] [feature]  — head 브랜치를 base 끝에서 만들어 push 하고 OPEN PR 로 등록
mkpr() {
  local n="$1" head="$2" file="$3" body="$4" base="${5:-main}" kind="${6:-plain}"
  git -C "$H" fetch -q origin
  git -C "$H" checkout -q -B "$head" "origin/$base"
  if [ "$kind" = feature ]; then # 묶음 모양 — 자식 브랜치 커밋을 feature 로 merge 한 head(자식 merge 커밋을 품는다)
    git -C "$H" checkout -q -b "$head-child"
    echo "$body" > "$H/$file"; git -C "$H" add -A; git -C "$H" commit -qm "자식 $n"
    git -C "$H" checkout -q "$head"; git -C "$H" merge -q --no-ff -m "Merge $head-child into $head" "$head-child"
  else
    printf '%s\n' "$body" > "$H/$file"; git -C "$H" add -A; git -C "$H" commit -qm "PR $n"
  fi
  git -C "$H" push -q origin "$head"
  printf 'state=OPEN\nbase=%s\nhead=%s\ndraft=false\nfork=false\noid=%s\n' "$base" "$head" "$(git -C "$H" rev-parse HEAD)" > "$W/gh/pr/$n"
}
prpush() { # prpush <head> <파일> <내용> — PR head 에 커밋을 더해 push(출고 중 수정·head 이동)
  git -C "$H" fetch -q origin; git -C "$H" checkout -q -B "$1" "origin/$1"
  printf '%s\n' "$3" > "$H/$2"; git -C "$H" add -A; git -C "$H" commit -qm "수정 $1"; git -C "$H" push -q origin "$1"
}
prset() { sed -i '' "s/^$2=.*/$2=$3/" "$W/gh/pr/$1"; } # prset <번호> <키> <값>
# rel [env …] -- <인자…> — B 에서 release.sh 실행. RC·LAST(이번 출력)
rel() {
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  N=$((N + 1)); LAST="$W/run-$N.txt"
  ( cd "${RUN_CWD:-$B}" && env PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" RELEASE_INDIRECT_WAIT_S=0 RELEASE_INDIRECT_STEP_S=0 \
      RELEASE_MERGEABLE_STEP_S=0 RELEASE_MERGEABLE_TRIES=2 ${envs[@]+"${envs[@]}"} "$B/scripts/release.sh" "$@" ) > "$LAST" 2>&1
  RC=$?
  { echo "── run $N: release.sh $* ${envs[*]+${envs[*]}} → exit $RC"; sed 's/^/    /' "$LAST"; } >> "$LOG"
}
snap() { # ref·worktree 스냅숏(원격 전체 + B 의 ref + worktree 목록)
  { git --git-dir="$O" for-each-ref --format='O %(refname) %(objectname)'; git -C "$B" for-each-ref --format='B %(refname) %(objectname)' refs/heads refs/tags
    git -C "$B" worktree list --porcelain | grep '^worktree'; } | sort
}
oref() { git --git-dir="$O" rev-parse -q --verify "$1" 2>/dev/null || true; }
prstate() { (. "$W/gh/pr/$1"; echo "$state"); }
mainpushes() { grep -c '^refs/heads/main ' "$W/push-log.txt" || true; }
RB1="release/v0.1.1"; WT1() { echo "$B/.claude/worktrees/release-v0.1.1"; }
cutgather() { rel -- cut; rel -- gather --prs "$1"; }
# stubs — 스텁 release-dmg.sh·release-apk.sh 를 B 에 커밋(태그 worktree 에도 들어간다). 호출은 $W/stub.log 에 한 줄씩
stubs() {
  # 산출물 흉내(LIFE-729): 성공하면 --out 폴더에 corral-<버전>-arm64.dmg · corral-mobile-<버전>.apk 를 만든다(버전 = 그 트리의 app/package.json)
  cat > "$B/scripts/release-dmg.sh" <<S
#!/usr/bin/env bash
echo "dmg \$PWD \$(dirname "\$0") tag=\$(git -C "\$(dirname "\$0")" describe --tags --exact-match 2>/dev/null) \$*" >> "$W/stub.log"
[ -z "\${STUB_DMG_FAIL:-}" ] || exit 1
o=""; while [ \$# -gt 0 ]; do [ "\$1" = --out ] && o="\$2"; shift; done
v="\$(sed -n 's/^  "version": "\(.*\)",\$/\1/p' "\$(dirname "\$0")/../app/package.json")"
mkdir -p "\$o" && echo "dmg \$v" > "\$o/corral-\$v-arm64.dmg"
S
  cat > "$B/scripts/release-apk.sh" <<S
#!/usr/bin/env bash
if [ "\${1:-}" = --preflight ]; then echo "preflight" >> "$W/stub.log"; [ -z "\${STUB_APK_PRE_FAIL:-}" ] || { echo "✖ 스텁 전제 미달"; exit 1; }; echo "· APK 전제 스텁 통과"; exit 0; fi
echo "apk \$(dirname "\$0") \$*" >> "$W/stub.log"
[ -z "\${STUB_APK_FAIL:-}" ] || exit 1
[ ! -e "$W/stub-apk-fail" ] || { echo "✖ 스텁 APK 실패(파일 표지)"; exit 1; } # 붙여 넣은 줄 안의 APK 를 실패시킨다(env 가 안 넘어가는 자리)
o=""; while [ \$# -gt 0 ]; do [ "\$1" = --out ] && o="\$2"; shift; done
v="\$(sed -n 's/^  "version": "\(.*\)",\$/\1/p' "\$(dirname "\$0")/../app/package.json")"
# release-apk.sh 처럼 맨 위에 APK 가 있으면 retry-<시각>/ 에 만든다. STUB_APK_BADVERIFY 는 쓴 뒤 검증에서 거절(실제 순서 — 쓰고 나서 검증)
[ ! -e "\$o/corral-mobile-\$v.apk" ] || o="\$o/retry-\$(date +%Y%m%d-%H%M%S)"
mkdir -p "\$o" && echo "apk \$v\${STUB_APK_BADVERIFY:+ REJECTED}" > "\$o/corral-mobile-\$v.apk"
[ -z "\${STUB_APK_BADVERIFY:-}" ] || { echo "✖ 스텁 서명 SHA-256 이 다르다"; exit 1; }
echo "✔ stub apk: \$o/corral-mobile-\$v.apk"
S
  chmod +x "$B/scripts/release-dmg.sh" "$B/scripts/release-apk.sh"
  git -C "$B" add -A; git -C "$B" commit -qm "스텁 dmg·apk"; git -C "$B" push -q origin HEAD:main; : > "$W/push-log.txt"; : > "$W/stub.log"
}

# ── Release 올리기(LIFE-729) 도우미 ──
UT=v0.1.1 # 올리기 케이스의 태그 — T1(다른 케이스의 release 끝 SHA)과 이름을 나눈다
mkrel() { echo full > "$W/gh/release/$UT"; } # GitHub Release v0.1.1 흉내
mkart() { # mkart <폴더 이름> <버전> <dmg|apk …> — $W/art/<폴더>/ 에 산출물 흉내. ART = 그 폴더
  local d="$1" v="$2" x; shift 2; ART="$W/art/$d"; mkdir -p "$ART"
  for x in "$@"; do case "$x" in
    dmg) echo "dmg $v $CASE" > "$ART/corral-$v-arm64.dmg" ;; apk) echo "apk $v $CASE" > "$ART/corral-mobile-$v.apk" ;; esac; done
}
seedasset() { # seedasset <이름> <내용 파일> [state] — Release 에 이미 있는 asset
  mkdir -p "$W/gh/assets/$UT/files" "$W/gh/assets/$UT/state"; cp "$2" "$W/gh/assets/$UT/files/$1"; echo "${3:-uploaded}" > "$W/gh/assets/$UT/state/$1"
}
up() { # up [env …] -- <인자…> — B 의 release-upload.sh 사본. RC·LAST
  local envs=()
  while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  N=$((N + 1)); LAST="$W/run-$N.txt"
  ( cd "${RUN_CWD:-$B}" && env PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" ${envs[@]+"${envs[@]}"} "$B/scripts/release-upload.sh" "$@" ) > "$LAST" 2>&1
  RC=$?
  { echo "── run $N: release-upload.sh $* ${envs[*]+${envs[*]}} → exit $RC"; sed 's/^/    /' "$LAST"; } >> "$LOG"
}
paste_run() { # paste_run <명령 줄> — 안내에서 뽑은 줄을 그대로 다른 cwd(/)에서 실행. RC·LAST
  N=$((N + 1)); LAST="$W/run-$N.txt"
  ( cd / && env PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" bash -c "$1" ) > "$LAST" 2>&1
  RC=$?
  { echo "── run $N: (붙여 넣기) $1 → exit $RC"; sed 's/^/    /' "$LAST"; } >> "$LOG"
}
after() { awk -v k="$1" 'f { print; exit } $0 == k { f = 1 }' "$LAST"; } # after <줄> — 출력에서 그 줄 바로 다음 줄
nassets() { ls "$W/gh/assets/$UT/files" 2>/dev/null | wc -l | tr -d ' '; }
upcalls() { grep -c '^gh release upload' "$W/gh/calls.txt" 2>/dev/null || true; }
clobbers() { grep -c -- '--clobber' "$W/gh/calls.txt" 2>/dev/null || true; }
deletes() { if [ -f "$W/gh/calls.txt" ]; then grep -cE '^gh release delete-asset|^gh api .*(-X|--method) (DELETE|PATCH)' "$W/gh/calls.txt" || true; else echo 0; fi; } # 서버 asset 을 지우거나 고치는 호출
ghcalls() { if [ -f "$W/gh/calls.txt" ]; then wc -l < "$W/gh/calls.txt" | tr -d ' '; else echo 0; fi; }
astore() { (cd "$W/gh/assets" 2>/dev/null && find . -type f | sort | xargs shasum 2>/dev/null) || true; }
sdigest() { (cd "$B" && PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" gh api "repos/o/r/releases/tags/$UT" --jq ".assets[] | select(.name == \"$1\") | .digest"); }
lsha() { echo "sha256:$(shasum -a 256 "$1" | cut -d' ' -f1)"; }
# 받는 사람 흉내(C1ⓗ) — 서버 asset 을 새 폴더에 「받아」 체크섬 파일마다 shasum -a 256 -c. 체크섬 파일이 없으면 실패
dlcheck() {
  local d="$W/dl-$N" f n=0; rm -rf "$d"; mkdir -p "$d"; cp "$W/gh/assets/$UT/files/"* "$d/" || return 1
  for f in "$d"/*.sha256; do [ -f "$f" ] || return 1; (cd "$d" && shasum -a 256 -c "$(basename "$f")") >> "$LOG" 2>&1 || return 1; n=$((n + 1)); done
  [ "$n" = "${1:-2}" ]
}
# 체크섬 파일이 바이너리 전부를 덮는가 — 서버의 바이너리마다 <이름>.sha256 이 있다
covered() { local f; for f in "$W/gh/assets/$UT/files/"*; do case "$f" in *.sha256) ;; *) [ -f "$f.sha256" ] || return 1 ;; esac; done; }

for CASE in $CASES; do
  LOG="$OUT/$CASE.log"; : > "$LOG"; CASE_FAIL=0
  setup
  case "$CASE" in
    old-usage) # 옛 한 번 출고 인자는 하위 명령 없이 거절
      S0="$(snap)"; rel -- --prs 1 --notes "$W/notes.md"
      check "exit 1" eq "$RC" 1; check "하위 명령 안내" has "하위 명령이 필요하다"; check "ref 불변" eq "$(snap)" "$S0" ;;
    cut-ok) # C1 — origin/main 끝에서 release/v0.1.1 + worktree + 버전 커밋, push 없음
      rel -- cut
      check "exit 0" eq "$RC" 0
      check "로컬 $RB1" git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      check "worktree 가 $RB1" eq "$(git -C "$(WT1)" symbolic-ref --short HEAD)" "$RB1"
      check "release 끝 부모 = origin/main" eq "$(git -C "$B" rev-parse "$RB1^")" "$(oref refs/heads/main)"
      check "버전 0.1.1" grep -q '"version": "0.1.1"' "$(WT1)/app/package.json"
      check "lock 도 0.1.1" grep -q '"version": "0.1.1"' "$(WT1)/app/package-lock.json"
      check "Release-Cut 줄" eq "$(git -C "$B" log -1 --format=%B "$RB1" | grep -c '^Release-Cut: v0.1.1$')" 1
      check "원격 push 0건" eq "$(wc -l < "$W/push-log.txt" | tr -d ' ')" 0 ;;
    cut-dry) # C1ⓒ
      S0="$(snap)"; rel -- cut --dry-run
      check "exit 0" eq "$RC" 0; check "이름 출력" has "release 브랜치 $RB1"; check "worktree 이름" has "release-v0.1.1"
      check "ref·worktree 0건" eq "$(snap)" "$S0" ;;
    cut-rerun) # C1ⓑ
      rel -- cut; T1="$(git -C "$B" rev-parse "$RB1")"
      rel -- cut
      check "exit 0" eq "$RC" 0; check "재사용 문구" has "이미 있다(재사용"
      check "끝 불변" eq "$(git -C "$B" rev-parse "$RB1")" "$T1"
      check "버전 커밋 1개" eq "$(git -C "$B" rev-list --count "origin/main..$RB1")" 1
      check "worktree 1개" eq "$(git -C "$B" worktree list | grep -c release-v)" 1 ;;
    cut-minor)
      rel -- cut --bump minor
      check "exit 0" eq "$RC" 0; check "release/v0.2.0" git -C "$B" rev-parse -q --verify refs/heads/release/v0.2.0 ;;
    cut-version)
      rel -- cut --version 1.0.0
      check "exit 0" eq "$RC" 0; check "release/v1.0.0" git -C "$B" rev-parse -q --verify refs/heads/release/v1.0.0 ;;
    cut-ver-low) # C1ⓐ 다음 버전 ≤ 지금
      S0="$(snap)"; rel -- cut --version 0.1.0
      check "exit 2" eq "$RC" 2; check "사유" has "크지 않다"; check "ref·worktree 0건" eq "$(snap)" "$S0" ;;
    cut-tag-exists) # C1ⓐ 원격 태그 존재
      git -C "$B" tag v0.1.1 && git -C "$B" push -q origin v0.1.1 && git -C "$B" tag -d v0.1.1 >/dev/null
      git -C "$B" fetch -q --tags origin  # 모든 하위 명령의 첫 동작(원격 태그 미러) — 스냅숏 기준에 넣는다
      S0="$(snap)"; rel -- cut
      check "exit 2" eq "$RC" 2; check "사유" has "태그 v0.1.1 가 이미 있다"; check "ref·worktree 0건" eq "$(snap)" "$S0" ;;
    cut-open-local) # C1ⓐ 열린 release 브랜치(로컬)
      git -C "$B" branch release/v0.0.9 origin/main
      S0="$(snap)"; rel -- cut
      check "exit 2" eq "$RC" 2; check "사유에 이름" has "release/v0.0.9"; check "ref·worktree 0건" eq "$(snap)" "$S0" ;;
    cut-open-remote) # C1ⓐ 열린 release 브랜치(원격만)
      git -C "$H" push -q origin origin/main:refs/heads/release/v0.1.5
      S0="$(snap)"; rel -- cut
      check "exit 2" eq "$RC" 2; check "사유에 이름" has "release/v0.1.5"; check "ref·worktree 0건" eq "$(snap)" "$S0" ;;
    cut-otherrepo) # C1ⓐ 오용 — 다른 레포 안에서 부름
      git init -q "$W/other"; S0="$(snap)"
      RUN_CWD="$W/other" rel -- cut
      check "exit 2" eq "$RC" 2; check "사유" has "다른 git 레포"; check "ref·worktree 0건" eq "$(snap)" "$S0" ;;
    cut-reattach) # C1ⓑ — worktree 를 잃었거나 로컬 브랜치가 원격에만 있어도 다시 치면 붙인다(두 번째를 만들지 않음)
      rel -- cut; T1="$(git -C "$B" rev-parse "$RB1")"
      git -C "$B" push -q origin "$RB1"; git -C "$B" worktree remove --force "$(WT1)"; git -C "$B" branch -q -D "$RB1"
      rel -- cut
      check "exit 0" eq "$RC" 0; check "원격에서 붙임" has "원격 $RB1 를 로컬 브랜치로 붙였다"
      check "끝 = 원래 끝" eq "$(git -C "$B" rev-parse "$RB1")" "$T1"
      check "worktree 다시" eq "$(git -C "$(WT1)" symbolic-ref --short HEAD)" "$RB1" ;;
    gather-ok) # C2ⓑⓓ — 순서대로 merge commit, 기록 줄, 재실행 멱등
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 feature/LIFE-2-b b.txt b main feature
      rel -- cut; rel -- gather --prs "1 2"
      check "exit 0" eq "$RC" 0
      P1="$(oref refs/heads/LIFE-1-a)"; P2="$(oref refs/heads/feature/LIFE-2-b)"
      check "PR1 head 포함" git -C "$B" merge-base --is-ancestor "$P1" "$RB1"
      check "PR2(묶음) head 포함" git -C "$B" merge-base --is-ancestor "$P2" "$RB1"
      check "merge commit 2개(부모 2)" eq "$(git -C "$B" rev-list --merges --first-parent --count "origin/main..$RB1")" 2
      check "기록 줄 PR1" eq "$(git -C "$B" log --first-parent --format=%B "$RB1" | grep -c "^Release-PR: 1 $P1\$")" 1
      check "기록 줄 PR2" eq "$(git -C "$B" log --first-parent --format=%B "$RB1" | grep -c "^Release-PR: 2 $P2\$")" 1
      check "순서 1 → 2" eq "$(git -C "$B" log --first-parent --reverse --format=%B "$RB1" | sed -n 's/^Release-PR: \([0-9]*\) .*/\1/p' | tr '\n' ' ')" "1 2 "
      T1="$(git -C "$B" rev-parse "$RB1")"
      rel -- gather --prs "1 2"
      check "재실행 exit 0" eq "$RC" 0; check "건너뜀 문구" has "이미 모음 — 건너뜀"; check "재실행 끝 불변" eq "$(git -C "$B" rev-parse "$RB1")" "$T1"
      check "push 0건" eq "$(grep -c 'release/' "$W/push-log.txt")" 0 ;;
    gather-dry)
      mkpr 1 LIFE-1-a a.txt a; rel -- cut; T1="$(git -C "$B" rev-parse "$RB1")"
      rel -- gather --prs 1 --dry-run
      check "exit 0" eq "$RC" 0; check "모을 예정" has "모을 예정 #1"; check "끝 불변" eq "$(git -C "$B" rev-parse "$RB1")" "$T1" ;;
    gather-nocut)
      mkpr 1 LIFE-1-a a.txt a; S0="$(snap)"; rel -- gather --prs 1
      check "exit 2" eq "$RC" 2; check "cut 안내" has "cut"; check "ref 불변" eq "$(snap)" "$S0" ;;
    gather-precheck) # C2ⓐ — draft·닫힘·base 불일치·포크 하나라도면 release 브랜치 변경 0건
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; rel -- cut; T1="$(git -C "$B" rev-parse "$RB1")"
      for v in "isDraft:draft:true" "closed:state:CLOSED" "base:base:other" "fork:fork:true"; do
        k="${v#*:}"; cp "$W/gh/pr/2" "$W/pr2.bak"; prset 2 "${k%%:*}" "${k#*:}"
        rel -- gather --prs "1 2"
        check "${v%%:*} → exit 2" eq "$RC" 2
        check "${v%%:*} → 끝 불변(PR1 도 안 모음)" eq "$(git -C "$B" rev-parse "$RB1")" "$T1"
        cp "$W/pr2.bak" "$W/gh/pr/2"
      done ;;
    gather-conflict) # C2ⓒ — 충돌 PR 에서 멈춤, 뒤 PR 안 모음, worktree 에 충돌 남김 → 해소·커밋 → 재실행이 이어 감
      mkpr 1 LIFE-1-a shared.txt "one"; mkpr 2 LIFE-2-b shared.txt "two"; mkpr 3 LIFE-3-c c.txt c
      rel -- cut; rel -- gather --prs "1 2 3"
      check "exit 3" eq "$RC" 3; check "충돌 파일 안내" has "shared.txt"
      check "재실행 명령(남은 PR)" has "gather --prs '2 3'"
      check "MERGE_HEAD 남김" git -C "$(WT1)" rev-parse -q --verify MERGE_HEAD
      check "PR3 안 모음" eq "$(git -C "$B" log --format=%B "$RB1" | grep -c '^Release-PR: 3 ')" 0
      rel -- gather --prs "2 3"
      check "해소 전 재실행 exit 2" eq "$RC" 2; check "해소 중 merge 문구" has "해소 중인 merge"
      echo "one+two" > "$(WT1)/shared.txt"; git -C "$(WT1)" add shared.txt; git -C "$(WT1)" commit -q --no-edit
      rel -- gather --prs "1 2 3"
      check "해소 뒤 exit 0" eq "$RC" 0
      check "기록 1 2 3" eq "$(git -C "$B" log --first-parent --reverse --format=%B "$RB1" | sed -n 's/^Release-PR: \([0-9]*\) .*/\1/p' | tr '\n' ' ')" "1 2 3 "
      check "해소 결과 유지" eq "$(git -C "$B" show "$RB1:shared.txt")" "one+two" ;;
    gather-dirty) # C2ⓕ
      mkpr 1 LIFE-1-a a.txt a; rel -- cut; T1="$(git -C "$B" rev-parse "$RB1")"
      echo x >> "$(WT1)/shared.txt"
      rel -- gather --prs 1
      check "exit 2" eq "$RC" 2; check "사유" has "커밋 안 된 변경"; check "끝 불변" eq "$(git -C "$B" rev-parse "$RB1")" "$T1" ;;
    gather-headmove) # C2ⓔ — 모은 뒤 head 가 움직이면 다시 모으기가 새 커밋만 merge 하고 기록을 갱신
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; P1="$(oref refs/heads/LIFE-1-a)"
      prpush LIFE-1-a a.txt a2; P1B="$(oref refs/heads/LIFE-1-a)"
      rel -- gather --prs 1
      check "exit 0" eq "$RC" 0; check "새 head 포함" git -C "$B" merge-base --is-ancestor "$P1B" "$RB1"
      check "기록 줄 2개(옛·새)" eq "$(git -C "$B" log --first-parent --format=%B "$RB1" | grep -c '^Release-PR: 1 ')" 2
      check "새 기록 = 새 SHA" eq "$(git -C "$B" log -1 --format=%B "$RB1" | sed -n 's/^Release-PR: 1 //p')" "$P1B"
      check "옛 SHA 와 다름" [ "$P1" != "$P1B" ] ;;
    gather-already) # head 가 이미 release 브랜치에 있으면(다른 PR 이 품음) merge 없이 기록만
      mkpr 1 LIFE-1-a a.txt a
      git -C "$H" checkout -q -b LIFE-2-b LIFE-1-a; echo b > "$H/b.txt"; git -C "$H" add -A; git -C "$H" commit -qm "PR 2"; git -C "$H" push -q origin LIFE-2-b
      printf 'state=OPEN\nbase=main\nhead=LIFE-2-b\n' > "$W/gh/pr/2"
      rel -- cut; rel -- gather --prs 2; rel -- gather --prs 1
      check "exit 0" eq "$RC" 0; check "기록만 문구" has "기록만 남겼다"
      check "기록 2 1" eq "$(git -C "$B" log --first-parent --reverse --format=%B "$RB1" | sed -n 's/^Release-PR: \([0-9]*\) .*/\1/p' | tr '\n' ' ')" "2 1 " ;;
    ship-ok) # C3 전체 + C4ⓐ + C5(묶음 PR)
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 feature/LIFE-2-b b.txt b main feature
      cutgather "1 2"; M0="$(oref refs/heads/main)"; T1="$(git -C "$B" rev-parse "$RB1")"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 0" eq "$RC" 0
      MC="$(oref refs/heads/main)"
      check "main 새 first-parent 커밋 = 1(머지 커밋)" eq "$(git --git-dir="$O" rev-list --first-parent --count "$M0..$MC")" 1
      check "머지 커밋 부모 2 · 둘째 = release 끝" eq "$(git --git-dir="$O" rev-list --parents -n 1 "$MC" | cut -d' ' -f2-)" "$M0 $T1"
      check "release PR 머지가 release 끝 고정" grep -q "pr merge 3 --merge --match-head-commit $T1" "$W/gh/calls.txt"
      check "태그 = main 끝" eq "$(oref 'refs/tags/v0.1.1^{commit}')" "$MC"
      check "주석 태그" eq "$(git --git-dir="$O" cat-file -t refs/tags/v0.1.1)" tag
      check "태그 커밋 버전 0.1.1" eq "$(git --git-dir="$O" show "$MC:app/package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p')" 0.1.1
      check "main 직접 push 0건(태그만)" eq "$(mainpushes)" 0
      check "태그 push 1건" eq "$(grep -c '^refs/tags/v0.1.1 ' "$W/push-log.txt")" 1
      check "Release(정식)" eq "$(cat "$W/gh/release/v0.1.1")" full
      check "release create --verify-tag" grep -q "release create v0.1.1 --verify-tag" "$W/gh/calls.txt"
      check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "PR2(묶음) MERGED" eq "$(prstate 2)" MERGED
      check "PR1 head 삭제" eq "$(oref refs/heads/LIFE-1-a)" ""; check "PR2 head 삭제" eq "$(oref refs/heads/feature/LIFE-2-b)" ""
      check "raw 상태 줄" has '"state":"MERGED"'
      check "본체 ff = main" eq "$(git -C "$B" rev-parse HEAD)" "$MC"
      check "ff 문구" has "fast-forward → origin/main (= 태그 v0.1.1)"
      check "✔ 출고" has "✔ 출고 v0.1.1"; check "finish 안내" has "finish" ;;
    ship-dry)
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; S0="$(snap)"
      rel -- ship --dry-run --skip-build --skip-apk
      check "exit 0" eq "$RC" 0; check "출고 집합" has "출고 집합 #1"; check "ref 불변" eq "$(snap)" "$S0"
      check "pr create 없음" eq "$(grep -c 'pr create' "$W/gh/calls.txt")" 0 ;;
    ship-nonotes)
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; S0="$(snap)"
      rel -- ship --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "사유" has "--notes"; check "ref 불변" eq "$(snap)" "$S0" ;;
    ship-headmoved) # C3ⓐ — 모은 뒤 head 가 움직였는데 다시 모으지 않음 → 어느 PR 인지 대고 거절, 변경 0
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"; prpush LIFE-2-b b.txt b2; S0="$(snap)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "PR #2 를 댄다" has "#2 (LIFE-2-b)"; check "PR #1 은 대지 않음" hasnt "#1 (LIFE-1-a)"
      check "다시 모으기 명령" has "gather --prs '1 2'"
      check "ref 불변(push 0)" eq "$(snap)" "$S0"; check "pr create 없음" eq "$(grep -c 'pr create' "$W/gh/calls.txt")" 0 ;;
    ship-mainmoved) # C3ⓐ — main 이 움직였으면 멈추고 안내
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      git -C "$H" fetch -q origin; git -C "$H" checkout -q -B tmp origin/main; echo z > "$H/z.txt"; git -C "$H" add -A; git -C "$H" commit -qm z; git -C "$H" push -q origin tmp:main
      S0="$(snap)"; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "merge 안내" has "merge origin/main"; check "ref 불변" eq "$(snap)" "$S0" ;;
    ship-closedpr)
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; prset 1 state CLOSED; S0="$(snap)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "ref 불변" eq "$(snap)" "$S0" ;;
    ship-rerun) # 멱등 — 끝난 출고를 다시 치면 머지·태그·Release 를 다시 하지 않고 안내만
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      S0="$(snap)"; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 0" eq "$RC" 0; check "이미 끝 문구" has "이미 끝났다"; check "dmg 명령" has "release-dmg.sh"
      check "ref 불변" eq "$(snap)" "$S0"; check "pr merge 1회" eq "$(grep -c 'pr merge' "$W/gh/calls.txt")" 1
      check "release create 1회" eq "$(grep -c 'release create' "$W/gh/calls.txt")" 1 ;;
    ship-tagfail) # exit 7 → 같은 명령 재실행이 태그부터 이어 감
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; touch "$W/reject-tags"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 7" eq "$RC" 7; check "원격 태그 없음" eq "$(oref refs/tags/v0.1.1)" ""
      check "로컬 태그 지움" not git -C "$B" rev-parse -q --verify refs/tags/v0.1.1
      rm "$W/reject-tags"; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "재실행 exit 0" eq "$RC" 0; check "태그 = main 끝" eq "$(oref 'refs/tags/v0.1.1^{commit}')" "$(oref refs/heads/main)"
      check "pr merge 1회" eq "$(grep -c 'pr merge' "$W/gh/calls.txt")" 1 ;;
    ship-releasefail) # exit 9 → 재실행이 Release 부터
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_RELEASE_FAIL=1 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 9" eq "$RC" 9; check "태그는 있음" [ -n "$(oref refs/tags/v0.1.1)" ]
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "재실행 exit 0" eq "$RC" 0; check "Release 생김" [ -f "$W/gh/release/v0.1.1" ]; check "✔ 출고" has "✔ 출고 v0.1.1" ;;
    ship-mergefail) # exit 6 — 태그 없음
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_MERGE_FAIL=1 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 6" eq "$RC" 6; check "태그 없음" eq "$(oref refs/tags/v0.1.1)" ""; check "PR1 OPEN" eq "$(prstate 1)" OPEN
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "재실행 exit 0(release PR 재사용)" eq "$RC" 0; check "재사용 문구" has "재사용"
      check "release PR 1개" eq "$(grep -c 'pr create' "$W/gh/calls.txt")" 1 ;;
    ship-unknown) # exit 5
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_MERGEABLE=UNKNOWN -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 5" eq "$RC" 5; check "main 불변" [ -z "$(git --git-dir="$O" log --merges --format=%H main)" ] ;;
    ship-createfail) # exit 12
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_CREATE_FAIL=1 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 12" eq "$RC" 12; check "release 브랜치는 push 됨" [ -n "$(oref "refs/heads/$RB1")" ] ;;
    ship-noindirect) # C4ⓒ — 간접 머지가 안 되면 head 를 지우지 않고 exit 13, 출고는 끝난 상태 · finish 가 다시 본다
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"
      rel FGH_INDIRECT=off -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 13" eq "$RC" 13; check "남은 PR 나열" has "#1(OPEN) #2(OPEN)"; check "확인 명령" has "gh pr view 1 --json state"
      check "head 남김 PR1" [ -n "$(oref refs/heads/LIFE-1-a)" ]; check "head 남김 PR2" [ -n "$(oref refs/heads/LIFE-2-b)" ]
      check "태그는 끝" [ -n "$(oref refs/tags/v0.1.1)" ]; check "Release 는 끝" [ -f "$W/gh/release/v0.1.1" ]
      check "출고 끝 문구" has "출고 v0.1.1 는 끝났다"
      rel FGH_INDIRECT=off -- finish
      check "finish exit 13" eq "$RC" 13; check "release 브랜치 남김" git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      rel -- finish
      check "간접 머지 뒤 finish exit 0" eq "$RC" 0; check "PR1 head 삭제" eq "$(oref refs/heads/LIFE-1-a)" ""
      check "release 브랜치 정리" eq "$(oref "refs/heads/$RB1")$(git -C "$B" rev-parse -q --verify "refs/heads/$RB1")" "" ;;
    finish-leave-open) # 끝내 MERGED 가 안 될 때 — --leave-open 은 그 head 는 두고 release 브랜치만 정리
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_INDIRECT=off -- ship --notes "$W/notes.md" --skip-build --skip-apk
      rel FGH_INDIRECT=off -- finish --leave-open
      check "exit 0" eq "$RC" 0; check "경고 문구" has "--leave-open — MERGED 로 확인 안 된 PR: #1(OPEN)"
      check "PR1 head 남김" [ -n "$(oref refs/heads/LIFE-1-a)" ]; check "PR1 OPEN" eq "$(prstate 1)" OPEN
      check "release 브랜치 정리" eq "$(oref "refs/heads/$RB1")$(git -C "$B" rev-parse -q --verify "refs/heads/$RB1")" ""
      check "worktree 없음" [ ! -d "$(WT1)" ] ;;
    ship-forged-record|ship-forged-record2) # G1(Grok r2 1) — gather 가 만들지 않은 Release-PR 줄은 출고 집합에 넣지 않고 거절, head 삭제 0
      # 피해자: 모으지 않은 MERGED PR #9, head side/victim. -1: 아무 제목 + 그 SHA 가 release 에 있음(main 끝) · -2: 「기록」 제목 흉내 + release 에 없는 SHA
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      if [ "$CASE" = ship-forged-record ]; then VSHA="$(oref refs/heads/main)"; git -C "$H" push -q origin "$VSHA:refs/heads/side/victim"; SUBJ="회고 메모"
      else git -C "$H" fetch -q origin; git -C "$H" checkout -q -B side/victim origin/main; echo v > "$H/v.txt"; git -C "$H" add -A; git -C "$H" commit -qm victim
        git -C "$H" push -q origin side/victim; VSHA="$(oref refs/heads/side/victim)"; SUBJ="release: #9 기록 — 흉내"; fi
      printf 'state=MERGED\nbase=main\nhead=side/victim\ndraft=false\nfork=false\noid=%s\nmergeCommit=%s\nmergedAt=x\n' "$VSHA" "$VSHA" > "$W/gh/pr/9"
      git -C "$(WT1)" commit -q --allow-empty -m "$SUBJ" -m "Release-PR: 9 $VSHA"
      M0="$(oref refs/heads/main)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2
      if [ "$CASE" = ship-forged-record ]; then check "gather 가 만들지 않은 줄 문구" has "gather 가 만들지 않은 Release-PR 줄"; else check "release 에 없는 SHA 문구" has "기록 SHA 가 release 브랜치에 없다"; fi
      check "피해자 head 그대로" eq "$(oref refs/heads/side/victim)" "$VSHA"; check "main 불변" eq "$(oref refs/heads/main)" "$M0"
      check "태그 없음" eq "$(oref refs/tags/v0.1.1)" "" ;;
    ship-build-ok|ship-build-dmgfail|ship-build-apkfail|ship-build-rerun|ship-build-prefail) # G2(Claude r2 중간 1) — skip 없이 빌드 경로(스텁 dmg·apk)
      stubs
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"; M0="$(oref refs/heads/main)"
      case "$CASE" in
        ship-build-ok|ship-build-rerun)
          rel -- ship --notes "$W/notes.md"
          check "exit 0" eq "$RC" 0; check "APK 전제 점검(머지 전)" grep -q "^preflight" "$W/stub.log"
          check "dmg 스텁 = 태그 worktree·태그 HEAD" grep -q "^dmg .*_release-.* tag=v0.1.1" "$W/stub.log"
          check "apk 스텁 = 태그 worktree" grep -q "^apk .*_release-" "$W/stub.log"
          check "순서 preflight → dmg → apk" eq "$(cut -d' ' -f1 "$W/stub.log" | tr '\n' ' ')" "preflight dmg apk "
          check "✔ 출고" has "✔ 출고 v0.1.1"
          check "C2ⓐ Release asset 4개" eq "$(nassets)" 4; check "C2ⓐ 대조 문구" has "✔ Release v0.1.1 asset — 서버 digest = 로컬 sha256"
          check "C2ⓐ 받은 파일 통과" dlcheck 2; check "C2ⓐ dmg 서버 digest = 산출물" eq "$(sdigest corral-0.1.1-arm64.dmg)" "$(lsha "$B/app/dist/release/v0.1.1/corral-0.1.1-arm64.dmg")"
          if [ "$CASE" = ship-build-rerun ]; then
            : > "$W/stub.log"; rel -- ship --notes "$W/notes.md"
            check "재실행 exit 0" eq "$RC" 0; check "이미 끝 문구" has "이미 끝났다"; check "재실행은 빌드 안 함" eq "$(grep -c '^dmg\|^apk' "$W/stub.log")" 0
            check "재실행 dmg 명령" has "release-dmg.sh"
            CMD="$(after "dmg·APK 뒤 Release 에 올리기(이미 올라간 것은 건너뛴다):")"; check "C2ⓒ 이미 출고됨 안내에 올리기 명령" eq "${CMD:0:1}" "'"
            paste_run "$CMD"; check "C2ⓒ 붙여 넣기 exit 0" eq "$RC" 0; check "C2ⓒ 재실행 upload 0(누적 4)" eq "$(upcalls)" 4
          fi ;;
        ship-build-dmgfail)
          rel FGH_INDIRECT=off STUB_DMG_FAIL=1 -- ship --notes "$W/notes.md"
          check "exit 8" eq "$RC" 8; check "dmg 만 다시" has "dmg 만 다시:"; check "APK 는 아직" has "APK 는 아직이다"
          check "PR_TAIL(미해결 PR)" has "그리고 원래 PR 처리가 끝나지 않았다"; check "apk 는 안 돎" eq "$(grep -c '^apk' "$W/stub.log")" 0
          check "올리기 안내" has "dmg·APK 뒤 Release 에 올리기:"; check "upload 0" eq "$(upcalls)" 0
          # C2ⓑ exit 8 — 안내 줄을 뽑아 그대로 붙여 넣으면 dmg → 정리 → APK → 올리기로 이어진다
          D1="$(after "dmg 만 다시:")"; D2="$(after "dmg 가 끝나면 임시 worktree 정리:")"; A1="$(after "APK 는 아직이다 — dmg 뒤 APK:")"; U1="$(after "dmg·APK 뒤 Release 에 올리기:")"
          paste_run "$D1"; check "exit 8 dmg 붙여 넣기 exit 0" eq "$RC" 0; paste_run "$D2"; check "exit 8 정리 붙여 넣기 exit 0" eq "$RC" 0
          paste_run "$A1"; check "exit 8 APK 붙여 넣기 exit 0" eq "$RC" 0
          paste_run "$U1"; check "exit 8 올리기 붙여 넣기 exit 0" eq "$RC" 0; check "exit 8 뒤 asset 4개" eq "$(nassets)" 4; check "exit 8 뒤 받은 파일 통과" dlcheck 2
          check "_dmg worktree 정리" eq "$(git -C "$B" worktree list | grep -c '_dmg-')" 0 ;;
        ship-build-apkfail)
          rel STUB_APK_FAIL=1 -- ship --notes "$W/notes.md"
          check "exit 10" eq "$RC" 10; check "APK 만 다시 → 올리기" has "APK 만 다시 → Release 에 올리기:"; check "dmg 는 끝" grep -q "^dmg" "$W/stub.log"
          check "upload 0" eq "$(upcalls)" 0
          A1="$(after "APK 만 다시 → Release 에 올리기:")"
          paste_run "$A1"; check "APK·올리기 한 줄 붙여 넣기 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4 ;;
        ship-build-prefail)
          rel STUB_APK_PRE_FAIL=1 -- ship --notes "$W/notes.md"
          check "exit 2" eq "$RC" 2; check "APK 전제 미달 문구" has "APK 전제 미달"; check "main 불변" eq "$(oref refs/heads/main)" "$M0"
          check "release·main push 0" eq "$(grep -c '^refs/heads/release/\|^refs/heads/main ' "$W/push-log.txt")" 0 ;;
      esac
      check "임시 worktree 정리(trap)" eq "$(git -C "$B" worktree list | grep -c '_release-')" 0
      check "임시 worktree 폴더 없음" eq "$(ls "$B/.claude/worktrees" | grep -c '^_release-')" 0 ;;
    ship-pkgver) # G3(M9) — 모은 뒤 release 끝 버전이 바뀌면 거절
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; sed -i '' 's/"version": "0.1.1"/"version": "0.1.5"/' "$(WT1)/app/package.json"
      git -C "$(WT1)" commit -qam "버전 바꿈"; S0="$(snap)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "버전 문구" has "app/package.json 버전이 0.1.1 이 아니다"; check "ref 불변" eq "$(snap)" "$S0" ;;
    ship-remote-ahead) # G3(M12) — 원격 release 브랜치가 로컬에 없는 커밋을 가지면 거절
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; git -C "$B" push -q origin "$RB1"
      git -C "$H" fetch -q origin; git -C "$H" checkout -q -B rbx "origin/$RB1"; git -C "$H" commit -q --allow-empty -m "남이 올린 커밋"; git -C "$H" push -q origin "rbx:$RB1"
      R0="$(oref "refs/heads/$RB1")"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "앞섬 문구" has "로컬"; check "원격 그대로" eq "$(oref "refs/heads/$RB1")" "$R0"
      check "pr create 0" eq "$(grep -c 'pr create' "$W/gh/calls.txt")" 0 ;;
    ship-merged-moved) # G3(M7) — release PR 머지 뒤 release 브랜치에 커밋이 생기면 거절
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; touch "$W/reject-tags"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; rm "$W/reject-tags"
      git -C "$(WT1)" commit -q --allow-empty -m "머지 뒤 커밋"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "머지 뒤 커밋 문구" has "머지 뒤 release 브랜치에 커밋"; check "태그 없음" eq "$(oref refs/tags/v0.1.1)" "" ;;
    ship-second-parent) # G3(M13) — 머지 커밋 둘째 부모 ≠ release 끝이면 태그를 달지 않음
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_MERGE_BAD_PARENT=1 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 6" eq "$RC" 6; check "둘째 부모 문구" has "둘째 부모가"; check "태그 없음" eq "$(oref refs/tags/v0.1.1)" "" ;;
    ship-base-changed) # G3(M15) — 모은 PR 의 base 가 바뀌면 거절
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; prset 1 base other; S0="$(snap)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "base 문구" has "base 가 other 로 바뀌었다"; check "ref 불변" eq "$(snap)" "$S0" ;;
    ship-tmpwt-fail) # G5(Claude r2 낮음 2) — 출고 뒤 임시 worktree 를 못 만들면 안내와 exit 8
      stubs; mkpr 1 LIFE-1-a a.txt a; cutgather 1; chmod a-w "$B/.claude/worktrees"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; chmod u+w "$B/.claude/worktrees"
      check "exit 8" eq "$RC" 8; check "출고는 끝났다 문구" has "임시 worktree 를 만들지 못했다"; check "dmg 명령" has "release-dmg.sh"
      check "태그는 있음" [ -n "$(oref refs/tags/v0.1.1)" ]
      # C2ⓑ exit 8(임시 worktree) — 안내 줄을 그대로 붙여 넣으면 dmg → 정리 → 올리기(--skip-apk 라 --no-apk)
      D1="$(after "dmg 만:")"; D2="$(after "dmg 가 끝나면 임시 worktree 정리:")"; U1="$(after "dmg·APK 뒤 Release 에 올리기:")"
      check "올리기 줄 --no-apk" eq "$(echo "$U1" | grep -c -- "--no-apk\$")" 1
      paste_run "$D1"; check "dmg 붙여 넣기 exit 0" eq "$RC" 0; paste_run "$D2"; check "정리 붙여 넣기 exit 0" eq "$RC" 0
      paste_run "$U1"; check "올리기 붙여 넣기 exit 0" eq "$RC" 0; check "asset 2개" eq "$(nassets)" 2; check "받은 파일 통과(1)" dlcheck 1 ;;
    ship-rerun-unresolved) # G5(Grok r2 3) — Release 가 있고 미해결이면 재실행 ship 도 dmg·APK 명령을 보인 뒤 13
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_INDIRECT=off -- ship --notes "$W/notes.md" --skip-build --skip-apk; check "1차 exit 13" eq "$RC" 13
      rel FGH_INDIRECT=off -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "2차 exit 13" eq "$RC" 13; check "dmg 명령" has "release-dmg.sh"; check "APK 명령" has "release-apk.sh" ;;
    cut-open-nonsemver) # G4(Grok r2 2) — <RP><PREFIX> 접두면 X.Y.Z 가 아닌 이름도 열린 release 로 센다
      git -C "$H" push -q origin origin/main:refs/heads/release/v9.9.9-wip; S0="$(snap)"
      rel -- cut --version 0.1.1
      check "exit 2" eq "$RC" 2; check "이름" has "release/v9.9.9-wip"; check "ref 불변" eq "$(snap)" "$S0" ;;
    cut-after-13) # G5(Claude r2 낮음 2) — exit 13 뒤 cut 거절 안내에 finish·finish --leave-open
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_INDIRECT=off -- ship --notes "$W/notes.md" --skip-build --skip-apk
      rel -- cut
      check "exit 2" eq "$RC" 2; check "finish --leave-open 안내" has "finish --leave-open" ;;
    ns-newline) # G4(Claude r2 낮음 6) — 개행 든 값은 글자 검사(case)가 거절
      S0="$(snap)"; rel -- cut --base "$(printf 'throwaway/x\nmain')" --tag-prefix rehearsal-x-v
      check "exit 1" eq "$RC" 1; check "글자 문구" has "쓸 수 없는 글자"; check "ref 불변" eq "$(snap)" "$S0" ;;
    ns-rehearsal-realhead) # G4(Claude r2 낮음 1) — 리허설은 throwaway/ 아래가 아닌 head 를 지우지 않는다
      git -C "$H" push -q origin origin/main:refs/heads/throwaway/x-base; : > "$W/push-log.txt"
      mkpr 1 LIFE-9-real-work a.txt a throwaway/x-base
      R="--base throwaway/x-base --tag-prefix rehearsal-x-v"
      rel FGH_DEFAULT=throwaway/x-base -- cut $R; rel FGH_DEFAULT=throwaway/x-base -- gather --prs 1 $R
      H0="$(oref refs/heads/LIFE-9-real-work)"
      rel FGH_DEFAULT=throwaway/x-base -- ship --notes "$W/notes.md" --skip-build --skip-apk $R
      check "exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "head 그대로" eq "$(oref refs/heads/LIFE-9-real-work)" "$H0"
      check "삭제 push 없음" eq "$(grep -c '^refs/heads/LIFE-9-real-work .* 0000000000000000000000000000000000000000$' "$W/push-log.txt")" 0
      check "리허설 이름 문구" has "throwaway/ 아래만 지운다" ;;
    wt-rmrf) # H1(Claude r3 중간 1) — release worktree 폴더를 잃고 등록만 남아도 같은 cut 이 다시 붙이고 이어 간다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rm -rf "$(WT1)"
      rel -- gather --prs 1; check "gather exit 2(다시 자르라)" eq "$RC" 2
      rel -- cut; check "cut exit 0(재부착)" eq "$RC" 0; check "붙였다 문구" has "release worktree 를 붙였다"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; check "ship exit 0" eq "$RC" 0 ;;
    wt-rmrf-remote) # H1 — 폴더·로컬 브랜치를 잃고 원격만 남아도 cut 이 붙인다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; git -C "$B" push -q origin "$RB1"
      rm -rf "$(WT1)"; git -C "$B" update-ref -d "refs/heads/$RB1"   # 등록은 남기고 로컬 브랜치만 없앤다
      rel -- cut; check "cut exit 0(재부착)" eq "$RC" 0; check "worktree = release 브랜치" eq "$(git -C "$(WT1)" symbolic-ref --short HEAD)" "$RB1" ;;
    wt-rmrf-abort) # H1 — 등록만 남은 상태에서 abort
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rm -rf "$(WT1)"
      rel -- abort; check "abort exit 0" eq "$RC" 0; check "로컬 브랜치 없음" not git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      check "등록 없음" eq "$(git -C "$B" worktree list | grep -c 'release-v0.1.1')" 0 ;;
    wt-rmrf-finish) # H1 — 출고 뒤 등록만 남은 상태에서 finish
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; rm -rf "$(WT1)"
      rel -- finish; check "finish exit 0" eq "$RC" 0; check "로컬 브랜치 없음" not git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      check "원격 브랜치 없음" eq "$(oref "refs/heads/$RB1")" "" ;;
    wt-rmrf-cut-fresh) # H1 — 등록만 남고 브랜치는 없으면 새로 자른다
      rel -- cut; rm -rf "$(WT1)"
      rel -- abort; check "abort exit 0" eq "$RC" 0
      rel -- cut; check "다시 cut exit 0" eq "$RC" 0; check "worktree 있음" [ -d "$(WT1)" ] ;;
    reuse-name) # H2(Claude r3 중간 2) — 리허설 2회차: 1회차 정리 뒤 같은 이름으로 cut→gather→ship→finish. 옛 회차 머지 PR(GitHub 에 남음)을 이 release 의 것으로 읽지 않는다
      git -C "$H" push -q origin origin/main:refs/heads/throwaway/x-base; : > "$W/push-log.txt"
      R="--base throwaway/x-base --tag-prefix rehearsal-x-v"
      mkpr 1 throwaway/x-pr1 a.txt a throwaway/x-base
      rel FGH_DEFAULT=throwaway/x-base -- cut $R; rel FGH_DEFAULT=throwaway/x-base -- gather --prs 1 $R
      rel FGH_DEFAULT=throwaway/x-base -- ship --notes "$W/notes.md" --skip-build --skip-apk $R; check "1회차 ship exit 0" eq "$RC" 0
      rel FGH_DEFAULT=throwaway/x-base -- finish $R; check "1회차 finish exit 0" eq "$RC" 0
      # 정리(C12) — 원격·로컬 태그, Release 기록, base 를 되돌림. PR 기록(gh/pr/*)은 GitHub 처럼 남는다
      git --git-dir="$O" tag -d rehearsal-x-v0.1.1 >/dev/null; git -C "$B" tag -d rehearsal-x-v0.1.1 >/dev/null; rm -f "$W/gh/release/rehearsal-x-v0.1.1"
      git --git-dir="$O" update-ref -d refs/heads/throwaway/x-base; git -C "$H" push -q origin origin/main:refs/heads/throwaway/x-base
      git -C "$B" fetch -q --prune origin
      check "옛 release PR 은 MERGED 로 남음" eq "$(grep -l 'head=throwaway/x-base-release/' "$W"/gh/pr/* | xargs grep -l 'state=MERGED' | wc -l | tr -d ' ')" 1
      mkpr 7 throwaway/x-pr7 g.txt g throwaway/x-base
      rel FGH_DEFAULT=throwaway/x-base -- cut $R; check "2회차 cut exit 0" eq "$RC" 0
      rel FGH_DEFAULT=throwaway/x-base -- gather --prs 7 $R; check "2회차 gather exit 0" eq "$RC" 0
      rel FGH_DEFAULT=throwaway/x-base -- ship --notes "$W/notes.md" --skip-build --skip-apk $R; check "2회차 ship exit 0" eq "$RC" 0
      check "새 release PR 생성" has "release PR #"; check "PR7 MERGED" eq "$(prstate 7)" MERGED
      rel FGH_DEFAULT=throwaway/x-base -- finish $R; check "2회차 finish exit 0" eq "$RC" 0 ;;
    forged-abort-recut) # H3(Claude r3 낮음 1) — 위조 줄 거절 안내는 abort → 다시 cut 한 길, 그대로 따르면 출고된다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      git -C "$(WT1)" commit -q --allow-empty -m "회고 메모" -m "Release-PR: 9 $(oref refs/heads/main)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "abort 안내" has "접고(abort) 다시 자른"; check "revert 권유 없음" hasnt "git -C"
      rel -- abort; check "abort exit 0" eq "$RC" 0
      cutgather 1; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "다시 자른 뒤 ship exit 0" eq "$RC" 0; PC="$(grep ' pr create ' "$W/gh/calls.txt" | tail -1)"; eval "set -- ${PC#gh}"; BODYARG=""
      while [ $# -gt 0 ]; do [ "$1" = --body ] && BODYARG="$2"; shift; done
      check "PR 본문 참고용 문구" eq "$(echo "$BODYARG" | grep -c '참고용 — 재사용하면 갱신하지 않는다')" 1 ;;
    ns-bothbad) # L1(Claude r4 낮음 1) — base·접두 둘 다 어느 이름 공간도 아닌 조합은 ref·push 0건으로 거절(짝이 같아도 bad 끼리는 안 된다)
      git -C "$H" push -q origin origin/main:refs/heads/release/v9.9.9; : > "$W/push-log.txt"
      S0="$(snap)"; rel -- cut --base release/v9.9.9 --tag-prefix zzz-
      check "exit 1" eq "$RC" 1; check "짝 문구" has "짝이 맞지 않는다"; check "ref·worktree 0건" eq "$(snap)" "$S0"; check "push 0건" eq "$(wc -l < "$W/push-log.txt" | tr -d ' ')" 0
      S0="$(snap)"; rel -- cut --base feature/x --tag-prefix v9-
      check "exit 1(2)" eq "$RC" 1; check "ref·worktree 0건(2)" eq "$(snap)" "$S0" ;;
    main-merge-recovery|main-merge-recovery-gather) # L2(Claude r4 낮음 2) — main 이동 → ship 2 → 안내대로 release worktree 에서 merge origin/main → 같은 ship 0(-gather: 그 뒤 PR 을 더 모으고 ship)
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather 1
      git -C "$H" fetch -q origin; git -C "$H" checkout -q -B tmp origin/main; echo z > "$H/z.txt"; git -C "$H" add -A; git -C "$H" commit -qm z; git -C "$H" push -q origin tmp:main
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; check "ship 2(main 이동)" eq "$RC" 2; check "merge 안내" has "merge origin/main"
      git -C "$B" fetch -q origin; git -C "$(WT1)" merge -q --no-edit origin/main; check "merge origin/main 0" eq "$?" 0
      if [ "$CASE" = main-merge-recovery-gather ]; then rel -- gather --prs 2; check "gather 0" eq "$RC" 0; fi
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "같은 ship 0" eq "$RC" 0; check "기록 없는 merge 경고 없음" hasnt "기록 없는 merge"; check "PR1 MERGED" eq "$(prstate 1)" MERGED
      check "z.txt 도 main 에" eq "$(git --git-dir="$O" show refs/heads/main:z.txt)" z
      [ "$CASE" = main-merge-recovery ] || check "PR2 MERGED" eq "$(prstate 2)" MERGED ;;
    protected-head) # L3(Claude r4 낮음 3) — 원래 PR head 가 release/* 이름이면 MERGED 여도 원격 head 를 지우지 않고 문구를 남긴다
      mkpr 1 release/hotfix-x a.txt a; cutgather 1
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED
      check "release/hotfix-x 그대로" [ -n "$(oref refs/heads/release/hotfix-x)" ]; check "지우지 않는 이름 문구" has "지우지 않는 이름" ;;
    gather-stacked) # F1(Claude M1) — 같은 gather 에서 앞 PR 이 뒤 PR head 를 품어도(순서 "2 1") 뒤 PR 기록이 남는다
      mkpr 1 LIFE-1-a a.txt a
      git -C "$H" checkout -q -b LIFE-2-b LIFE-1-a; echo b > "$H/b.txt"; git -C "$H" add -A; git -C "$H" commit -qm "PR 2"; git -C "$H" push -q origin LIFE-2-b
      printf 'state=OPEN\nbase=main\nhead=LIFE-2-b\n' > "$W/gh/pr/2"
      rel -- cut; rel -- gather --prs "2 1"
      check "exit 0" eq "$RC" 0; check "PR1 기록만 문구" has "PR #1 (LIFE-1-a)"
      check "기록 2 1" eq "$(git -C "$B" log --first-parent --reverse --format=%B "$RB1" | sed -n 's/^Release-PR: \([0-9]*\) .*/\1/p' | tr '\n' ' ')" "2 1 "
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 0" eq "$RC" 0; check "✔ 출고 #2 #1" has "✔ 출고 v0.1.1 — #2 #1"
      check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "PR1 head 삭제" eq "$(oref refs/heads/LIFE-1-a)" "" ;;
    gather-after-exit7) # F8(Claude L1) — release PR 이 머지됐는데 태그가 없으면 gather 거절·ship 안내 → ship 이 이어 감
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather 1; touch "$W/reject-tags"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; check "ship exit 7" eq "$RC" 7
      rm "$W/reject-tags"; T1="$(git -C "$B" rev-parse "$RB1")"
      rel -- gather --prs 2
      check "gather exit 2" eq "$RC" 2; check "ship 안내" has "ship --notes"; check "release 끝 불변" eq "$(git -C "$B" rev-parse "$RB1")" "$T1"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship 재실행 exit 0" eq "$RC" 0; check "태그 = main 끝" eq "$(oref 'refs/tags/v0.1.1^{commit}')" "$(oref refs/heads/main)" ;;
    record-cutquote) # F3(Grok 1) — 뒤 커밋 메시지의 Release-Cut 줄이 기록을 자르지 않는다
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather 1
      git -C "$(WT1)" commit -q --allow-empty -m "회고 — 자르기 커밋 인용" -m "Release-Cut: v0.1.1"
      rel -- gather --prs 2
      check "gather exit 0" eq "$RC" 0; check "기록에 #1·#2" has "기록(출고 집합): #1@"
      check "기록에 #2" has " #2@"
      rel -- ship --dry-run --skip-build --skip-apk
      check "dry-run 집합 #1" has "출고 집합 #1"; check "dry-run 집합 #2" has "출고 집합 #2" ;;
    cut-reattach-after-merge) # F8(Claude L5) — exit 7 뒤 로컬 release 브랜치를 잃어도 안내대로 cut --version 이 붙인다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; touch "$W/reject-tags"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; rm "$W/reject-tags"
      git -C "$B" worktree remove --force "$(WT1)"; git -C "$B" branch -q -D "$RB1"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 2" eq "$RC" 2; check "cut --version 안내" has "cut --version 0.1.1"
      rel -- cut --version 0.1.1
      check "cut exit 0(재부착)" eq "$RC" 0; check "원격에서 붙임" has "로컬 브랜치로 붙였다"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 0" eq "$RC" 0; check "태그 = main 끝" eq "$(oref 'refs/tags/v0.1.1^{commit}')" "$(oref refs/heads/main)" ;;
    ship-dirty) # F7③(Claude M3) — release worktree 가 더러우면 ship 거절, push 0
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; echo x >> "$(WT1)/shared.txt"; S0="$(snap)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "사유" has "커밋 안 된 변경"; check "ref 불변" eq "$(snap)" "$S0" ;;
    ship-headmove-late) # F4(Grok 2) — 머지 가능 판정 조회 때 PR head 가 움직이면 머지 직전 재확인이 거절 → 다시 모으고 같은 ship
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"; M0="$(oref refs/heads/main)"
      HOOK="git -C '$H' fetch -q origin && git -C '$H' checkout -q -B LIFE-2-b origin/LIFE-2-b && echo b2 > '$H/b.txt' && git -C '$H' commit -qam late && git -C '$H' push -q origin LIFE-2-b"
      rel FGH_HOOK_ON="pr view * --json mergeable*" FGH_HOOK_CMD="$HOOK" -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "머지 직전 문구" has "머지 직전 다시 보니"; check "PR #2 를 댄다" has "#2 (LIFE-2-b)"
      check "main 불변(머지 0)" eq "$(oref refs/heads/main)" "$M0"; check "pr merge 0회" eq "$(grep -c 'pr merge' "$W/gh/calls.txt")" 0
      check "태그 없음" eq "$(oref refs/tags/v0.1.1)" ""
      rel -- gather --prs "1 2"; check "다시 모으기 exit 0" eq "$RC" 0
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 0" eq "$RC" 0; check "release PR 재사용" has "재사용"; check "PR2 MERGED" eq "$(prstate 2)" MERGED
      check "새 head 가 main 에" git --git-dir="$O" merge-base --is-ancestor "$(git -C "$H" rev-parse LIFE-2-b)" refs/heads/main ;;
    ship-tag-on-tip) # F6(Grok 4) — 원격 태그가 release 끝(머지 커밋 아님)이면 「이미 출고」로 보지 않고 거절
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; git -C "$B" push -q origin "$RB1"; git -C "$B" tag v0.1.1 "$RB1"; git -C "$B" push -q origin v0.1.1
      M0="$(oref refs/heads/main)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "출고 머지 커밋이 아니다" has "출고 머지 커밋"
      check "Release 없음" [ ! -f "$W/gh/release/v0.1.1" ]; check "main 불변" eq "$(oref refs/heads/main)" "$M0"; check "PR1 OPEN" eq "$(prstate 1)" OPEN ;;
    ship-unrecorded-merge) # F9(Claude L2) — 해소 커밋을 -m 으로 만들어 기록이 빠진 merge 를 ship 이 경고(거절 아님), gather 재실행이 복구
      mkpr 1 LIFE-1-a shared.txt one; mkpr 2 LIFE-2-b shared.txt two
      rel -- cut; rel -- gather --prs "1 2"
      echo "one+two" > "$(WT1)/shared.txt"; git -C "$(WT1)" add shared.txt; git -C "$(WT1)" commit -q -m "resolve"
      rel -- ship --dry-run --skip-build --skip-apk
      check "dry-run exit 0" eq "$RC" 0; check "기록 없는 merge 경고" has "⚠ 기록 없는 merge"
      M0="$(oref refs/heads/main)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk   # G6(Claude r2 낮음 3) — 출고 머지 전이면 거절
      check "실 ship exit 2" eq "$RC" 2; check "거절 문구" has "기록 없는 merge 가 있다"; check "main 불변" eq "$(oref refs/heads/main)" "$M0"
      check "release PR 0" eq "$(grep -c 'pr create' "$W/gh/calls.txt")" 0
      rel -- gather --prs 2; check "gather exit 0(기록만)" eq "$RC" 0; check "기록만 문구" has "기록만 남겼다"
      rel -- ship --dry-run --skip-build --skip-apk
      check "경고 사라짐" hasnt "⚠ 기록 없는 merge"; check "집합 #2" has "출고 집합 #2"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "복구 뒤 ship exit 0" eq "$RC" 0; check "✔ 출고 #1 #2" has "✔ 출고 v0.1.1 — #1 #2" ;;
    ship-indirect-late) # F7⑤(Grok 6) — 간접 머지가 몇 번 뒤 조회에서야 보여도 대기 루프가 기다려 MERGED 를 본다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel RELEASE_INDIRECT_WAIT_S=30 RELEASE_INDIRECT_STEP_S=0 FGH_MERGED_AFTER=6 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "head 삭제" eq "$(oref refs/heads/LIFE-1-a)" ""
      check "PR1 조회 6회 이상" [ "$(cat "$W/gh/count-view-1")" -ge 6 ] ;;
    ship-mergeable-late) # F7⑤(Grok 6) — 머지 가능 판정이 몇 번 UNKNOWN 이어도 재시도 루프가 기다린다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel RELEASE_MERGEABLE_TRIES=5 FGH_MERGEABLE_AFTER=2 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 0" eq "$RC" 0; check "판정 조회 3회" eq "$(cat "$W/gh/count-mergeable-2")" 3 ;;
    abort-after-merge) # F7②(Claude M3) — release PR 머지 뒤(exit 7)에는 접지 않는다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; touch "$W/reject-tags"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; rm "$W/reject-tags"; S0="$(snap)"
      rel -- abort
      check "exit 2" eq "$RC" 2; check "이미 머지 문구" has "이미 머지됐다"; check "불변" eq "$(snap)" "$S0" ;;
    abort-branchbusy) # F5(Claude L4) — 정리 단계 실패(로컬 브랜치를 다른 worktree 가 씀)면 ✔ 없이 멈춘다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; git -C "$B" push -q origin "$RB1"
      git -C "$B" worktree add -q --force "$W/busy" "$RB1"
      rel -- abort
      check "exit ≠ 0" [ "$RC" != 0 ]; check "삭제 실패 문구" has "로컬 $RB1 삭제 실패"; check "✔ 없음" hasnt "✔ 접기"
      check "원격 release 브랜치 그대로" [ -n "$(oref "refs/heads/$RB1")" ] ;;
    finish-headmoved) # F7①(Claude M3) — MERGED 인데 원격 head 가 그 뒤 다른 커밋이면 지우지 않는다(정리는 진행)
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_INDIRECT=off -- ship --notes "$W/notes.md" --skip-build --skip-apk
      prset 1 state MERGED; prpush LIFE-1-a a.txt a-after; NEWH="$(oref refs/heads/LIFE-1-a)"
      rel -- finish
      check "exit 0" eq "$RC" 0; check "다른 커밋 문구" has "와 다르다 — 지우지 않음"; check "head 그대로(새 커밋)" eq "$(oref refs/heads/LIFE-1-a)" "$NEWH" ;;
    finish-deletefail) # F5(Grok 3) — MERGED 뒤 head 삭제가 실패하면 미해결 — finish 는 release 브랜치를 지우지 않는다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; echo refs/heads/LIFE-1-a > "$W/reject-delete"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 13" eq "$RC" 13; check "삭제 실패 미해결" has "#1(head 삭제 실패)"
      rel -- finish
      check "finish exit 13" eq "$RC" 13; check "release 브랜치 남김" git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      check "원격 release 브랜치 남김" [ -n "$(oref "refs/heads/$RB1")" ]
      rm "$W/reject-delete"; rel -- finish
      check "삭제 풀린 뒤 finish exit 0" eq "$RC" 0; check "head 삭제" eq "$(oref refs/heads/LIFE-1-a)" "" ;;
    finish-tag-on-tip) # F6(Grok 4) — finish 의 출고 확인도 「머지 커밋 태그」로만
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; git -C "$B" tag v0.1.1 "$RB1"; git -C "$B" push -q origin v0.1.1; S0="$(snap)"
      rel -- finish --leave-open
      check "exit 2" eq "$RC" 2; check "출고 확인 안 됨" has "출고가 확인되지 않았다"; check "불변" eq "$(snap)" "$S0" ;;
    fakegh-fidelity) # F7⑦(Claude L3) — 가짜 gh 가 실 gh 처럼 null 은 빈 줄, 모르는 --json 필드는 실패
      mkpr 1 LIFE-1-a a.txt a
      G() { (cd "$B" && PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" gh "$@"); }
      LAST="$W/fid.txt"; { G pr view 1 --json mergeCommit --jq .mergeCommit.oid; echo "rc=$?"; G pr view 1 --json nope 2>&1; echo "rc=$?"; } > "$LAST" 2>&1
      cat "$LAST" >> "$LOG"
      check "null → 빈 줄" eq "$(head -1 "$LAST")" ""; check "null 줄 rc 0" eq "$(sed -n 2p "$LAST")" "rc=0"
      check "모르는 필드 실패" grep -q 'Unknown JSON field' "$LAST"; check "모르는 필드 rc≠0" eq "$(tail -1 "$LAST")" "rc=1"
      RC=0 ;;
    abort-ok) # C6ⓐⓒ
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; M0="$(oref refs/heads/main)"
      rel -- abort
      check "exit 0" eq "$RC" 0; check "로컬 브랜치 없음" not git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      check "worktree 없음" [ ! -d "$(WT1)" ]; check "PR1 OPEN" eq "$(prstate 1)" OPEN; check "PR1 head 그대로" [ -n "$(oref refs/heads/LIFE-1-a)" ]
      check "main 불변" eq "$(oref refs/heads/main)" "$M0"; check "태그 0" eq "$(git --git-dir="$O" tag | wc -l | tr -d ' ')" 0
      rel -- abort
      check "재실행 exit 0" eq "$RC" 0; check "접을 것 없음" has "접을 release 브랜치가 없다" ;;
    abort-pushed) # ship 이 release 브랜치를 push·PR 을 연 뒤 멈춘 상태에서 접기 → 원격도 지움, release PR 닫힘, 원래 PR 열린 채
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rel FGH_MERGE_FAIL=1 -- ship --notes "$W/notes.md" --skip-build --skip-apk
      rel -- abort
      check "exit 0" eq "$RC" 0; check "원격 release 브랜치 없음" eq "$(oref "refs/heads/$RB1")" ""
      check "release PR CLOSED" eq "$(cd "$B" && PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" gh pr view 2 --json state --jq .state)" CLOSED
      check "PR1 OPEN" eq "$(prstate 1)" OPEN ;;
    abort-dirty) # C6ⓓ
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; echo x >> "$(WT1)/shared.txt"; S0="$(snap)"
      rel -- abort
      check "exit 2" eq "$RC" 2; check "ref·worktree 불변" eq "$(snap)" "$S0" ;;
    abort-shipped)
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; S0="$(snap)"
      rel -- abort
      check "exit 2" eq "$RC" 2; check "finish 안내" has "finish"; check "불변" eq "$(snap)" "$S0" ;;
    finish-ok) # C6ⓑⓒ
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      rel -- finish
      check "exit 0" eq "$RC" 0; check "worktree 없음" [ ! -d "$(WT1)" ]
      check "로컬·원격 release 브랜치 없음" eq "$(oref "refs/heads/$RB1")$(git -C "$B" rev-parse -q --verify "refs/heads/$RB1")" ""
      check "태그 그대로" [ -n "$(oref refs/tags/v0.1.1)" ]
      rel -- finish
      check "재실행 exit 0" eq "$RC" 0; check "정리할 것 없음" has "정리할 release 브랜치가 없다" ;;
    finish-unshipped) # C6ⓑ — 출고 확인 전에는 지우지 않음
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; S0="$(snap)"
      rel -- finish
      check "exit 2" eq "$RC" 2; check "사유" has "출고가 확인되지 않았다"; check "불변" eq "$(snap)" "$S0" ;;
    finish-dirty) # C6ⓓ
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      echo x >> "$(WT1)/shared.txt"; S0="$(snap)"
      rel -- finish
      check "exit 2" eq "$RC" 2; check "불변" eq "$(snap)" "$S0" ;;
    ns-main-rehearsal|ns-throwaway-v|ns-base-only|ns-prefix-only|ns-other-base|ns-gather-half|ns-ship-half|ns-pipe-base|ns-pipe-both|ns-chars) # C7 음성 대조 — ref·push 0건
      git -C "$H" push -q origin origin/main:refs/heads/throwaway/x-base; : > "$W/push-log.txt"
      MSG="짝이 맞지 않는다"
      case "$CASE" in
        # r1 지적(Claude M2·Grok 5): '|' 가 든 값이 짝 패턴을 속였다 — 글자 검사가 먼저 거절한다
        ns-pipe-base) A="cut --base throwaway/a|rehearsal-b --tag-prefix v"; MSG="쓸 수 없는 글자"
          git -C "$H" push -q origin "origin/main:refs/heads/throwaway/a|rehearsal-b"; : > "$W/push-log.txt" ;;
        ns-pipe-both) A="cut --base throwaway/x|main --tag-prefix v|rehearsal-x"; MSG="쓸 수 없는 글자" ;;
        ns-chars) A="cut --base throwaway/a|b --tag-prefix rehearsal-x-v"; MSG="쓸 수 없는 글자" ;;
        ns-main-rehearsal) A="cut --base main --tag-prefix rehearsal-x-v" ;;
        ns-throwaway-v) A="cut --base throwaway/x-base --tag-prefix v" ;;
        ns-base-only) A="cut --base throwaway/x-base" ;;
        ns-prefix-only) A="cut --tag-prefix rehearsal-x-v" ;;
        ns-other-base) A="cut --base release/v9.9.9 --tag-prefix rehearsal-x-v" ;;
        ns-gather-half) A="gather --prs 1 --base throwaway/x-base" ;;
        ns-ship-half) A="ship --notes $W/notes.md --tag-prefix rehearsal-x-v" ;;
      esac
      S0="$(snap)"; rel -- $A
      check "exit 1" eq "$RC" 1; check "거절 문구($MSG)" has "$MSG"; check "ref·worktree 0건" eq "$(snap)" "$S0"
      check "push 0건" eq "$(wc -l < "$W/push-log.txt" | tr -d ' ')" 0 ;;
    ns-rehearsal|ns-rehearsal-default) # C7 양성 — 리허설 인자로 끝까지. 이름이 전부 throwaway/·rehearsal- 아래, main·v*·release/v* 불변
      # ns-rehearsal: 비기본 base 라 가짜 gh 가 간접 머지를 하지 않는다(GHES 3.12 문장) → exit 13 경로 · -default: 기본 브랜치로 흉내 → exit 0
      git -C "$H" push -q origin origin/main:refs/heads/throwaway/x-base; : > "$W/push-log.txt"
      EX=""; [ "$CASE" = ns-rehearsal-default ] && EX="FGH_DEFAULT=throwaway/x-base"
      mkpr 1 throwaway/x-pr1 a.txt a throwaway/x-base; mkpr 2 throwaway/x-pr2 b.txt b throwaway/x-base feature
      M0="$(oref refs/heads/main)"; R="--base throwaway/x-base --tag-prefix rehearsal-x-v"
      rel $EX -- cut $R; check "cut exit 0" eq "$RC" 0
      RRB="throwaway/x-base-release/rehearsal-x-v0.1.1"
      check "release 브랜치 이름" git -C "$B" rev-parse -q --verify "refs/heads/$RRB"
      check "worktree 이름" [ -d "$B/.claude/worktrees/release-rehearsal-x-v0.1.1" ]
      rel $EX -- gather --prs "1 2" $R; check "gather exit 0" eq "$RC" 0
      rel $EX -- ship --notes "$W/notes.md" --skip-build --skip-apk $R
      if [ "$CASE" = ns-rehearsal ]; then check "ship exit 13(비기본 base 간접 머지 없음)" eq "$RC" 13
      else check "ship exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; fi
      check "리허설 태그 = base 끝" eq "$(oref 'refs/tags/rehearsal-x-v0.1.1^{commit}')" "$(oref refs/heads/throwaway/x-base)"
      check "prerelease" eq "$(cat "$W/gh/release/rehearsal-x-v0.1.1")" pre
      check "main 불변" eq "$(oref refs/heads/main)" "$M0"
      check "v*·release/v* 0건" eq "$(git --git-dir="$O" for-each-ref --format='%(refname)' 'refs/tags/v*' 'refs/heads/release/' | wc -l | tr -d ' ')" 0
      check "push 된 ref 가 전부 throwaway/·rehearsal- 아래" eq "$(awk '{print $1}' "$W/push-log.txt" | grep -vcE '^refs/(heads/throwaway/|tags/rehearsal-)')" 0
      rel $EX -- finish $R
      if [ "$CASE" = ns-rehearsal ]; then check "finish exit 13(기록 보존)" eq "$RC" 13
      else check "finish exit 0" eq "$RC" 0; check "release 브랜치 정리" eq "$(oref "refs/heads/$RRB")" ""; fi
      if [ "$CASE" = ns-rehearsal ]; then # 리허설 정리 — 간접 머지가 없는 비기본 base 는 --leave-open 으로 release 브랜치를 정리
        rel $EX -- finish --leave-open $R
        check "finish --leave-open exit 0" eq "$RC" 0; check "release 브랜치 정리" eq "$(oref "refs/heads/$RRB")$(git -C "$B" rev-parse -q --verify "refs/heads/$RRB")" ""
      fi ;;
    upload-empty) # C1ⓐⓗ — 빈 Release → dmg·APK·체크섬 둘, 서버 digest = 로컬 sha256, 받은 파일이 체크섬에 통과
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up -- --tag v0.1.1 --dir "$ART"
      check "exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4; check "upload 4회" eq "$(upcalls)" 4; check "clobber 0" eq "$(clobbers)" 0
      check "dmg 서버 digest = 로컬" eq "$(sdigest corral-0.1.1-arm64.dmg)" "$(lsha "$ART/corral-0.1.1-arm64.dmg")"
      check "apk 서버 digest = 로컬" eq "$(sdigest corral-mobile-0.1.1.apk)" "$(lsha "$ART/corral-mobile-0.1.1.apk")"
      check "체크섬 파일 꼴" eq "$(cat "$W/gh/assets/$UT/files/corral-0.1.1-arm64.dmg.sha256")" "$(shasum -a 256 "$ART/corral-0.1.1-arm64.dmg" | cut -d' ' -f1)  corral-0.1.1-arm64.dmg"
      check "확인 문구" has "✔ Release v0.1.1 asset — 서버 digest = 로컬 sha256"
      check "받은 파일 shasum -c 통과(2)" dlcheck 2; check "바이너리 전부 덮음" covered
      echo tampered >> "$W/gh/assets/$UT/files/corral-0.1.1-arm64.dmg"; check "양성 대조: 바뀐 dmg 는 shasum -c 실패" not dlcheck 2 ;;
    upload-rerun) # C1ⓑ — 같은 명령 재실행 → upload 0·exit 0
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up -- --tag v0.1.1 --dir "$ART"; S0="$(astore)"
      up -- --tag v0.1.1 --dir "$ART"
      check "exit 0" eq "$RC" 0; check "upload 누적 4회(재실행 0)" eq "$(upcalls)" 4; check "건너뜀 문구" has "건너뜀(같은 digest): corral-0.1.1-arm64.dmg"
      check "asset 불변" eq "$(astore)" "$S0" ;;
    upload-partial) # C1ⓒ — 일부만 있는 Release → 빠진 것만
      mkrel; mkart v0.1.1 0.1.1 dmg apk; seedasset corral-0.1.1-arm64.dmg "$ART/corral-0.1.1-arm64.dmg"
      up -- --tag v0.1.1 --dir "$ART"
      check "exit 0" eq "$RC" 0; check "upload 3회" eq "$(upcalls)" 3; check "dmg 는 안 올림" eq "$(grep -c 'release upload v0.1.1 .*arm64\.dmg$' "$W/gh/calls.txt")" 0
      check "asset 4개" eq "$(nassets)" 4; check "받은 파일 통과" dlcheck 2 ;;
    upload-mismatch|upload-mismatch-sum|upload-open|upload-nodigest) # C1ⓓ — 같은 이름·다른 digest / 끝나지 않은 asset / digest 없음 → 거절, upload·clobber 0, 서버 무변경
      mkrel; mkart v0.1.1 0.1.1 dmg apk; EX=""
      case "$CASE" in
        upload-mismatch) echo other > "$W/other"; seedasset corral-0.1.1-arm64.dmg "$W/other"; MSG="corral-0.1.1-arm64.dmg: 같은 이름·다른 digest" ;;
        upload-mismatch-sum) seedasset corral-0.1.1-arm64.dmg "$ART/corral-0.1.1-arm64.dmg"; echo "0000  corral-0.1.1-arm64.dmg" > "$W/other"
          seedasset corral-0.1.1-arm64.dmg.sha256 "$W/other"; MSG="corral-0.1.1-arm64.dmg.sha256: 같은 이름·다른 digest" ;;
        upload-open) seedasset corral-mobile-0.1.1.apk "$ART/corral-mobile-0.1.1.apk" open; MSG="corral-mobile-0.1.1.apk: 올리기가 끝나지 않은 asset(state=open)" ;;
        upload-nodigest) seedasset corral-0.1.1-arm64.dmg "$ART/corral-0.1.1-arm64.dmg"; EX="FGH_DIGEST_NULL=corral-0.1.1-arm64.dmg"; MSG="corral-0.1.1-arm64.dmg: 서버 digest 가 없다" ;;
      esac
      S0="$(astore)"; up $EX -- --tag v0.1.1 --dir "$ART"
      check "exit 1" eq "$RC" 1; check "사유($MSG)" has "$MSG"; check "아무것도 올리지 않음 문구" has "아무것도 올리지 않음(지우거나 덮어쓰지 않는다)"
      check "upload 0" eq "$(upcalls)" 0; check "clobber 0" eq "$(clobbers)" 0; check "서버 asset 무변경" eq "$(astore)" "$S0" ;;
    upload-norelease) # C1ⓔ — Release 없음
      mkart v0.1.1 0.1.1 dmg apk
      up -- --tag v0.1.1 --dir "$ART"
      check "exit 1" eq "$RC" 1; check "사유" has "GitHub Release v0.1.1 가 없다"; check "upload 0" eq "$(upcalls)" 0 ;;
    upload-badtag|upload-badprefix|upload-verdiff|upload-dirtag|upload-noapk-missing) # C1ⓔ — 태그 형식·접두 / 파일 이름 버전 ≠ 태그 / 폴더 ≠ 태그 / 필요한 파일 없음 → gh 호출 전 거절
      mkrel; TG=v0.1.1
      case "$CASE" in
        upload-badtag) mkart v0.1.1 0.1.1 dmg apk; TG=v0.1; MSG="꼴이 아니다" ;;
        upload-badprefix) mkart v0.1.1 0.1.1 dmg apk; TG=0.1.1; MSG="접두 'v' 로 시작하지 않는다" ;;
        upload-verdiff) mkart v0.1.1 0.1.0 dmg apk; MSG="파일 이름 버전이 태그 버전 0.1.1 과 다르다" ;;
        upload-dirtag) mkart v0.1.0 0.1.1 dmg apk; MSG="산출물 폴더 'v0.1.0' 가 태그 'v0.1.1' 와 다르다" ;;
        upload-noapk-missing) mkart v0.1.1 0.1.1 dmg; MSG="필요한 파일이 없다: corral-mobile-0.1.1.apk" ;;
      esac
      up -- --tag "$TG" --dir "$ART"
      check "exit 1" eq "$RC" 1; check "사유($MSG)" has "$MSG"; check "gh 호출 0" eq "$(ghcalls)" 0
      [ "$CASE" != upload-noapk-missing ] || check "--no-apk 안내" has "--no-apk" ;;
    upload-apk-later) # C1ⓕ — dmg 만 올린 뒤 APK 를 더해 재실행 → 바이너리 전부 + 체크섬이 전부를 덮는다, dmg 는 다시 안 올림
      mkrel; mkart v0.1.1 0.1.1 dmg
      up -- --tag v0.1.1 --dir "$ART" --no-apk
      check "1차 exit 0" eq "$RC" 0; check "1차 asset 2개" eq "$(nassets)" 2; check "1차 덮음" covered
      mkart v0.1.1 0.1.1 apk; up -- --tag v0.1.1 --dir "$ART"
      check "2차 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4; check "upload 누적 4회" eq "$(upcalls)" 4
      check "dmg 1회만" eq "$(grep -c 'release upload v0.1.1 .*arm64\.dmg$' "$W/gh/calls.txt")" 1
      check "바이너리 전부 덮음" covered; check "받은 파일 통과(2)" dlcheck 2; check "clobber 0" eq "$(clobbers)" 0 ;;
    upload-failmid) # C1ⓖ — upload 도중 실패 → exit≠0, 같은 명령 재실행으로 ⓐ 최종 상태
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up FGH_UPLOAD_FAIL_AT=2 -- --tag v0.1.1 --dir "$ART"
      check "exit 1" eq "$RC" 1; check "실패 문구" has "올리기 실패: corral-0.1.1-arm64.dmg.sha256"; check "asset 1개(앞서 올린 것)" eq "$(nassets)" 1
      up -- --tag v0.1.1 --dir "$ART"
      check "재실행 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4; check "받은 파일 통과" dlcheck 2
      check "dmg 1회만 성공 업로드(재실행은 건너뜀)" has "건너뜀(같은 digest): corral-0.1.1-arm64.dmg"; check "clobber 0" eq "$(clobbers)" 0 ;;
    upload-openmid) # C1ⓖ 보조 — 끊겨 state=open 으로 남은 asset 은 재실행이 지우지 않고 거절(사람이 본다)
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up FGH_UPLOAD_OPEN_AT=3 -- --tag v0.1.1 --dir "$ART"; check "1차 exit 1" eq "$RC" 1
      S0="$(astore)"; up -- --tag v0.1.1 --dir "$ART"
      check "재실행 exit 1" eq "$RC" 1; check "사유" has "corral-mobile-0.1.1.apk: 올리기가 끝나지 않은 asset(state=open)"
      check "재실행 upload 0(누적 3)" eq "$(upcalls)" 3; check "clobber 0" eq "$(clobbers)" 0; check "서버 무변경" eq "$(astore)" "$S0" ;;
    upload-verify-lie) # C1ⓐ 끝 대조 — 올린 뒤 서버 digest 가 로컬과 다르면 exit≠0
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up FGH_DIGEST_LIE=corral-mobile-0.1.1.apk -- --tag v0.1.1 --dir "$ART"
      check "exit 1" eq "$RC" 1; check "대조 실패 문구" has "올린 뒤 대조 실패: corral-mobile-0.1.1.apk"; check "✔ 없음" hasnt "✔ Release" ;;
    upload-dry)
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up -- --tag v0.1.1 --dir "$ART" --dry-run
      check "exit 0" eq "$RC" 0; check "올림 예정" has "올림 예정: corral-mobile-0.1.1.apk"; check "올릴 것 4개" has "올릴 것 4개"; check "upload 0" eq "$(upcalls)" 0 ;;
    fakegh-upload-shape) # 가짜 gh 의 asset 흉내가 낼 꼴을 고정한다. 실 gh 2.88.1 읽기 조회로 본 꼴(digest sha256:<64hex> · 404 본문·문구 · release not found · 탭 줄)만 실 gh 와 대조된 것이다.
      # 중복 이름 거절 문구는 실 gh 에서 관측하지 않은 흉내 문구(쓰기 금지) — 올리기 스크립트는 그 문구를 파싱하지 않으므로 이 케이스는 그 문구의 충실도를 보증하지 않는다
      mkrel; mkart v0.1.1 0.1.1 dmg
      G() { (cd "$B" && PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" gh "$@"); }
      LAST="$W/fid.txt"
      { G release upload v0.1.1 "$ART/corral-0.1.1-arm64.dmg"; echo "rc=$?"; G release upload v0.1.1 "$ART/corral-0.1.1-arm64.dmg" 2>&1; echo "rc=$?"
        G api repos/o/r/releases/tags/v0.1.1 --jq '.assets[0].digest'; echo "rc=$?"
        G api repos/o/r/releases/tags/v9.9.9 --jq .assets 2>&1; echo "rc=$?"; G release view v9.9.9 --json tagName 2>&1; echo "rc=$?"
        G api repos/o/r/releases/tags/v0.1.1 --jq '.assets[0] | "\(.name)\t\(.state)\t\(.digest // "")"'; echo "rc=$?"; } > "$LAST" 2>&1
      cat "$LAST" >> "$LOG"
      check "첫 upload rc 0" eq "$(sed -n 1p "$LAST")" "rc=0"
      check "중복 이름 거절 문구" has "asset under the same name already exists: [corral-0.1.1-arm64.dmg]"; check "중복 rc 1" eq "$(sed -n 3p "$LAST")" "rc=1"
      check "digest 꼴 sha256:<64hex>" grep -qE '^sha256:[0-9a-f]{64}$' "$LAST"
      check "없는 Release api 404" has "gh: Not Found (HTTP 404)"; check "release view 없음" has "release not found"
      check "탭 구분 줄 꼴" grep -qE "^corral-0.1.1-arm64.dmg$(printf '\t')uploaded$(printf '\t')sha256:" "$LAST"
      RC=0 ;;
    upload-retry-reject) # R1-1 — 맨 위 검증 거절본 + retry-*/ 정상본(리뷰어 재현 꼴) → --apk 없이는 거절·gh 0, 사람이 고른 줄을 붙여 넣으면 그 APK 가 올라간다
      mkrel; mkart v0.1.1 0.1.1 dmg; echo "apk-REJECTED-wrong-cert" > "$ART/corral-mobile-0.1.1.apk"
      mkdir -p "$ART/retry-20260101-000000"; echo "apk-GOOD-rebuilt" > "$ART/retry-20260101-000000/corral-mobile-0.1.1.apk"
      up -- --tag v0.1.1 --dir "$ART"
      check "exit 1" eq "$RC" 1; check "사유" has "재시도 APK 가 있다(retry-*/) — 맨 위 APK 는 검증에서 거절된 것일 수 있어"
      check "아무것도 올리지 않음" has "아무것도 올리지 않음"; check "gh 호출 0" eq "$(ghcalls)" 0
      check "후보 맨 위" has "  corral-mobile-0.1.1.apk — sha256 $(shasum -a 256 "$ART/corral-mobile-0.1.1.apk" | cut -d' ' -f1)"
      check "후보 retry" has "  retry-20260101-000000/corral-mobile-0.1.1.apk — sha256 "
      CMD="$(after "$(grep '^  retry-20260101-000000/corral-mobile-0.1.1.apk — ' "$LAST")")"
      check "retry 후보 명령 --apk" eq "$(echo "$CMD" | grep -c -- "--apk '.*/retry-20260101-000000/corral-mobile-0.1.1.apk'\$")" 1
      paste_run "$CMD"
      check "고른 줄 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4
      check "apk 서버 digest = retry 정상본" eq "$(sdigest corral-mobile-0.1.1.apk)" "$(lsha "$ART/retry-20260101-000000/corral-mobile-0.1.1.apk")"
      check "거절본은 안 올라감" eq "$(grep -c REJECTED "$W/gh/assets/$UT/files/corral-mobile-0.1.1.apk")" 0
      check "받은 파일 통과(2)" dlcheck 2 ;;
    upload-apk-place) # R1-1 — --apk 는 그 폴더 맨 위·retry-*/ 바로 아래·그 이름만, --no-apk 와 같이 못 준다
      mkrel; mkart v0.1.1 0.1.1 dmg apk; mkdir -p "$W/elsewhere"; cp "$ART/corral-mobile-0.1.1.apk" "$W/elsewhere/"
      up -- --tag v0.1.1 --dir "$ART" --apk "$W/elsewhere/corral-mobile-0.1.1.apk"
      check "폴더 밖 exit 1" eq "$RC" 1; check "폴더 밖 사유" has "맨 위나 retry-<시각>/ 바로 아래여야 한다"
      up -- --tag v0.1.1 --dir "$ART" --apk "$ART/corral-mobile-0.1.1.apk" --no-apk
      check "--no-apk 같이 exit 1" eq "$RC" 1; check "같이 사유" has "--apk 와 --no-apk 는 같이 줄 수 없다"
      cp "$ART/corral-mobile-0.1.1.apk" "$ART/other.apk"; up -- --tag v0.1.1 --dir "$ART" --apk "$ART/other.apk"
      check "이름 exit 1" eq "$RC" 1; check "이름 사유" has "--apk 파일 이름이 corral-mobile-0.1.1.apk 가 아니다"
      check "gh 호출 0" eq "$(ghcalls)" 0
      up -- --tag v0.1.1 --dir "$ART" --apk "$ART/corral-mobile-0.1.1.apk"
      check "맨 위 --apk exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4 ;;
    upload-stdin) # R1-3 — upload 가 stdin 을 먹어도 올릴 것 전부가 올라간다(루프 here-doc 을 gh 에 물리지 않는다)
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up FGH_UPLOAD_EAT_STDIN=1 -- --tag v0.1.1 --dir "$ART"
      check "exit 0" eq "$RC" 0; check "upload 4회" eq "$(upcalls)" 4; check "asset 4개" eq "$(nassets)" 4; check "받은 파일 통과" dlcheck 2 ;;
    upload-verify-state) # R1-5 — 올린 뒤 digest 는 맞는데 state ≠ uploaded 이면 끝 대조 실패(state 절 판별)
      mkrel; mkart v0.1.1 0.1.1 dmg apk
      up FGH_STATE_LIE=corral-mobile-0.1.1.apk -- --tag v0.1.1 --dir "$ART"
      check "exit 1" eq "$RC" 1; check "대조 실패 문구" has "올린 뒤 대조 실패: corral-mobile-0.1.1.apk"; check "✔ 없음" hasnt "✔ Release" ;;
    ship-build-apkbad) # R1-1·R2-1 — APK 가 쓴 뒤 검증에서 거절(exit 10) → 안내의 묶은 한 줄(APK 만 다시 && 올리기)을 붙여 넣어도 거절본은 안 올라간다
      stubs; mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel STUB_APK_BADVERIFY=1 -- ship --notes "$W/notes.md"
      check "exit 10" eq "$RC" 10; check "upload 0" eq "$(upcalls)" 0; check "retry 안내" has "새 APK 는 retry-<시각>/ 에 생긴다"
      # R2-1 — 「APK 만 다시」 와 「올리기」 는 && 로 묶인 한 줄뿐이다(올리기만 따로 붙여 넣을 줄이 없다)
      A1="$(after "APK 만 다시 → Release 에 올리기:")"
      check "묶은 한 줄(APK && 올리기)" eq "$(echo "$A1" | grep -c "^'.*/release-apk.sh' .* && '.*/release-upload.sh' ")" 1
      check "올리기만 선 줄 없음" eq "$(grep -c "^'[^']*/release-upload.sh' " "$LAST")" 0
      touch "$W/stub-apk-fail"; paste_run "$A1"; rm -f "$W/stub-apk-fail"
      check "묶은 줄: APK 실패면 exit≠0" [ "$RC" != 0 ]; check "묶은 줄: APK 실패면 upload 0" eq "$(upcalls)" 0
      paste_run "$A1"
      check "새 APK 는 retry-*/" eq "$(ls -d "$B/app/dist/release/v0.1.1"/retry-*/corral-mobile-0.1.1.apk | wc -l | tr -d ' ')" 1
      check "묶은 줄: APK 성공 + retry 면 올리기 거절 exit 1" eq "$RC" 1; check "사유" has "재시도 APK 가 있다(retry-*/)"; check "upload 0" eq "$(upcalls)" 0
      GOOD="$(sed -n 's/^✔ stub apk: //p' "$LAST")"; check "정상본 경로" [ -f "$GOOD" ]
      CMD="$(grep -- "--apk '$GOOD'\$" "$LAST")"; check "고를 줄 있음" eq "${CMD:0:1}" "'"
      paste_run "$CMD"; check "고른 줄 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4
      check "apk 서버 digest = 정상본" eq "$(sdigest corral-mobile-0.1.1.apk)" "$(lsha "$GOOD")"
      check "거절본 안 올라감" eq "$(grep -c REJECTED "$W/gh/assets/$UT/files/corral-mobile-0.1.1.apk")" 0 ;;
    ship-build-uploadfail) # C2ⓑ — ship 의 올리기 실패 → exit 14, 머지·태그·Release·dmg·APK 다시 안 함, 출력의 홀로 선 명령을 그대로 붙여 넣으면 이어진다
      stubs; mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel FGH_UPLOAD_FAIL_AT=1 -- ship --notes "$W/notes.md"
      check "exit 14" eq "$RC" 14; check "끝난 단계 문구" has "Release 에 올리기 실패 — 머지·태그 v0.1.1 push·Release·dmg·APK 는 끝났다"
      CMD="$(after "올리기만 다시:")"; check "홀로 선 재실행 명령" eq "${CMD:0:1}" "'"
      check "명령에 --tag 'v0.1.1'" has "--tag 'v0.1.1'"
      M1="$(oref refs/heads/main)"; T0="$(oref refs/tags/v0.1.1)"
      paste_run "$CMD"
      check "붙여 넣기 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4; check "받은 파일 통과" dlcheck 2
      check "pr merge 1회" eq "$(grep -c 'pr merge' "$W/gh/calls.txt")" 1; check "release create 1회" eq "$(grep -c 'release create' "$W/gh/calls.txt")" 1
      check "dmg 1회·apk 1회" eq "$(grep -c '^dmg' "$W/stub.log") $(grep -c '^apk' "$W/stub.log")" "1 1"
      check "main·태그 불변" eq "$(oref refs/heads/main) $(oref refs/tags/v0.1.1)" "$M1 $T0" ;;
    ship-build-skipapk) # C2ⓒ — --skip-apk: dmg 만 올리고 APK 명령·APK 더하기 명령을 안내 → 그대로 붙여 넣으면 4개
      stubs; mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel -- ship --notes "$W/notes.md" --skip-apk
      check "exit 0" eq "$RC" 0; check "asset 2개(dmg·체크섬)" eq "$(nassets)" 2; check "--no-apk 로 올림" grep -q 'release upload v0.1.1 .*arm64\.dmg$' "$W/gh/calls.txt"
      A1="$(after "· --skip-apk — APK 는 나중에(그대로 붙여 넣는다):")"; A2="$(after "APK 뒤 Release 에 APK 더하기(올라간 dmg 는 건너뛴다):")"
      check "APK 명령 있음" eq "${A1:0:1}" "'"; check "더하기 명령 있음(--no-apk 없음)" eq "$(echo "$A2" | grep -c -- '--no-apk')" 0
      paste_run "$A1"; check "APK 붙여 넣기 exit 0" eq "$RC" 0
      paste_run "$A2"; check "더하기 붙여 넣기 exit 0" eq "$RC" 0; check "asset 4개" eq "$(nassets)" 4; check "덮음" covered; check "받은 파일 통과" dlcheck 2 ;;
    ship-skipbuild-upload) # C2ⓒ — --skip-build --skip-apk: 올리지 않고 dmg 뒤 올리기 명령을 안내 → dmg 를 둔 뒤 그대로 붙여 넣으면 올라간다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 0" eq "$RC" 0; check "upload 0" eq "$(upcalls)" 0
      CMD="$(after "dmg 뒤 Release 에 올리기:")"; check "올리기 명령(--no-apk)" eq "$(echo "$CMD" | grep -c -- "/app/dist/release/v0.1.1' --no-apk\$")" 1
      mkdir -p "$B/app/dist/release/v0.1.1"; echo d > "$B/app/dist/release/v0.1.1/corral-0.1.1-arm64.dmg"
      paste_run "$CMD"; check "붙여 넣기 exit 0" eq "$RC" 0; check "asset 2개" eq "$(nassets)" 2; check "받은 파일 통과(1)" dlcheck 1 ;;
    ship-noupload) # C2 — release-upload.sh 가 없으면 머지 전에 거절(exit 2, 아무것도 머지하지 않음)
      stubs; git -C "$B" rm -q scripts/release-upload.sh; git -C "$B" commit -qm "올리기 없음"; git -C "$B" push -q origin HEAD:main; : > "$W/push-log.txt"
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; M0="$(oref refs/heads/main)"
      rel -- ship --notes "$W/notes.md"
      check "exit 2" eq "$RC" 2; check "사유" has "scripts/release-upload.sh 가 없다"; check "main 불변" eq "$(oref refs/heads/main)" "$M0"
      check "release·main push 0" eq "$(grep -c '^refs/heads/release/\|^refs/heads/main ' "$W/push-log.txt")" 0 ;;
    *) echo "모르는 케이스 $CASE" >&2; exit 64 ;;
  esac
  case "$CASE" in upload-*|ship-build-*|ship-skipbuild-upload|ship-tmpwt-fail) check "서버 asset 지우기·고치기 호출 0" eq "$(deletes)" 0 ;; esac # C1ⓓ 직접 단언
  if [ "$CASE_FAIL" = 0 ]; then R=PASS; else R=FAIL; FAILS=$((FAILS + 1)); fi
  echo "$CASE $R last-exit=$RC runs=$N log=$LOG" | tee -a "$SUMMARY"
done
echo "총 실패 케이스 $FAILS" | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
