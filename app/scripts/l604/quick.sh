#!/bin/zsh
# LIFE-604 빠른 관문 — 실행마다 출력·종료코드를 OUT 아래 파일로 남긴다(명시 실행 목록의 원자료). app/ 에서: scripts/l604/quick.sh <OUT>
# 판정(R1-N): 행마다 기대 종료코드와 비교하고, 기대가 「기준과 같은 실패」 인 행은 실패 목록까지 대조한다(expect-failures.mjs) —
# 다른 실패가 섞이면 종료코드가 같아도 실패다. 결과 표 = OUT/VERDICT(행마다 id · 기대 · 실제 · 목록 대조 · 판정), 모두 통과면 OUT/ALL = pass.
# 기준 = b93ae28be(raw/claude/u1 — lint·test 출력). 양성 대조 = pc/manifest.tsv 의 패치마다 positive-control.sh(작업 트리가 깨끗해야 한다).
set -u
OUT=${1:A}; mkdir -p $OUT
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l604t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
APP=$PWD
BASE_RAW=$APP/../specs/LIFE-604-task-create/raw/claude/u1
BASE_COMMIT=b93ae28be
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
: > $OUT/VERDICT
failed=0
# record <id> <기대> <실제> <목록 대조: - | 같음 | 다름(코드)>
record() {
  local ok=pass
  [[ $2 == $3 ]] || ok=fail
  [[ $4 == '-' || $4 == '같음' ]] || ok=fail
  [[ $ok == pass ]] || failed=$((failed + 1))
  print -r -- "$1	기대 $2	실제 $3	목록 $4	$ok" >> $OUT/VERDICT
  print -r -- "$1 exit $3 (기대 $2, 목록 $4) → $ok"
}
run() {
  local id=$1 want=$2; shift 2
  "$@" > $OUT/$id.txt 2>&1
  local code=$?
  echo $code > $OUT/$id.code
  record $id $want $code -
}
# 기준과 같은 실패만이어야 하는 행 — 실패 목록 대조 결과를 <id>.expect.txt 로 남긴다.
run_expect() {
  local id=$1 want=$2 mode=$3 expected=$4; shift 4
  "$@" > $OUT/$id.txt 2>&1
  local code=$?
  echo $code > $OUT/$id.code
  node scripts/l604/expect-failures.mjs $mode $OUT/$id.txt $expected > $OUT/$id.expect.txt 2>&1
  local same=$?
  record $id $want $code $([[ $same == 0 ]] && echo 같음 || echo "다름($same)")
}

# 바꾼 파일 = 기준 commit 대비 바뀐 src·scripts/l604 의 ts·tsx·mjs(지운 파일 제외).
touched=(${(f)"$(git diff --name-only --diff-filter=d $BASE_COMMIT -- src scripts/l604 | sed 's#^app/##' | grep -E '\.(ts|tsx|mjs)$')"})
print -l -- $touched > $OUT/touched.txt

run typecheck 0 npm run typecheck
run boundary 0 npm run check:boundary
run_expect lint 1 lint $BASE_RAW/b-lint.txt npm run lint
run lint-touched 0 npx eslint $touched
run_expect test 1 vitest scripts/l604/expect/test.txt npm test
run nodetest 0 node scripts/run-nodetest.mjs
run create-main 0 npx vitest run src/main/work/create.test.ts src/main/work/mock-source.contract.test.ts src/main/work/la-source.contract.test.ts src/main/work/activity-store.test.ts src/main/work/contract-e123.test.ts src/main/work/service.test.ts
L604_BREAK=create-fields run_expect pc-create-fields 1 vitest scripts/l604/expect/pc-create-fields.txt npx vitest run src/main/work/la-source.contract.test.ts
run create-renderer 0 npx vitest run src/renderer/src/components/TasksPage.create.test.tsx src/renderer/src/components/TasksPage.start.test.tsx src/renderer/src/quick-create-model.test.ts src/renderer/src/hooks/useQuickCreate.test.tsx src/renderer/src/components/TasksPage.test.tsx src/shared/keybindings.test.ts src/renderer/src/components/ShortcutsSection.test.tsx
run data-attrs 0 node scripts/l604/check-data-attrs.mjs
# 검사 장치의 양성 대조 — 일부러 틀린 입력을 주면 실패해야 한다.
run pc-data-attrs 1 node scripts/l604/check-data-attrs.mjs --extra scripts/l604/expect/branch-sample.tsx.txt
{ cat $BASE_RAW/b-lint.txt; print -r -- '/x/app/src/l604-fake.ts'; print -r -- '  1:1  error  양성 대조로 넣은 가짜 오류  no-undef'; } > $OUT/lint-extra-sample.txt
run pc-expect-lint 1 node scripts/l604/expect-failures.mjs lint $OUT/lint-extra-sample.txt $BASE_RAW/b-lint.txt
run pc-expect-empty 2 node scripts/l604/expect-failures.mjs lint /dev/null $BASE_RAW/b-lint.txt
# 가드를 뺀 사본 — 실패 시험 목록이 기대와 같아야 한다.
while IFS=$'\t' read -r name files pattern; do
  [[ -z $name || $name == \#* ]] && continue
  args=(${=files})
  [[ -n $pattern ]] && args+=(-t "$pattern")
  bash scripts/l604/positive-control.sh $APP/scripts/l604/pc/$name.patch $OUT/$name $args > $OUT/$name.run.txt 2>&1
  code=$(cat $OUT/$name.code 2>/dev/null || echo none)
  node scripts/l604/expect-failures.mjs vitest $OUT/$name.txt scripts/l604/expect/$name.txt > $OUT/$name.expect.txt 2>&1
  same=$?
  record $name 1 $code $([[ $same == 0 ]] && echo 같음 || echo "다름($same)")
done < scripts/l604/pc/manifest.tsv
run build 0 npm run build
print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
cat $OUT/ALL
