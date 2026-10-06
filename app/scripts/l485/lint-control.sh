#!/bin/sh
# LIFE-485 fix3 F10 (r3 R3-05) lint-compare 양성 대조 — 작업 트리 app 을 /tmp/l485-lc/<case> 로 복사해 하나만 바꾸고 lint-compare 를 돌린다.
#  dup     : 기준선에도 있는 위반('structuredClone' is not defined, diff.nodetest.mjs)을 같은 파일에 하나 더 → 개수 비교라 exit 1 이어야 한다(집합 비교였으면 0)
#  missing : 핵심 파일 BackendCard.tsx 를 지움 → exit 2 이어야 한다
# 사용: sh lint-control.sh <worktree 루트> <dup|missing>  — 종료코드는 lint-compare 의 것
W=$1; CASE=$2; D=/tmp/l485-lc/$CASE
rm -rf "$D"; mkdir -p "$D"
rsync -a --exclude node_modules --exclude out "$W/app/" "$D/app/" && ln -s "$W/app/node_modules" "$D/app/node_modules"
case "$CASE" in
  dup) printf '\nvoid structuredClone\n' >> "$D/app/scripts/gui-diff/diff.nodetest.mjs"; tail -2 "$D/app/scripts/gui-diff/diff.nodetest.mjs" ;;
  missing) rm "$D/app/src/renderer/src/components/BackendCard.tsx"; ls "$D/app/src/renderer/src/components/BackendCard.tsx" 2>&1 ;;
  *) echo "case?"; exit 9 ;;
esac
sh "$(dirname "$0")/lint-compare.sh" "$W" "$D/app"; RC=$?
rm -rf "$D"; echo "lint-compare exit $RC"; exit $RC
