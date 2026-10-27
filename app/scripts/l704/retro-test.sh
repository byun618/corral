#!/usr/bin/env bash
# LIFE-704 최종 관문 C3ⓓ — release §4 회고 커밋이 scripts/release.sh 의 출고 흐름과 맞는지 로컬 bare 원격 + 가짜 gh 로 본다.
# app/scripts/l704/retro-test.sh <원자료 폴더> [케이스 …]   (케이스 생략 = 전부, 목록은 ALL)
# 하네스 도우미(setup·mkpr·prpush·rel·snap·oref·prstate·cutgather·check …)는 l703 release-test.sh 의 것을 그대로 읽어 쓴다 —
# 같은 가짜 gh·같은 격리(전역 git 설정 끊기)라 l703 케이스와 결과를 견줄 수 있다. 실제 GitHub·본체 checkout 무접촉.
# 양성 대조: L703_MUTANT=<가드 이름> [L703_MUTANT_SED=<sed>] 로 release.sh 사본의 가드를 끄면 그 가드를 보는 케이스가 FAIL 이어야 한다.
# 임시 폴더는 /tmp/l704.XXXXXX. 끝나면 지운다.
set -uo pipefail

ALL="retro-ship retro-uncommitted retro-prline retro-regather retro-untracked retro-abort retro-cutquote retro-finish"
OUT="${1:?원자료 폴더}"; shift
CASES="${*:-$ALL}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../l703" && pwd)"   # fake-gh.sh·release-test.sh 자리
ROOT="$(cd "$HERE/../../.." && pwd)"
REL="$ROOT/scripts/release.sh"
mkdir -p "$OUT" || exit 1
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d /tmp/l704.XXXXXX)" || { echo "mktemp 실패" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT
SUMMARY="$OUT/summary.txt"; : > "$SUMMARY"
MUT="${L703_MUTANT:-}"
echo "# retro-test $(date '+%F %T') · HEAD $(git -C "$ROOT" rev-parse --short HEAD) · git $(git --version | cut -d' ' -f3-) · work $WORK · release.sh sha1 $(shasum < "$REL" | cut -c1-12)${MUT:+ · 변이 $MUT}" | tee -a "$SUMMARY"

# l703 하네스의 도우미 구간(전역 git 설정 ~ 케이스 루프 앞)을 읽어 온다. 앵커가 없으면 멈춘다 — 조용히 빈 도우미로 돌지 않게
HELPERS="$(sed -n '/^# 사용자 git 설정을 끊는다/,/^for CASE in/p' "$HERE/release-test.sh" | sed '$d')"
case "$HELPERS" in *"setup()"*"mkpr()"*"rel()"*"cutgather()"*) ;; *) echo "l703 도우미를 못 읽었다 — 앵커 확인" >&2; exit 64 ;; esac
eval "$HELPERS"

# retro <메시지…> — release worktree 에 회고 변경(learnings 영역 파일·ADR)을 만들고 비-merge 커밋 하나로
retro() {
  mkdir -p "$(WT1)/.agents/learnings" "$(WT1)/docs/adr"
  printf '# release learnings\n\nLast reviewed: 2026-10-27\n' > "$(WT1)/.agents/learnings/release.md"
  printf -- '---\nstatus: accepted\n---\n\n# 출고는 release 브랜치\n' > "$(WT1)/docs/adr/0001-release-branch.md"
  git -C "$(WT1)" add -A
  local args=(); for m in "$@"; do args+=(-m "$m"); done
  git -C "$(WT1)" commit -q "${args[@]}"
}
inmain() { git --git-dir="$O" cat-file -e "refs/heads/main:$1" 2>/dev/null; } # 원격 main 에 그 파일이 있나

