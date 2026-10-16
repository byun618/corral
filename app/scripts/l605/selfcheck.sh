#!/bin/zsh
# LIFE-605 수정 1 R1-Y — 최종 관문 장치의 **자기점검**(장치가 돌고, 양성 대조가 실패를 내는지). 최종 관문 판정이 아니다 — 판정은 final.sh·before-after.sh 를 최종 관문에서 돌린다.
#   app/ 에서: scripts/l605/selfcheck.sh <OUT>   (먼저 npm run build — main 게이트·런타임 번들 검사가 out/ 를 읽는다)
# 행: 문법(final.sh·before-after.sh) · 자격 grep 검사기 자기시험 · 창 없는 하네스 first·restart · 양성 대조(leak·search-twice) · 빈 PHASE 실패 · env 없음 = 건너뜀 · boundary-diff 기준 대조.
set -u
OUT=${1:A}; mkdir -p $OUT
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
: > $OUT/VERDICT
failed=0
eval "$(awk '/^record\(\) \{/,/^\}/' scripts/l605/quick.sh)"
eval "$(awk '/^run\(\) \{/,/^\}/' scripts/l605/quick.sh)"
eval "$(awk '/^run_grep\(\) \{/,/^\}/' scripts/l605/quick.sh)"

run st-syntax-final 0 zsh -n scripts/l605/final.sh
run st-syntax-before-after 0 zsh -n scripts/l605/before-after.sh
run st-secret-grep 0 node scripts/l605/secret-grep.mjs --self-test
WROOT=/tmp/l605w-s$$
L605_ROOT=$WROOT L605_PHASE=first run_grep st-windowless-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT L605_PHASE=restart run_grep st-windowless-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
cp $WROOT/windowless-*.json $OUT/ 2>/dev/null
[[ $WROOT == /tmp/l605w-s* ]] && rm -rf $WROOT
for pc in leak search-twice; do
  [[ $pc == leak ]] && flip='+   "c1Secrets": false,' || flip='+     "requests": 2,'
  L605_PC=$pc L605_ROOT=$WROOT-$pc L605_PHASE=first run_grep st-pc-windowless-$pc 1 "$flip" npx vitest run scripts/l605/windowless.test.tsx
  cp $WROOT-$pc/windowless-first.json $OUT/pc-windowless-$pc.json 2>/dev/null
  [[ $WROOT == /tmp/l605w-s* ]] && rm -rf $WROOT-$pc
done
L605_ROOT=$WROOT-nophase run_grep st-windowless-empty-phase 1 'L605_PHASE=first|restart 가 필요하다' npx vitest run scripts/l605/windowless.test.tsx
[[ $WROOT == /tmp/l605w-s* ]] && rm -rf $WROOT-nophase
run_grep st-windowless-skip 0 'Tests  1 skipped' npx vitest run scripts/l605/windowless.test.tsx
run st-boundary-diff 0 sh scripts/l600/boundary-diff.sh af6d8d068
print -r -- "$WROOT $WROOT-leak $WROOT-search-twice $WROOT-nophase" > $OUT/tmp-roots.txt
python3 -I scripts/l605/scrub-raw.py $OUT > $OUT/scrub.txt
print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
cat $OUT/ALL
