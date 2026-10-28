#!/usr/bin/env bash
# task-finish.sh 시험 — 일회용 bare origin + clone(= 「본체」 B) + 가짜 gh(app/scripts/release-check/fake-gh.sh) 로 케이스별로 돌린다.
# scripts/task-finish-test.sh [--script <task-finish.sh 사본>] [--out <원자료 폴더>] [케이스 …]   (케이스 생략 = 전부, 목록은 ALL)
#   --script : 시험할 스크립트(기본: 이 파일 옆 task-finish.sh). 옛 판과 결과를 비교할 때 `git show <커밋>:scripts/task-finish.sh` 로 꺼낸 파일을 준다
#   --out    : 케이스마다 <케이스>.txt(정규화한 출력·종료코드·실행 뒤 상태)를 남긴다 — 두 판의 --out 을 diff 하면 회귀 비교가 된다
# 실제 GitHub·본체 checkout·LA·corral 레지스트리·사용자 herdr 무접촉: PATH 앞에 가짜 gh 와 빈 목록만 내는 가짜 herdr 를 둔다.
# 사용자 git 설정은 끊는다(하네스 전용 전역 설정). 커밋 시각을 고정해 두 판의 해시가 같게 한다.
# 양성 대조: TF_MUTANT=<가드 이름> 이면 B 의 사본에서 「# guard:<이름>」 줄의 die 를 true 로 바꾼다 — 그 가드의 케이스가 FAIL 해야 한다.
# 임시 폴더는 /tmp/tft.XXXXXX(짧은 고정 접두), 끝나면 지운다. 종료코드 0 = 전부 PASS.
set -uo pipefail

ALL="C1a C1b C1c C1d C1e
C2a C2b C2c C2d C2e C2f C2f-variant C2g C2h-root C2h-sub C2i C2j C2k
C3a C3b-lock C3b-delete
C4a C4b
C5a C5b C5c C5d"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/task-finish.sh"; OUT=""; CASES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --script) SCRIPT="${2:?--script 값 없음}"; shift 2 ;;
    --out) OUT="${2:?--out 값 없음}"; shift 2 ;;
    -*) echo "모르는 옵션: $1" >&2; exit 2 ;;
    *) CASES="$CASES $1"; shift ;;
  esac
