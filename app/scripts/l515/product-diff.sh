#!/bin/sh
# LIFE-515 fix2 — 제품 파일(app/src 의 테스트가 아닌 파일 + app/package*.json) 변경 목록 — 비어 있어야 통과(exit 0), 있으면 exit 1
BASE=${1:-c4ad04f5}  # 양성 대조: 제품이 바뀐 기준(예 6a7c4d93)을 주면 exit 1 이어야 한다
git diff --name-only $BASE..HEAD -- app/src app/package.json app/package-lock.json > /tmp/l515-pd-all.txt || exit 2
echo "## git diff --name-only $BASE..HEAD -- app/src app/package.json app/package-lock.json"; cat /tmp/l515-pd-all.txt
grep -vE '\.test\.(ts|tsx|mjs|js)$' /tmp/l515-pd-all.txt > /tmp/l515-pd-product.txt
echo "## 그중 제품 파일(테스트 제외)"; cat /tmp/l515-pd-product.txt
[ -s /tmp/l515-pd-product.txt ] && exit 1
echo "(없음)"; exit 0
