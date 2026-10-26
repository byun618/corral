#!/usr/bin/env bash
# LIFE-703 빠른 확인(C8) — scripts/release.sh 새 흐름(cut·gather·ship·finish·abort)을 로컬 bare 원격 + 가짜 gh 로 케이스별로 돌린다.
# app/scripts/l703/release-test.sh <원자료 폴더> [케이스 …]   (케이스 생략 = 전부, 목록은 ALL)
# 실제 GitHub·본체 checkout 무접촉. 케이스마다 새 bare origin + clone(= 「본체」 B)을 만들고 release.sh·release-ff.sh 사본을 B 에 커밋한다.
# 가짜 gh = fake-gh.sh(간접 머지·head 삭제 → CLOSED·merge commit 머지 흉내). origin 에 update 훅을 달아 **push 로 들어온 ref 갱신**을
# push-log.txt 에 남긴다 — 가짜 gh 의 머지는 update-ref 라 남지 않으므로, refs/heads/main 줄이 있으면 스크립트가 main 에 직접 push 한 것이다(C3ⓕ).
# 양성 대조: L703_MUTANT=<가드 이름> 이면 B 의 release.sh 사본에서 「# guard:<이름>」 줄의 die 를 true 로 바꾼다(mutate.sh 가 쓴다).
#   L703_MUTANT_SED 가 있으면 그 sed 스크립트를 대신 적용한다(die 가 아닌 가드 — 루프·재계산·플래그).
# 임시 폴더는 /tmp/l703.XXXXXX(짧은 고정 접두). 끝나면 지운다.
set -uo pipefail

ALL="old-usage cut-ok cut-dry cut-rerun cut-minor cut-version cut-ver-low cut-tag-exists cut-open-local cut-open-remote cut-otherrepo cut-reattach
gather-ok gather-dry gather-nocut gather-precheck gather-conflict gather-dirty gather-headmove gather-already
gather-stacked gather-after-exit7 record-cutquote cut-reattach-after-merge
ship-ok ship-dry ship-nonotes ship-headmoved ship-mainmoved ship-closedpr ship-rerun ship-tagfail ship-releasefail ship-mergefail ship-unknown ship-createfail ship-noindirect
ship-dirty ship-headmove-late ship-tag-on-tip ship-unrecorded-merge ship-indirect-late ship-mergeable-late
abort-ok abort-pushed abort-dirty abort-shipped abort-after-merge abort-branchbusy finish-leave-open finish-ok finish-unshipped finish-dirty finish-headmoved finish-deletefail finish-tag-on-tip
ns-main-rehearsal ns-throwaway-v ns-base-only ns-prefix-only ns-other-base ns-gather-half ns-ship-half ns-pipe-base ns-pipe-both ns-chars ns-rehearsal ns-rehearsal-default
fakegh-fidelity"
OUT="${1:?원자료 폴더}"; shift
CASES="${*:-$ALL}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
REL="$ROOT/scripts/release.sh"
mkdir -p "$OUT" || exit 1
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d /tmp/l703.XXXXXX)" || { echo "mktemp 실패" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
SUMMARY="$OUT/summary.txt"; : > "$SUMMARY"
MUT="${L703_MUTANT:-}"
echo "# release-test $(date '+%F %T') · git $(git --version | cut -d' ' -f3-) · bash $BASH_VERSION · work $WORK · release.sh sha1 $(shasum < "$REL" | cut -c1-12) · fake-gh sha1 $(shasum < "$HERE/fake-gh.sh" | cut -c1-12)${MUT:+ · 변이 $MUT}" | tee -a "$SUMMARY"

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
  if [ -n "$MUT" ]; then
    sed "${L703_MUTANT_SED:-/# guard:$MUT\$/ s/die \"/true \"/; /# guard:$MUT\$/ s/|| MOVED=/|| true MOVED=/}" "$REL" > "$B/scripts/release.sh"
  else cp "$REL" "$B/scripts/release.sh"; fi
  chmod +x "$B/scripts/release.sh"
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
      rel -- gather --prs 2; check "gather exit 0(기록만)" eq "$RC" 0; check "기록만 문구" has "기록만 남겼다"
      rel -- ship --dry-run --skip-build --skip-apk
      check "경고 사라짐" hasnt "⚠ 기록 없는 merge"; check "집합 #2" has "출고 집합 #2" ;;
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
      check "exit 0" eq "$RC" 0; check "다른 커밋 문구" has "다른 커밋"; check "head 그대로(새 커밋)" eq "$(oref refs/heads/LIFE-1-a)" "$NEWH" ;;
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
    *) echo "모르는 케이스 $CASE" >&2; exit 64 ;;
  esac
  if [ "$CASE_FAIL" = 0 ]; then R=PASS; else R=FAIL; FAILS=$((FAILS + 1)); fi
  echo "$CASE $R last-exit=$RC runs=$N log=$LOG" | tee -a "$SUMMARY"
done
echo "총 실패 케이스 $FAILS" | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
