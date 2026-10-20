#!/bin/zsh
# LIFE-604 최종 관문 — 창 없는 부분(01-criteria 「변경 기록」: 창 회차는 묶음 테스트로 이관). app/ 에서: scripts/l604/final.sh <OUT>
# ⑥ build → check-runtime-bundle(+양성 대조) · check-data-attrs(+양성 대조) · 토큰 두 파일 대조 · 계약 묶음·만들기 시험 전체 1회(C3·C4·C8) ·
# ⑦ 창 없는 작업 하네스 first·restart(「1 passed」) + 양성 대조 2(뒤집힌 판정 칸 문구) + 빈 PHASE 실패. ⑤ before-after.sh·dmg 빌드는 따로 돈다.
# 판정 = quick.sh 와 같은 record·run·run_grep(그 파일에서 그대로 떼어 옴). 결과 = OUT/VERDICT · OUT/ALL.
set -u
OUT=${1:A}; mkdir -p $OUT
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l604t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
: > $OUT/VERDICT
failed=0
eval "$(awk '/^record\(\) \{/,/^\}/' scripts/l604/quick.sh)"
eval "$(awk '/^run\(\) \{/,/^\}/' scripts/l604/quick.sh)"
eval "$(awk '/^run_grep\(\) \{/,/^\}/' scripts/l604/quick.sh)"

run build 0 npm run build
run runtime-bundle 0 node scripts/l604/check-runtime-bundle.mjs
print -r -- 'export const marker = "createItem"' > $OUT/runtime-marker-sample.mjs
run_grep pc-runtime-bundle 1 'runtime-marker-sample.mjs"],"perMarker":{"createItem":1,' node scripts/l604/check-runtime-bundle.mjs --extra $OUT/runtime-marker-sample.mjs
run data-attrs 0 node scripts/l604/check-data-attrs.mjs
run_grep pc-data-attrs 1 'BAD  출처 이름 분기 없음 — scripts/l604/expect/branch-sample.tsx.txt' node scripts/l604/check-data-attrs.mjs --extra scripts/l604/expect/branch-sample.tsx.txt
# C12 토큰 — 앱 토큰 파일과 specs 토큰 파일의 --w-modal-quick-create 값이 같고 둘 다 있어야 한다.
tokens() {
  local a=$(sed -n 's/^ *--w-modal-quick-create: *\([^;]*\);.*/\1/p' src/renderer/src/design-tokens.css)
  local b=$(sed -n 's/^ *--w-modal-quick-create: *\([^;]*\);.*/\1/p' ../specs/design-tokens.css)
  print -r -- "app=$a specs=$b"
  [[ -n $a && $a == $b ]]
}
run tokens 0 tokens
# C3·C4·C8 — 계약 묶음(두 출처) · 만들기 main · 렌더러 만들기 시험 전체 1회.
run_grep contract-create 0 'Test Files  7 passed (7)' npx vitest run src/main/work/mock-source.contract.test.ts src/main/work/la-source.contract.test.ts src/main/work/create.test.ts src/main/work/contract-e123.test.ts src/renderer/src/components/TasksPage.create.test.tsx src/renderer/src/hooks/useQuickCreate.test.tsx src/renderer/src/quick-create-model.test.ts
# ⑦ 창 없는 작업 하네스(C5·C9·C10) — 실행마다 새 ROOT, 결과 JSON 은 OUT 에 옮기고 ROOT 는 지운다(이 실행이 만든 경로만).
WROOT=/tmp/l604w-f$$
L604_ROOT=$WROOT L604_PHASE=first run_grep windowless-first 0 'Tests  1 passed' npx vitest run scripts/l604/windowless.test.tsx
L604_ROOT=$WROOT L604_PHASE=restart run_grep windowless-restart 0 'Tests  1 passed' npx vitest run scripts/l604/windowless.test.tsx
cp $WROOT/windowless-*.json $OUT/ 2>/dev/null
[[ $WROOT == /tmp/l604w-f* ]] && rm -rf $WROOT
for pc in c9-extra c5-leak; do
  [[ $pc == c9-extra ]] && flip='+   "c9": false,' || flip='+   "c5": false,'
  L604_PC=$pc L604_ROOT=$WROOT-$pc L604_PHASE=first run_grep pc-windowless-$pc 1 "$flip" npx vitest run scripts/l604/windowless.test.tsx
  cp $WROOT-$pc/windowless-first.json $OUT/pc-windowless-$pc.json 2>/dev/null
  [[ $WROOT == /tmp/l604w-f* ]] && rm -rf $WROOT-$pc
done
L604_ROOT=$WROOT-nophase run_grep st-windowless-empty-phase 1 'L604_PHASE=first|restart 가 필요하다' npx vitest run scripts/l604/windowless.test.tsx
[[ $WROOT == /tmp/l604w-f* ]] && rm -rf $WROOT-nophase
print -r -- "$WROOT $WROOT-c9-extra $WROOT-c5-leak $WROOT-nophase" > $OUT/tmp-roots.txt
print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
cat $OUT/ALL
