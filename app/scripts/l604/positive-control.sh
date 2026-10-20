#!/bin/bash
# LIFE-604 양성 대조 — 가드를 뺀 패치를 잠시 적용해 시험을 돌리고(실패해야 판별력이 있다), 결과와 종료코드를 남긴 뒤 되돌린다.
# 쓰는 법: positive-control.sh <패치> <출력 접두사> <vitest 파일·필터 인자…>
#   <출력>.txt = vitest 출력, <출력>.code = 종료코드. 기대 = 0 이 아님(가드를 빼면 시험이 실패한다).
# 작업 트리가 깨끗해야 한다(패치 적용·되돌리기를 git apply 로 한다). 되돌린 뒤 diff 가 없음을 확인한다.
set -u
PATCH=$1; OUT=$2; shift 2
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
if [ -n "$(git status --porcelain -- app/src)" ]; then echo "app/src 가 깨끗하지 않다" >&2; exit 2; fi
git apply "$PATCH" || { echo "패치 적용 실패" >&2; exit 2; }
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" TMPDIR=/tmp/l604t
mkdir -p "$TMPDIR"
(cd app && npx vitest run "$@") > "$OUT.txt" 2>&1
echo $? > "$OUT.code"
git apply -R "$PATCH"
if [ -n "$(git status --porcelain -- app/src)" ]; then echo "되돌리기 실패" >&2; exit 3; fi
echo "exit $(cat "$OUT.code") → $OUT.txt"
