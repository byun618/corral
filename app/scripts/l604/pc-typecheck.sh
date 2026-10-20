#!/bin/bash
# LIFE-604 R3-H 양성 대조 — 패치(시험 파일에 타입 오류 한 줄)를 잠시 적용해 `npm run typecheck` 를 돌리고 되돌린다.
# 쓰는 법: pc-typecheck.sh <패치> <출력 접두사>   → <출력>.txt · <출력>.code. 기대 = 0 이 아님 + 출력에 그 파일의 오류 줄.
set -u
PATCH=$1; OUT=$2
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
if [ -n "$(git status --porcelain -- app/src)" ]; then echo "app/src 가 깨끗하지 않다" >&2; exit 2; fi
git apply "$PATCH" || { echo "패치 적용 실패" >&2; exit 2; }
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
(cd app && npm run typecheck) > "$OUT.txt" 2>&1
echo $? > "$OUT.code"
git apply -R "$PATCH"
if [ -n "$(git status --porcelain -- app/src)" ]; then echo "되돌리기 실패" >&2; exit 3; fi
grep -q 'TasksPage.create.test.tsx.*l604TypeProbe\|TasksPage.create.test.tsx([0-9]*,[0-9]*): error' "$OUT.txt" || { echo "그 파일의 오류 줄이 없다" >&2; exit 4; }
echo "exit $(cat "$OUT.code") → $OUT.txt"
