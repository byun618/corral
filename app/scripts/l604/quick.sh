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
# 종료코드에 더해 기대한 실패 문구(고정 문자열)가 출력에 있어야 하는 행(R4-H) — 다른 이유(인자·경로 오류)로 같은 종료코드가 나도 통과로 읽지 않는다.
# 목록 칸 = 같음(문구 있음) | 다름(문구 없음). 대조 결과는 <id>.expect.txt.
run_grep() {
  local id=$1 want=$2 needle=$3; shift 3
  "$@" > $OUT/$id.txt 2>&1
  local code=$?
  echo $code > $OUT/$id.code
  if grep -qF -- "$needle" $OUT/$id.txt; then print -r -- "기대 문구 있음: $needle" > $OUT/$id.expect.txt; record $id $want $code 같음
  else print -r -- "기대 문구 없음: $needle" > $OUT/$id.expect.txt; record $id $want $code "다름(문구)"; fi
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
run create-renderer 0 npx vitest run src/renderer/src/components/TasksPage.create.test.tsx src/renderer/src/components/TasksPage.start.test.tsx src/renderer/src/quick-create-model.test.ts src/renderer/src/hooks/useQuickCreate.test.tsx src/renderer/src/hooks/useTasksPage.create.test.tsx src/renderer/src/components/TasksPage.test.tsx src/shared/keybindings.test.ts src/renderer/src/components/ShortcutsSection.test.tsx
run data-attrs 0 node scripts/l604/check-data-attrs.mjs
# 검사 장치의 양성 대조 — 일부러 틀린 입력을 주면 실패해야 한다.
run_grep pc-data-attrs 1 'BAD  출처 이름 분기 없음 — scripts/l604/expect/branch-sample.tsx.txt' node scripts/l604/check-data-attrs.mjs --extra scripts/l604/expect/branch-sample.tsx.txt
{ cat $BASE_RAW/b-lint.txt; print -r -- '/x/app/src/l604-fake.ts'; print -r -- '  1:1  error  양성 대조로 넣은 가짜 오류  no-undef'; } > $OUT/lint-extra-sample.txt
run_grep pc-expect-lint 1 'src/l604-fake.ts :: no-undef: 기준 0 → 이번 1' node scripts/l604/expect-failures.mjs lint $OUT/lint-extra-sample.txt $BASE_RAW/b-lint.txt
run_grep pc-expect-empty 2 '묶음을 못 뽑음 — 이번 0' node scripts/l604/expect-failures.mjs lint /dev/null $BASE_RAW/b-lint.txt
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
# R3-H — TasksPage.create 시험이 typecheck 안에 있는가: 타입 오류 한 줄을 넣은 사본 → typecheck 실패 + 그 파일 오류 줄(장치 exit 0 = 기대대로).
run pc-r3h-typecheck 0 bash scripts/l604/pc-typecheck.sh $APP/scripts/l604/pc/pc-r3h-typecheck.patch $OUT/pc-r3h-typecheck-run
run build 0 npm run build
# R2-D — C11 runtime 번들 표지 0(main 대조 ≥1) · 양성 대조 = 표지 든 파일을 함께 세면 exit 1.
run runtime-bundle 0 node scripts/l604/check-runtime-bundle.mjs
print -r -- 'export const marker = "createItem"' > $OUT/runtime-marker-sample.mjs
run_grep pc-runtime-bundle 1 'runtime-marker-sample.mjs"],"perMarker":{"createItem":1,' node scripts/l604/check-runtime-bundle.mjs --extra $OUT/runtime-marker-sample.mjs
# R4-H — run_grep 자체의 판별력(문구 없음·종료코드 다름 → fail).
run run-grep-check 0 zsh scripts/l604/run-grep-check.zsh $OUT/run-grep-check
# R2-E·R1-G 장치 자기점검(양성 대조 내장).
run st-draft-leak 0 node scripts/l604/draft-leak.mjs --self-test
run st-count-creates 0 node scripts/l604/count-creates.mjs --self-test
# R2-B — up.sh 창 모드 가드(아무것도 띄우지 않는 길만): 손 넘김 없음 exit 9 · 맨 앞 앱 빈 값(가짜 lsappinfo) exit 2 · 마른 실행 0. ROOT 는 만들어지지 않아야 한다.
mkdir -p $OUT/fakebin; print -r -- $'#!/bin/sh\nexit 0' > $OUT/fakebin/lsappinfo; chmod +x $OUT/fakebin/lsappinfo
UROOT=/tmp/l604g-q$$
run_grep st-up-handoff 9 'handoff_required' sh scripts/l604/up.sh $UROOT
L604_HANDOFF=quick PATH="$OUT/fakebin:$PATH" run_grep st-up-front 2 '맨 앞 앱을 못 읽는다' sh scripts/l604/up.sh $UROOT
L604_DRY=1 run st-up-dry 0 sh scripts/l604/up.sh $UROOT
run st-up-nothing-made 1 test -e $UROOT
# R2-B — 창 없는 작업 하네스(C9·C5·C10). 실행마다 새 ROOT, 결과 JSON 은 OUT 에 옮기고 ROOT 는 지운다(이 실행이 만든 경로만).
WROOT=/tmp/l604w-q$$
# 「1 passed」 문구까지 본다 — 건너뜀(skipped)·0건은 통과가 아니다(R5-F).
L604_ROOT=$WROOT L604_PHASE=first run_grep windowless-first 0 'Tests  1 passed' npx vitest run scripts/l604/windowless.test.tsx
L604_ROOT=$WROOT L604_PHASE=restart run_grep windowless-restart 0 'Tests  1 passed' npx vitest run scripts/l604/windowless.test.tsx
cp $WROOT/windowless-*.json $OUT/ 2>/dev/null
[[ $WROOT == /tmp/l604w-q* ]] && rm -rf $WROOT
# 양성 대조는 그 판정 칸이 뒤집혀 실패해야 한다(R5-A — 다른 이유로 죽은 exit 1 을 대조 통과로 읽지 않는다): c9-extra → "c9": false · c5-leak → "c5": false.
for pc in c9-extra c5-leak; do
  [[ $pc == c9-extra ]] && flip='+   "c9": false,' || flip='+   "c5": false,'
  L604_PC=$pc L604_ROOT=$WROOT-$pc L604_PHASE=first run_grep pc-windowless-$pc 1 "$flip" npx vitest run scripts/l604/windowless.test.tsx
  cp $WROOT-$pc/windowless-first.json $OUT/pc-windowless-$pc.json 2>/dev/null
  [[ $WROOT == /tmp/l604w-q* ]] && rm -rf $WROOT-$pc
done
# R5-F — ROOT 만 주고 PHASE 를 비우면 건너뛰지 않고 실패한다(ROOT 는 만들어지지 않는다 — PHASE 판정이 먼저).
L604_ROOT=$WROOT-nophase run_grep st-windowless-empty-phase 1 'L604_PHASE=first|restart 가 필요하다' npx vitest run scripts/l604/windowless.test.tsx
[[ $WROOT == /tmp/l604w-q* ]] && rm -rf $WROOT-nophase
print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
cat $OUT/ALL