for CASE in $CASES; do
  LOG="$OUT/$CASE.log"; : > "$LOG"; CASE_FAIL=0
  setup
  case "$CASE" in
    retro-ship) # ① 모으기 뒤 비-merge 회고 커밋 → ship 이 같은 PR 집합으로 끝난다
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"
      retro "docs(release): v0.1.1 회고"
      check "회고 커밋은 비-merge" eq "$(git -C "$(WT1)" rev-list --parents -n 1 HEAD | wc -w | tr -d ' ')" 2
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk --dry-run
      check "dry-run exit 0" eq "$RC" 0; check "dry-run 집합 #1" has "출고 집합 #1"; check "dry-run 집합 #2" has "#2"
      check "기록 없는 merge 경고 없음" hasnt "기록 없는 merge"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "PR2 MERGED" eq "$(prstate 2)" MERGED
      check "회고 learnings 가 main 에" inmain .agents/learnings/release.md; check "회고 ADR 이 main 에" inmain docs/adr/0001-release-branch.md
      check "태그 = main 끝" eq "$(oref 'refs/tags/v0.1.1^{commit}')" "$(oref refs/heads/main)"
      check "main 직접 push 0건" eq "$(mainpushes)" 0 ;;
    retro-uncommitted) # ② 회고 변경(추적 파일 수정)을 커밋하지 않으면 ship 이 dirty 로 거절, ref 불변
      mkpr 1 LIFE-1-a a.txt a; cutgather 1
      echo "회고 메모" >> "$(WT1)/shared.txt"; S0="$(snap)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "사유" has "커밋 안 된 변경"; check "ref 불변" eq "$(snap)" "$S0"; check "PR1 OPEN" eq "$(prstate 1)" OPEN ;;
    retro-prline) # ③ 회고 커밋 메시지에 Release-PR: 줄(형식이 맞는 진짜 SHA) → ship 거절, 머지·태그 0
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather 1; M0="$(oref refs/heads/main)"
      retro "docs(release): v0.1.1 회고" "Release-PR: 2 $(oref refs/heads/LIFE-2-b)"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "exit 2" eq "$RC" 2; check "기록 밖 줄 거절 안내" has "접고(abort) 다시 자른"
      check "main 불변" eq "$(oref refs/heads/main)" "$M0"; check "태그 없음" eq "$(oref refs/tags/v0.1.1)" ""
      check "PR2 OPEN(위조 줄이 집합을 늘리지 않음)" eq "$(prstate 2)" OPEN ;;
    retro-regather) # ④ 회고 커밋 뒤 출고 중 수정(head 이동) → 같은 PR 재gather → 기록·ship 정상
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"
      retro "docs(release): v0.1.1 회고"
      rel -- gather --prs "1 2"; check "head 그대로 재gather exit 0" eq "$RC" 0
      prpush LIFE-2-b b.txt b2
      rel -- gather --prs "1 2"; check "head 이동 뒤 재gather exit 0" eq "$RC" 0
      check "기록에 #1·#2" has "기록(출고 집합): #1@"; check "기록에 #2" has " #2@"
      check "회고 커밋이 release 브랜치에 남음" git -C "$B" merge-base --is-ancestor "$(git -C "$B" log --format=%H --grep '회고' -1 "$RB1")" "$RB1"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "PR2 MERGED" eq "$(prstate 2)" MERGED
      check "새 head 가 main 에" git --git-dir="$O" merge-base --is-ancestor "$(git -C "$H" rev-parse LIFE-2-b)" refs/heads/main
      check "회고 파일이 main 에" inmain .agents/learnings/release.md ;;
    retro-untracked) # ⑤ 미추적 신규 파일만(첫 영역 파일·첫 ADR) → dirty 거절, 커밋하면 같은 PR 집합으로 통과
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"
      mkdir -p "$(WT1)/.agents/learnings" "$(WT1)/docs/adr"
      echo "# 첫 영역" > "$(WT1)/.agents/learnings/first.md"; echo "# 0001" > "$(WT1)/docs/adr/0001-first.md"
      check "추적 파일 변경 0(미추적만)" eq "$(git -C "$(WT1)" status --porcelain --untracked-files=no | wc -l | tr -d ' ')" 0
      S0="$(snap)"; rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "미추적만이어도 exit 2" eq "$RC" 2; check "사유" has "커밋 안 된 변경"; check "ref 불변" eq "$(snap)" "$S0"
      git -C "$(WT1)" add -A; git -C "$(WT1)" commit -qm "docs(release): v0.1.1 회고"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "커밋 뒤 ship exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "PR2 MERGED" eq "$(prstate 2)" MERGED
      check "첫 영역 파일이 main 에" inmain .agents/learnings/first.md ;;
    retro-abort) # ⑥ 회고 커밋이 있는 release 의 abort — 브랜치·worktree 와 함께 회고 커밋도 사라지고 PR 은 열린 채. 미커밋 회고면 abort 거절
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; M0="$(oref refs/heads/main)"
      retro "docs(release): v0.1.1 회고"; RC_SHA="$(git -C "$(WT1)" rev-parse HEAD)"
      echo "덜 끝난 회고" >> "$(WT1)/shared.txt"; S0="$(snap)"
      rel -- abort
      check "미커밋 회고면 abort exit 2" eq "$RC" 2; check "불변" eq "$(snap)" "$S0"
      git -C "$(WT1)" checkout -q -- shared.txt
      rel -- abort
      check "abort exit 0" eq "$RC" 0; check "로컬 브랜치 없음" not git -C "$B" rev-parse -q --verify "refs/heads/$RB1"
      check "worktree 없음" [ ! -d "$(WT1)" ]; check "PR1 OPEN" eq "$(prstate 1)" OPEN; check "main 불변" eq "$(oref refs/heads/main)" "$M0"
      check "회고 커밋이 어느 ref 에서도 닿지 않음(원격)" eq "$(git --git-dir="$O" branch -a --contains "$RC_SHA" 2>/dev/null | wc -l | tr -d ' ')" 0
      check "회고 커밋이 어느 ref 에서도 닿지 않음(로컬)" eq "$(git -C "$B" for-each-ref --contains "$RC_SHA" --format=x | wc -l | tr -d ' ')" 0 ;;
    retro-cutquote) # ⑦ 회고 커밋 메시지가 Release-Cut: 줄을 인용 → 기록이 잘리지 않고 ship 이 같은 PR 집합으로
      mkpr 1 LIFE-1-a a.txt a; mkpr 2 LIFE-2-b b.txt b; cutgather "1 2"
      retro "docs(release): v0.1.1 회고 — 자르기 커밋 인용" "Release-Cut: v0.1.1"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk --dry-run
      check "dry-run exit 0" eq "$RC" 0; check "dry-run 집합 #1" has "출고 집합 #1"; check "dry-run 집합 #2" has "#2"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk
      check "ship exit 0" eq "$RC" 0; check "PR1 MERGED" eq "$(prstate 1)" MERGED; check "PR2 MERGED" eq "$(prstate 2)" MERGED ;;
    retro-finish) # ⑧ 회고 커밋이 있는 release 를 출고한 뒤 finish — 정리되고 태그·main 에 회고가 남는다
      mkpr 1 LIFE-1-a a.txt a; cutgather 1; retro "docs(release): v0.1.1 회고"
      rel -- ship --notes "$W/notes.md" --skip-build --skip-apk; check "ship exit 0" eq "$RC" 0
      rel -- finish
      check "finish exit 0" eq "$RC" 0; check "worktree 없음" [ ! -d "$(WT1)" ]
      check "로컬·원격 release 브랜치 없음" eq "$(oref "refs/heads/$RB1")$(git -C "$B" rev-parse -q --verify "refs/heads/$RB1")" ""
      check "태그에 회고 파일" git --git-dir="$O" cat-file -e "refs/tags/v0.1.1:.agents/learnings/release.md"
      check "PR1 MERGED" eq "$(prstate 1)" MERGED ;;
    *) echo "모르는 케이스 $CASE" >&2; exit 64 ;;
  esac
  if [ "$CASE_FAIL" = 0 ]; then R=PASS; else R=FAIL; FAILS=$((FAILS + 1)); fi
  echo "$CASE $R last-exit=$RC runs=$N log=$LOG" | tee -a "$SUMMARY"
done
echo "총 실패 케이스 $FAILS" | tee -a "$SUMMARY"
[ "$FAILS" = 0 ]
