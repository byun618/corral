#!/bin/zsh
# LIFE-605 최종 관문 장치(수정 1 R1-Y) — **수정 1 에서는 만들고 자기점검만 했다. 돌리는 것은 최종 관문(리뷰 수렴 뒤 1회)이다.**
#   app/ 에서: scripts/l605/final.sh <OUT>
# 창 없는 부분만(격리 Electron 창 금지 — LIFE-603 K1): build → 런타임 번들·data-attrs(기준 대조)·main 게이트 동작(각 양성 대조) · boundary-diff 전후(기준 af6d8d068) ·
# 자격 grep 검사기 자기시험 · 계약 묶음 3출처 + ADF 출발 말뭉치·퍼즈 + Jira 단위 1회 · 창 없는 Jira 하네스 first·restart(「1 passed」) + 양성 대조 3(일부러 새게 한 빌드 = 토큰 로그 · 디바운스 건너뜀 = 요청 수 2 · 응답 글 자격 지움 끔 = 반환값 적중, R4-H) + 빈 PHASE 실패.
# 전후 비교(C14)는 before-after.sh 가 따로 돈다. 판정 = quick.sh 의 record·run·run_grep(그 파일에서 그대로 떼어 옴). 결과 = OUT/VERDICT · OUT/ALL.
set -u
OUT=${1:A}; mkdir -p $OUT
# 이전 실행의 ALL 을 「미완」 으로 먼저 덮는다(R3-F) — 중간에 멈춘 재실행이 옛 pass 를 남기지 않게. 끝의 판정만 이것을 바꾼다.
print -r -- 'fail incomplete' > $OUT/ALL
[[ -n ${L605_STOP_AFTER_MARK:-} ]] && exit 3 # 자기점검 전용(R3-F 양성 대조 — 표지만 쓰고 멈춘다)
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
export TMPDIR=/tmp/l605t; mkdir -p $TMPDIR
cd "$(dirname $0)/../.."
BASE_COMMIT=af6d8d068
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

run build 0 npm run build
run runtime-bundle 0 node scripts/l605/check-runtime-bundle.mjs
print -r -- 'export const marker = "/rest/api/3/search/jql"' > $OUT/runtime-marker-sample.mjs
run_grep pc-runtime-bundle 1 '"/rest/api/3/search/jql":1' node scripts/l605/check-runtime-bundle.mjs --extra $OUT/runtime-marker-sample.mjs
run data-attrs 0 node scripts/l605/check-data-attrs.mjs --base $BASE_COMMIT
run_grep pc-data-attrs-base 1 'BASE data-connection-account ' node scripts/l605/check-data-attrs.mjs --base HEAD
run main-registry 0 node scripts/l605/check-main-registry.mjs
sed 's#if (socket.length === 0 || !/^http:\\/\\/127\\.0\\.0\\.1:\\d{2,5}$/.test(url)) return null;#if (url.length === 0) return null;#' out/main/index.js > $OUT/leaky-main.js
run_grep pc-main-registry 1 '"ok": false' node scripts/l605/check-main-registry.mjs --bundle $OUT/leaky-main.js
# C12 전후 — CSP·보안 옵션·CLI 번들·runtime import·renderer/preload 통신 수·의존성(기준 commit 대비).
run boundary-diff 0 sh scripts/l600/boundary-diff.sh $BASE_COMMIT
run st-secret-grep 0 node scripts/l605/secret-grep.mjs --self-test
# C3·C6 — 계약 묶음 3출처 · ADF 말뭉치(출발 말뭉치 32 + 잠금 11 + 고정 씨앗 퍼즈 2) · Jira 단위 1회.
run_grep contract-adf 0 'Test Files  6 passed (6)' npx vitest run src/main/work/jira-source.contract.test.ts src/main/work/la-source.contract.test.ts src/main/work/mock-source.contract.test.ts src/main/work/adf.test.ts src/main/work/adf-editor.test.ts src/main/work/jira-source.test.ts
# C1④⑤·C5 — 창 없는 Jira 하네스. 실행마다 새 ROOT(이 실행이 만든 경로만 지운다), 결과 JSON 은 OUT 으로.
WROOT=/tmp/l605w-f$$
L605_ROOT=$WROOT L605_PHASE=first run_grep windowless-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT L605_PHASE=restart run_grep windowless-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT L605_PHASE=lifecycle run_grep windowless-lifecycle 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
# lifecycle 양성 대조 — 따로 ROOT 를 first·restart 로 채운 뒤 교체한 토큰을 로그에 흘리면 「교체 뒤 grep」 이 잡아야 한다(R2-K).
L605_ROOT=$WROOT-life L605_PHASE=first run_grep pc-life-setup-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT-life L605_PHASE=restart run_grep pc-life-setup-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_PC=leak L605_ROOT=$WROOT-life L605_PHASE=lifecycle run_grep pc-windowless-lifecycle-leak 1 '+     "afterReplace": false,' npx vitest run scripts/l605/windowless.test.tsx
# R3-G 양성 대조 — 렌더러로 가는 반환값에 새 토큰을 끼우면 반환값 훑기가 잡아야 한다(디스크 grep 과 따로, 새 ROOT).
L605_ROOT=$WROOT-ipc L605_PHASE=first run_grep pc-ipc-setup-first 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_ROOT=$WROOT-ipc L605_PHASE=restart run_grep pc-ipc-setup-restart 0 'Tests  1 passed' npx vitest run scripts/l605/windowless.test.tsx
L605_PC=leak-ipc L605_ROOT=$WROOT-ipc L605_PHASE=lifecycle run_grep pc-windowless-lifecycle-leak-ipc 1 '+   "c1Returns": false,' npx vitest run scripts/l605/windowless.test.tsx
cp $WROOT/windowless-*.json $OUT/ 2>/dev/null
[[ $WROOT == /tmp/l605w-f* ]] && rm -rf $WROOT
# leak-note(R4-H) = Jira 응답 글의 자격 지움을 끈 빌드 — 되울린 자격이 서비스 → IPC → 화면으로 가면 반환값 훑기가 잡아야 한다.
for pc in leak search-twice leak-note; do
  case $pc in leak) flip='+   "c1Secrets": false,' ;; search-twice) flip='+     "requests": 2,' ;; leak-note) flip='+   "c1Returns": false,' ;; esac
  L605_PC=$pc L605_ROOT=$WROOT-$pc L605_PHASE=first run_grep pc-windowless-$pc 1 "$flip" npx vitest run scripts/l605/windowless.test.tsx
  cp $WROOT-$pc/windowless-first.json $OUT/pc-windowless-$pc.json 2>/dev/null
  [[ $WROOT == /tmp/l605w-f* ]] && rm -rf $WROOT-$pc
done
L605_ROOT=$WROOT-nophase run_grep st-windowless-empty-phase 1 'L605_PHASE=first|restart|lifecycle 가 필요하다' npx vitest run scripts/l605/windowless.test.tsx
[[ $WROOT == /tmp/l605w-f* ]] && rm -rf $WROOT-nophase
[[ $WROOT == /tmp/l605w-* ]] && rm -rf $WROOT-life $WROOT-ipc
print -r -- "$WROOT $WROOT-life $WROOT-ipc $WROOT-leak $WROOT-search-twice $WROOT-leak-note $WROOT-nophase" > $OUT/tmp-roots.txt
judge_close 26