done
CASES="${CASES:-$ALL}"
[ -f "$SCRIPT" ] || { echo "스크립트 없음: $SCRIPT" >&2; exit 2; }
FAKE_GH="$ROOT/app/scripts/release-check/fake-gh.sh"
[ -f "$FAKE_GH" ] || { echo "가짜 gh 없음: $FAKE_GH" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq 필요(가짜 gh)" >&2; exit 2; }
[ -z "$OUT" ] || { mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)"; } || exit 2
MUT="${TF_MUTANT:-}"
WORK="$(mktemp -d /tmp/tft.XXXXXX)" || exit 2
WORK="$(cd "$WORK" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/gitconfig" <<EOF
[user]
	name = tft
	email = tft@example.invalid
[commit]
	gpgsign = false
[init]
	defaultBranch = main
[advice]
	detachedHead = false
EOF
export GIT_CONFIG_GLOBAL="$WORK/gitconfig" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_DATE="2026-10-28T00:00:00+0000" GIT_COMMITTER_DATE="2026-10-28T00:00:00+0000"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
echo "# task-finish-test $(date '+%F %T') · $(git --version) · /bin/bash $(/bin/bash -c 'echo $BASH_VERSION') · script sha1 $(shasum < "$SCRIPT" | cut -c1-12) · work $WORK${MUT:+ · 변이 $MUT}"

F=feature/LIFE-900-x            # 묶음 브랜치
FN=LIFE-900-x                   # feature worktree 이름

setup() { # 새 fixture: origin(bare) · B(본체) · H(도우미 clone) · bin(가짜 gh·herdr)
  W="$WORK/$CASE"; mkdir -p "$W/bin" "$W/gh/pr"
  O="$W/origin.git"; B="$W/B"; H="$W/H"; WT="$B/.claude/worktrees"; FWT="$WT/$FN"
  git init -q --bare "$O"
  git clone -q "$O" "$B" 2>/dev/null
  printf '.claude/worktrees/\nspecs/\n' > "$B/.gitignore"
  echo a > "$B/a"
  git -C "$B" add -A; git -C "$B" commit -qm init; git -C "$B" push -q origin HEAD:main
  # 시험 대상 사본은 커밋하지 않는다(info/exclude) — 판이 달라도 fixture 해시가 같아야 --out 비교가 된다
  mkdir -p "$B/scripts"; echo /scripts/ >> "$B/.git/info/exclude"
  if [ -n "$MUT" ]; then sed "/# guard:$MUT\$/ s/die \"/true \"/" "$SCRIPT" > "$B/scripts/task-finish.sh"
  else cp "$SCRIPT" "$B/scripts/task-finish.sh"; fi
  git clone -q "$O" "$H" 2>/dev/null
  cp "$FAKE_GH" "$W/bin/gh"; chmod +x "$W/bin/gh"
  printf '#!/bin/sh\necho "herdr $*" >> "%s/herdr-calls.txt"\n[ "$1 $2" = "session list" ] && echo "NAME STATUS"\nexit 0\n' "$W" > "$W/bin/herdr"; chmod +x "$W/bin/herdr"
  N=0
}
gh_() { ( cd "$B" && env PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" gh "$@" ); }
pr() { printf 'state=%s\nbase=%s\nhead=%s\n' "$2" "${4:-main}" "$3" > "$W/gh/pr/$1"; } # pr <번호> <상태> <head> [base]
commit_in() { echo "$2" > "$1/$2"; git -C "$1" add -A; git -C "$1" commit -qm "$2"; }   # commit_in <worktree> <파일>
# 체크포인트 시작(task-start 2단계 체크포인트 블록): origin feature + feature worktree + 커밋 1개 push + OPEN PR #1
mk_feature() {
  git -C "$B" branch -q --no-track "$F" origin/main; git -C "$B" push -q -u origin "$F" 2>/dev/null
  git -C "$B" worktree add -q "$FWT" "$F"
  commit_in "$FWT" f1; git -C "$FWT" push -q origin "$F"
  pr 1 OPEN "$F"
}
# 자식(task-start 2단계 블록, origin/feature 에서): mk_child <이름> — 커밋 1개(push 안 함)
mk_child() { git -C "$B" fetch -q origin; git -C "$B" worktree add -q "$WT/$1" -b "$1" "origin/$F" 2>/dev/null; commit_in "$WT/$1" "c-$1"; }
mk_indep() { git -C "$B" worktree add -q "$WT/$1" -b "$1" main 2>/dev/null; commit_in "$WT/$1" "i-$1"; }   # 독립 작업(main 에서)
mk_release() { git -C "$B" worktree add -q --no-track -b release/v0.0.1 "$WT/release-v0.0.1" origin/main; }
merge_feature_to_main() { # 출고 흉내: origin main 에 feature 를 merge commit 으로(가짜 gh 가 간접 머지로 PR 을 MERGED 로 본다)
  git -C "$H" fetch -q origin; git -C "$H" checkout -q -B main origin/main
  git -C "$H" merge -q --no-ff -m "Merge $F" "origin/$F"; git -C "$H" push -q origin main
}

# 상태 스냅샷 — 무변경 판정과 --out 비교용. 경로는 <W> 로 정규화
snap() {
  {
    echo "## worktrees"; git -C "$B" worktree list --porcelain | grep -E '^(worktree|branch|detached|locked)'
    echo "## local heads"; git -C "$B" for-each-ref refs/heads --format='%(refname) %(objectname)'
    echo "## origin heads"; git --git-dir="$O" for-each-ref refs/heads --format='%(refname) %(objectname)'
    echo "## PR"; gh_ pr list --state all --json number,state,headRefName,headRefOid --jq '.[] | "\(.number) \(.state) \(.headRefName) \(.headRefOid)"'
  } 2>&1 | sed "s#$W#<W>#g"
}
# run [--cwd <폴더>] <인자…> — B 의 사본을 /bin/bash(3.2)로 실행. RC·LAST(출력)
run() {
  local cwd="$B"
  [ "$1" = --cwd ] && { cwd="$2"; shift 2; }
  N=$((N + 1)); LAST="$W/run-$N.txt"
  snap > "$W/before-$N.txt"
  ( cd "$cwd" && env PATH="$W/bin:$PATH" FGH_STATE="$W/gh" FGH_ORIGIN="$O" /bin/bash "$B/scripts/task-finish.sh" "$@" ) > "$LAST" 2>&1
  RC=$?
  snap > "$W/after-$N.txt"
  { echo "\$ task-finish.sh $* (cwd ${cwd#$W/})"; sed "s#$W#<W>#g" "$LAST"; echo "exit=$RC"; } >> "$LOG"
}

check() { # check <설명> <명령…>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "  ok   $d" >> "$LOG"; else echo "  FAIL $d" >> "$LOG"; CASE_FAIL=1; fi
}
has() { grep -qF -- "$1" "$LAST"; }
not() { ! "$@"; }
unchanged() { cmp -s "$W/before-$N.txt" "$W/after-$N.txt"; }
rc_is() { [ "$RC" = "$1" ]; }
rc_fail() { [ "$RC" != 0 ]; }
no_wt() { [ ! -d "$1" ] && ! git -C "$B" worktree list --porcelain | grep -qx "worktree $1"; }
is_wt() { git -C "$B" worktree list --porcelain | grep -qx "worktree $1"; }
no_local() { ! git -C "$B" rev-parse -q --verify "refs/heads/$1" >/dev/null; }
is_local() { git -C "$B" rev-parse -q --verify "refs/heads/$1" >/dev/null; }
remote_oid() { git --git-dir="$O" rev-parse -q --verify "refs/heads/$1" 2>/dev/null; }
pr_state() { [ "$(gh_ pr list --state all --head "$2" --json state --jq '.[0].state')" = "$1" ]; }
no_success() { ! grep -q '^✔' "$LAST"; }
last_line_next() { tail -1 "$LAST" | grep -q '^□ 다음'; }
stopped() { check "exit ≠ 0" rc_fail; check "사유 줄(✖)" has "✖"; check "✔ 없음" no_success; check "무변경" unchanged; }

# ---- 묶음 경로 정상 ----
case_C1a() { setup; mk_feature; local oid; oid="$(remote_oid "$F")"
  run "$F"
  check "exit 0" rc_is 0; check "feature worktree 사라짐" no_wt "$FWT"; check "로컬 feature 사라짐" no_local "$F"
  check "원격 feature 그대로" [ "$(remote_oid "$F")" = "$oid" ]; check "PR OPEN" pr_state OPEN "$F"; check "✔" has "✔ $F 정리 완료"; }
case_C1b() { setup; mk_feature  # 자식이 --into 로 origin feature 를 앞으로 보냈고 로컬 feature 는 뒤
  git -C "$H" fetch -q origin; git -C "$H" checkout -q -B "$F" "origin/$F"; commit_in "$H" child-merged; git -C "$H" push -q origin "$F"
  local oid; oid="$(remote_oid "$F")"
  run "$F"
  check "exit 0" rc_is 0; check "feature worktree 사라짐" no_wt "$FWT"; check "로컬 feature 사라짐" no_local "$F"
  check "원격 feature 그대로" [ "$(remote_oid "$F")" = "$oid" ]; check "PR OPEN" pr_state OPEN "$F"; }
case_C1c() { setup; mk_feature; mk_indep LIFE-901-i; mk_release
  local i r; i="$(git -C "$B" rev-parse LIFE-901-i)"; r="$(git -C "$B" rev-parse release/v0.0.1)"
  run "$F"
  check "exit 0" rc_is 0; check "feature worktree 사라짐" no_wt "$FWT"; check "로컬 feature 사라짐" no_local "$F"
  check "독립 worktree 남음" is_wt "$WT/LIFE-901-i"; check "독립 브랜치 그대로" [ "$(git -C "$B" rev-parse LIFE-901-i)" = "$i" ]
  check "release worktree 남음" is_wt "$WT/release-v0.0.1"; check "release 브랜치 그대로" [ "$(git -C "$B" rev-parse release/v0.0.1)" = "$r" ]; }
case_C1d() { setup; mk_feature; merge_feature_to_main
  run "$F"
  check "exit 0" rc_is 0; check "PR MERGED" pr_state MERGED "$F"; check "feature worktree 사라짐" no_wt "$FWT"
  check "로컬 feature 사라짐" no_local "$F"; check "원격 feature 지움" [ -z "$(remote_oid "$F")" ]; }
case_C1e() { setup; mk_feature
  run "$F"
  check "exit 0" rc_is 0; check "마지막 줄 □ 다음" last_line_next
  check "gh 는 pr list 만" not grep -vE '^gh pr list ' "$W/gh/calls.txt"
  check "herdr 호출 없음" [ ! -e "$W/herdr-calls.txt" ]; }
# ---- 묶음 경로 멈춤 ----
case_C2a() { setup; mk_feature; rm -f "$W/gh/pr/1"; run "$F"; stopped; }
case_C2b() { setup; mk_feature; pr 1 CLOSED "$F"; run "$F"; stopped; }
case_C2c() { setup; mk_feature; commit_in "$FWT" unpushed; run "$F"; stopped; }
case_C2d() { setup; mk_feature; echo changed >> "$FWT/a"; run "$F"; stopped; }
case_C2e() { setup; mk_feature; echo u > "$FWT/untracked"; run "$F"; stopped; }
case_C2f() { setup; mk_feature; mk_child LIFE-901-c; run "$F"; stopped; check "자식 worktree 남음" is_wt "$WT/LIFE-901-c"; }
case_C2f-variant() { setup; mk_feature; mk_child LIFE-901-c   # 자식은 지웠는데 자식의 구현 변형 worktree 가 남았다
  git -C "$B" worktree add -q "$WT/LIFE-901-c-claude" -b LIFE-901-c-claude LIFE-901-c; git -C "$B" worktree remove "$WT/LIFE-901-c"
  run "$F"; stopped; }
case_C2g() { setup; mk_feature; mk_child LIFE-901-c; git -C "$B" worktree remove "$WT/LIFE-901-c"; run "$F"; stopped; }
case_C2h-root() { setup; mk_feature; run --cwd "$FWT" "$F"; stopped; }
case_C2h-sub() { setup; mk_feature; mkdir -p "$FWT/sub"; touch "$FWT/sub/.keep"; git -C "$FWT" add -A; git -C "$FWT" commit -qm sub; git -C "$FWT" push -q origin "$F"
  run --cwd "$FWT/sub" "$F"; stopped; }
case_C2i() { setup; mk_feature; run "$F" --into "$F"; stopped; }
case_C2j() { setup; mk_feature; mkdir -p "$FWT/specs"; echo r > "$FWT/specs/raw.txt"; run "$F"; stopped; check "사유 = specs" has "specs 에 파일"; }
case_C2k() { setup; mk_feature; local b n=1   # 이름 가드만 막도록 각 이름에 원격 브랜치·열린 PR 을 둔다(없으면 PR 없음 가드가 먼저 막는다)
  for b in feature/foo feature/LIFE-x-y feature/LIFE-901 feature/LIFE-902-a/b; do
    n=$((n + 1)); git -C "$H" checkout -q -B "$b" origin/main; commit_in "$H" "k$n"; git -C "$H" push -q origin "$b"; pr "$n" OPEN "$b"
  done
  for b in feature/foo feature/LIFE-x-y feature/LIFE-901 feature/LIFE-902-a/b; do run "$b"; stopped; check "사유 = 이름 꼴" has "꼴만 받는다"; done; }
# ---- 실패를 성공으로 적지 않는다 ----
case_C3a() { setup; mk_feature  # 옛 판 재현(00-analysis F1): ✔ 와 무변경이 함께 나오면 안 된다
  run "$F"; check "✔ 와 무변경이 함께 나오지 않는다" not eval 'grep -q "^✔" "$LAST" && unchanged'; }
case_C3b-lock() { setup; mk_feature; git -C "$B" worktree lock --reason tft "$FWT"   # 주입: 잠긴 worktree 는 remove 가 거절한다
  run "$F"; check "exit ≠ 0" rc_fail; check "✔ 없음" no_success; }
case_C3b-delete() { setup; mk_feature; merge_feature_to_main   # 주입: origin update 훅이 feature 삭제 push 를 거절한다
  printf '#!/bin/sh\n[ "$1" = "refs/heads/%s" ] && [ "$3" = 0000000000000000000000000000000000000000 ] && { echo "흉내: 삭제 거절" >&2; exit 1; }\nexit 0\n' "$F" > "$O/hooks/update"; chmod +x "$O/hooks/update"
  run "$F"; check "exit ≠ 0" rc_fail; check "✔ 없음" no_success; check "원격 feature 남음" [ -n "$(remote_oid "$F")" ]; }
# ---- 멱등 ----
case_C4a() { setup; mk_feature; run "$F"; run "$F"
  check "재실행 exit 0" rc_is 0; check "재실행 무변경" unchanged; check "이미 정리됨 안내" has "이미 정리됨"; }
case_C4b() { setup; mk_feature; git -C "$B" worktree remove "$FWT"   # 반쯤: worktree 는 없고 로컬 feature 만
  run "$F"; check "exit 0" rc_is 0; check "로컬 feature 사라짐" no_local "$F"; check "PR OPEN" pr_state OPEN "$F"; }
# ---- 기존 경로 회귀(옛 판과 같은 결과여야 한다 — --out 비교) ----
case_C5a() { setup; local t=LIFE-901-t; mk_indep "$t"; git -C "$WT/$t" push -q -u origin "$t" 2>/dev/null
  git -C "$B" worktree add -q "$WT/$t-claude" -b "$t-claude" "$t"; pr 1 OPEN "$t"
  run "$t"
  check "exit 0" rc_is 0; check "작업 worktree 사라짐" no_wt "$WT/$t"; check "구현 worktree 사라짐" no_wt "$WT/$t-claude"
  check "로컬 작업 브랜치 사라짐" no_local "$t"; check "로컬 구현 브랜치 사라짐" no_local "$t-claude"; check "원격 작업 브랜치 남음" [ -n "$(remote_oid "$t")" ]; }
case_C5b() { setup; mk_indep LIFE-901-t; run LIFE-901-t; stopped; }
case_C5c() { setup; mk_feature; local c=LIFE-901-c; mk_child "$c"; local tip; tip="$(git -C "$B" rev-parse "$c")"
  run "$c" --into "$F"
  check "exit 0" rc_is 0; check "자식 worktree 사라짐" no_wt "$WT/$c"; check "로컬 자식 사라짐" no_local "$c"
  check "origin feature 에 자식이 들어감" git --git-dir="$O" merge-base --is-ancestor "$tip" "refs/heads/$F"; }
case_C5d() { setup; mk_indep LIFE-901-c; run LIFE-901-c --into main; stopped; }

TOTAL=0; PASSED=0; FAILED_LIST=""
for CASE in $CASES; do
  LOG="$WORK/$CASE.log"; : > "$LOG"; CASE_FAIL=0
  type "case_$CASE" >/dev/null 2>&1 || { echo "FAIL $CASE: 모르는 케이스"; TOTAL=$((TOTAL + 1)); FAILED_LIST="$FAILED_LIST $CASE"; continue; }
  "case_$CASE"
  TOTAL=$((TOTAL + 1))
  if [ "$CASE_FAIL" = 0 ]; then PASSED=$((PASSED + 1)); echo "PASS $CASE"; else FAILED_LIST="$FAILED_LIST $CASE"; echo "FAIL $CASE"; sed 's/^/    /' "$LOG"; fi
  if [ -n "$OUT" ]; then { cat "$LOG"; echo "## 실행 뒤 상태"; snap; } > "$OUT/$CASE.txt"; fi
done
echo "# 결과: PASS $PASSED / $TOTAL${FAILED_LIST:+ · FAIL:$FAILED_LIST}"
[ "$PASSED" = "$TOTAL" ]
