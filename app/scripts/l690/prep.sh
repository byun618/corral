#!/bin/sh
# LIFE-690 최종 관문 — 기준선·수정본 빌드 out 사본을 만든다. main·preload·runtime 은 같고(이 작업은 렌더러만 바꾼다 — C5ⓐ) 렌더러만 다르다.
#   /tmp/l690-out-fix  = 지금 HEAD 의 electron-vite build (+ 지금 out/runtime)
#   /tmp/l690-out-base = 위 사본에 기준 commit(L690_BASE, 기본 25d4fc301)의 렌더러만 끼운 것. 기준 소스는 git archive → /tmp/l690-src-base(node_modules 심링크)
# 사용: sh scripts/l690/prep.sh   (app/ 에서, src 변경이 없는 깨끗한 HEAD)
set -eu
APP=$(pwd -P); BASE=${L690_BASE:-25d4fc301}; HEAD=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain -- src)" ] || { echo "src 에 커밋 안 된 변경 — 멈춘다"; exit 2; }
[ -d "$APP/out/runtime" ] || { echo "out/runtime 없음 — npm run build 먼저"; exit 2; }
echo "# fix 빌드 ($HEAD)"
npx electron-vite build > /tmp/l690-build-fix.log 2>&1 || { tail -20 /tmp/l690-build-fix.log; exit 1; }
rm -rf /tmp/l690-out-fix && cp -R "$APP/out" /tmp/l690-out-fix && echo "fix $HEAD" > /tmp/l690-out-fix/.l690-build
echo "# base 렌더러 빌드 ($BASE)"
rm -rf /tmp/l690-src-base && mkdir -p /tmp/l690-src-base
git -C "$(git rev-parse --show-toplevel)" archive "$BASE" app > /tmp/l690-src-base.tar && tar -x -C /tmp/l690-src-base -f /tmp/l690-src-base.tar && rm /tmp/l690-src-base.tar
ln -s "$APP/node_modules" /tmp/l690-src-base/app/node_modules
(cd /tmp/l690-src-base/app && npx electron-vite build > /tmp/l690-build-base.log 2>&1) || { tail -20 /tmp/l690-build-base.log; exit 1; }
rm -rf /tmp/l690-out-base && cp -R /tmp/l690-out-fix /tmp/l690-out-base && rm -rf /tmp/l690-out-base/renderer
cp -R /tmp/l690-src-base/app/out/renderer /tmp/l690-out-base/renderer
echo "base $BASE renderer (main·preload·runtime = fix $HEAD)" > /tmp/l690-out-base/.l690-build
# 두 렌더러가 실제로 다른지, terminal-keys 수정(compositionend 추적)이 수정본 번들에만 있는지
for d in base fix; do printf '%s renderer js sha256 ' $d; cat /tmp/l690-out-$d/renderer/assets/*.js | shasum -a 256 | cut -c1-16; printf '%s compositionend 리스너 수 ' $d; cat /tmp/l690-out-$d/renderer/assets/*.js | grep -o 'addEventListener("compositionend"' | wc -l | tr -d ' '; done
cmp -s /tmp/l690-out-base/main/index.js /tmp/l690-out-fix/main/index.js && echo "main 동일"
