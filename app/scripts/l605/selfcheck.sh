#!/bin/zsh
# LIFE-605 수정 1 R1-Y — 최종 관문 장치의 **자기점검**(장치가 돌고, 양성 대조가 실패를 내는지). 최종 관문 판정이 아니다 — 판정은 final.sh·before-after.sh 를 최종 관문에서 돌린다.
#   app/ 에서: scripts/l605/selfcheck.sh <OUT>   (먼저 npm run build — main 게이트·런타임 번들 검사가 out/ 를 읽는다)
# 행: 문법(final.sh·before-after.sh) · 자격 grep 검사기 자기시험 · 창 없는 하네스 first·restart · 양성 대조(leak·search-twice·leak-note) · 빈 PHASE 실패 · env 없음 = 건너뜀 · boundary-diff 기준 대조.
set -u
OUT=${1:A}; mkdir -p $OUT
# 이전 실행의 ALL 을 「미완」 으로 먼저 덮는다(R3-F) — 중간에 멈춘 재실행이 옛 pass 를 남기지 않게. 끝의 판정만 이것을 바꾼다.
print -r -- 'fail incomplete' > $OUT/ALL
[[ -n ${L605_STOP_AFTER_MARK:-} ]] && exit 3 # 자기점검 전용(R3-F 양성 대조 — 표지만 쓰고 멈춘다)
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
: > $OUT/VERDICT
failed=0
# 판정 함수를 quick.sh 에서 끌어온다 — 없으면 exit 2, 끝에서 VERDICT 행 수 대조(R2-A).
source scripts/l605/judge.zsh
# R2-A 양성 대조 — 판정 함수가 없는 원본이면 이 스크립트들이 아무것도 안 돌고 통과하지 않는다(exit 2) · 행이 모자라면 ALL=fail.
run st-judge 0 zsh scripts/l605/judge-selftest.zsh $OUT/judge-selftest
print -r -- 'echo 함수 없음' > $OUT/no-fn-quick.sh
L605_JUDGE_SRC=$OUT/no-fn-quick.sh run_grep pc-final-missing-fn 2 '판정 함수(record·run·run_grep)가' zsh scripts/l605/final.sh $OUT/pc-final-missing-fn
L605_JUDGE_SRC=$OUT/no-fn-quick.sh run_grep pc-selfcheck-missing-fn 2 '판정 함수(record·run·run_grep)가' zsh scripts/l605/selfcheck.sh $OUT/pc-selfcheck-missing-fn

# R3-F — 네 관문 스크립트 모두 첫머리에서 옛 ALL 을 「미완」 으로 덮는다 · 양성 대조: 그 줄을 뺀 사본은 옛 pass 를 남긴다(exit 1).
for gate in final selfcheck before-after quick; do
  run_grep st-stale-all-$gate 0 stale-all-ok zsh scripts/l605/stale-all-check.zsh scripts/l605/$gate.sh $OUT/stale-all-$gate
done
grep -vxF "print -r -- 'fail incomplete' > \$OUT/ALL" scripts/l605/final.sh > $OUT/final-unmarked.sh
run_grep pc-stale-all-unmarked 1 stale-all-left zsh scripts/l605/stale-all-check.zsh $OUT/final-unmarked.sh $OUT/stale-all-unmarked
run st-syntax-final 0 zsh -n scripts/l605/final.sh
run st-syntax-before-after 0 zsh -n scripts/l605/before-after.sh
run st-secret-grep 0 node scripts/l605/secret-grep.mjs --self-test
WROOT=/tmp/l605w-s$$
L605_ROOT=$WROOT L605_PHASE=first run_grep st-windowless-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT L605_PHASE=restart run_grep st-windowless-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT L605_PHASE=lifecycle run_grep st-windowless-lifecycle 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
# lifecycle 양성 대조 — 따로 ROOT 를 first·restart 로 채운 뒤 교체한 토큰을 로그에 흘리면 「교체 뒤 grep」 이 잡아야 한다(R2-K).
L605_ROOT=$WROOT-life L605_PHASE=first run_grep st-pc-life-setup-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT-life L605_PHASE=restart run_grep st-pc-life-setup-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_PC=leak L605_ROOT=$WROOT-life L605_PHASE=lifecycle run_grep st-pc-windowless-lifecycle-leak 1 '+     "afterReplace": false,' npx vitest run scripts/l605/windowless.test.tsx
# R3-G 양성 대조 — 렌더러로 가는 반환값에 새 토큰을 끼우면 반환값 훑기가 잡아야 한다(디스크 grep 과 따로, 새 ROOT).
L605_ROOT=$WROOT-ipc L605_PHASE=first run_grep st-pc-ipc-setup-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT-ipc L605_PHASE=restart run_grep st-pc-ipc-setup-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_PC=leak-ipc L605_ROOT=$WROOT-ipc L605_PHASE=lifecycle run_grep st-pc-windowless-lifecycle-leak-ipc 1 '+   "c1Returns": false,' npx vitest run scripts/l605/windowless.test.tsx
cp $WROOT/windowless-*.json $OUT/ 2>/dev/null
[[ $WROOT == /tmp/l605w-s* ]] && rm -rf $WROOT
# leak-note(R4-H) = Jira 응답 글의 자격 지움을 끈 빌드 — 되울린 자격이 서비스 → IPC → 화면으로 가면 반환값 훑기가 잡아야 한다.
for pc in leak search-twice leak-note; do
  case $pc in leak) flip='+   "c1Secrets": false,' ;; search-twice) flip='+     "requests": 2,' ;; leak-note) flip='+   "c1Returns": false,' ;; esac
  L605_PC=$pc L605_ROOT=$WROOT-$pc L605_PHASE=first run_grep st-pc-windowless-$pc 1 "$flip" npx vitest run scripts/l605/windowless.test.tsx
  cp $WROOT-$pc/windowless-first.json $OUT/pc-windowless-$pc.json 2>/dev/null
  [[ $WROOT == /tmp/l605w-s* ]] && rm -rf $WROOT-$pc
done
L605_ROOT=$WROOT-nophase run_grep st-windowless-empty-phase 1 'L605_PHASE=first|restart|lifecycle 가 필요하다' npx vitest run scripts/l605/windowless.test.tsx
[[ $WROOT == /tmp/l605w-s* ]] && rm -rf $WROOT-nophase
run_grep st-windowless-skip 0 'Tests  1 skipped' npx vitest run scripts/l605/windowless.test.tsx
run st-boundary-diff 0 sh scripts/l600/boundary-diff.sh af6d8d068
[[ $WROOT == /tmp/l605w-* ]] && rm -rf $WROOT-life $WROOT-ipc
print -r -- "$WROOT $WROOT-life $WROOT-ipc $WROOT-leak $WROOT-search-twice $WROOT-leak-note $WROOT-nophase" > $OUT/tmp-roots.txt
python3 -I scripts/l605/scrub-raw.py $OUT > $OUT/scrub.txt
judge_close 26
