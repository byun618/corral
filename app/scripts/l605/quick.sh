#!/bin/zsh
# LIFE-605 빠른 관문 — 실행마다 출력·종료코드를 OUT 아래 파일로 남긴다(명시 실행 목록의 원자료). app/ 에서: scripts/l605/quick.sh <OUT>
# LIFE-604 quick.sh 를 본떴다: 행마다 기대 종료코드와 비교하고, 「기준과 같은 실패」 행은 실패 목록까지 대조한다(scripts/l604/expect-failures.mjs).
# 결과 표 = OUT/VERDICT(행마다 id · 기대 · 실제 · 목록 대조 · 판정), 모두 통과면 OUT/ALL = pass.
# 기준 = af6d8d068(raw/claude/u1-base — lint·test 출력). 최종 관문(창 없는 하네스 재시작·grep·dmg·캡처)은 이 장치 밖이다.
set -u
OUT=${1:A}; mkdir -p $OUT
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
APP=$PWD
BASE_RAW=$APP/../specs/LIFE-605-jira-cloud/raw/claude/u1-base
BASE_COMMIT=af6d8d068
git rev-parse --short HEAD > $OUT/head.txt
git status --porcelain > $OUT/porcelain.txt
: > $OUT/VERDICT
failed=0
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
run_expect() {
  local id=$1 want=$2 mode=$3 expected=$4; shift 4
  "$@" > $OUT/$id.txt 2>&1
  local code=$?
  echo $code > $OUT/$id.code
  node scripts/l604/expect-failures.mjs $mode $OUT/$id.txt $expected > $OUT/$id.expect.txt 2>&1
  local same=$?
  record $id $want $code $([[ $same == 0 ]] && echo 같음 || echo "다름($same)")
}
# 종료코드에 더해 기대 문구(고정 문자열)가 출력에 있어야 하는 행 — 다른 이유로 같은 종료코드가 나도 통과로 읽지 않는다.
run_grep() {
  local id=$1 want=$2 needle=$3; shift 3
  "$@" > $OUT/$id.txt 2>&1
  local code=$?
  echo $code > $OUT/$id.code
  if grep -qF -- "$needle" $OUT/$id.txt; then print -r -- "기대 문구 있음: $needle" > $OUT/$id.expect.txt; record $id $want $code 같음
  else print -r -- "기대 문구 없음: $needle" > $OUT/$id.expect.txt; record $id $want $code "다름(문구)"; fi
}

# 바꾼 파일 = 기준 commit 대비 바뀐(+새) src·scripts/l600·scripts/l605 의 ts·tsx·mjs(지운 파일 제외).
touched=(${(f)"$( { git diff --name-only --diff-filter=d $BASE_COMMIT -- src scripts/l600 scripts/l605; git ls-files --others --exclude-standard -- src scripts/l605; } | sed 's#^app/##' | grep -E '\.(ts|tsx|mjs)$' | sort -u)"})
print -l -- $touched > $OUT/touched.txt

run typecheck 0 npm run typecheck
run boundary 0 npm run check:boundary
run source-branch 0 node scripts/l600/renderer-source-branch.mjs
run st-source-branch 0 node scripts/l600/renderer-source-branch.mjs --self-test
run_expect lint 1 lint $BASE_RAW/b-lint.txt npm run lint
run lint-touched 0 npx eslint $touched
run_expect test 1 vitest $BASE_RAW/b-test.txt npm test
run nodetest 0 node scripts/run-nodetest.mjs
# 이 작업 시험 — Jira 단위·fixture · 계약 묶음 3출처 · ADF · 렌더러(폼·카드·작업 페이지×fixture·만들기 모델).
run jira-main 0 npx vitest run src/main/work/jira-source.test.ts src/main/work/adf.test.ts src/main/work/adf-editor.test.ts src/main/work/jira-source.contract.test.ts src/main/work/la-source.contract.test.ts src/main/work/mock-source.contract.test.ts src/main/work/store.test.ts src/main/work/service.test.ts src/main/work/create.test.ts
run jira-renderer 0 npx vitest run src/renderer/src/components/ConnectionsSection.test.tsx src/renderer/src/components/TasksPage.jira.test.tsx src/renderer/src/quick-create-model.test.ts src/renderer/src/hooks/useQuickCreate.test.tsx src/renderer/src/components/TasksPage.test.tsx src/renderer/src/components/TaskDetail.service.test.tsx src/renderer/src/tasks-model.test.ts src/renderer/src/markdown.test.tsx
# 계약 묶음 양성 대조 — fixture 응답 모양 하나를 깨면 Jira 묶음이 실패해야 한다(「N failed | M passed」 줄까지 본다 — 컴파일 실패의 exit 1 을 대조 통과로 읽지 않는다).
for brk in issue-no-status transition-no-to unknown-category rank-207 project-no-key search-issues-object; do
  L605_BREAK=$brk run_grep pc-$brk 1 'failed | ' npx vitest run src/main/work/jira-source.contract.test.ts
done
# fixture·출처가 쓰는 경로가 공식 명세(받아 둔 사본 — 커밋 안 함)에 있고 옛 경로는 deprecated 인가.
run spec-paths 0 python3 -I scripts/l605/spec-paths.py /tmp/l605t/spec
run data-attrs 0 node scripts/l605/check-data-attrs.mjs --base $BASE_COMMIT
# 기준 대조 양성 대조(R1-V) — 기준을 지금 HEAD 로 주면 「새로 켬」 속성이 이미 있어 BASE 행으로 실패해야 한다.
run_grep pc-data-attrs-base 1 'BASE data-connection-account ' node scripts/l605/check-data-attrs.mjs --base HEAD
print -r -- 'export const nothing = 1' > $OUT/data-attrs-empty-sample.tsx
run_grep pc-data-attrs 1 'MISS data-connection-account ' node scripts/l605/check-data-attrs.mjs --extra $OUT/data-attrs-empty-sample.tsx
run build 0 npm run build
run runtime-bundle 0 node scripts/l605/check-runtime-bundle.mjs
print -r -- 'export const marker = "/rest/api/3/search/jql"' > $OUT/runtime-marker-sample.mjs
run_grep pc-runtime-bundle 1 '"/rest/api/3/search/jql":1' node scripts/l605/check-runtime-bundle.mjs --extra $OUT/runtime-marker-sample.mjs
# 제품 진입점 — 빌드한 main 번들의 fixture 게이트를 꺼내 돌려 본다(R1-V: 표지 글 존재가 아니라 동작) · 레지스트리는 그 값으로만.
run main-registry 0 node scripts/l605/check-main-registry.mjs
# 양성 대조 — 게이트를 일부러 연 사본(소켓·호스트 검사 제거)이면 실패해야 한다.
sed 's#if (socket.length === 0 || !/^http:\\/\\/127\\.0\\.0\\.1:\\d{2,5}$/.test(url)) return null;#if (url.length === 0) return null;#' out/main/index.js > $OUT/leaky-main.js
run_grep pc-main-registry 1 '"ok": false' node scripts/l605/check-main-registry.mjs --bundle $OUT/leaky-main.js
print -r -- "$([[ $failed == 0 ]] && echo pass || echo "fail $failed")" > $OUT/ALL
cat $OUT/ALL
