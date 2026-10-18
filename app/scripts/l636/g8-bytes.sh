#!/bin/sh
# LIFE-636 G8·E1ⓓ — 637 경계 바이트 보존 검사. 기준 commit 과 작업 트리에서 메모리 표시 줄들이 **같은 바이트로** 있는지 본다.
# 사용(레포 루트에서): sh app/scripts/l636/g8-bytes.sh <기준 commit>
set -u
BASE=${1:?base commit}
fail=0
check_line() { # file line
  file=$1; line=$2
  in_base=$(git show "$BASE:$file" | grep -cxF -- "$line")
  in_head=$(grep -cxF -- "$line" "$file")
  echo "line  $file  base=$in_base head=$in_head  [$line]"
  [ "$in_base" = 1 ] && [ "$in_head" = 1 ] || fail=1
}
SB=app/src/renderer/src/components/StatusBar.tsx
APP=app/src/renderer/src/App.tsx
check_line "$SB" '      {memoryLabel === null ? null : <span>{memoryLabel}</span>}'
check_line "$SB" '  memoryLabel,'
check_line "$SB" '  memoryLabel: string | null'
check_line "$APP" "import { useMemoryLabel } from './hooks/useMemoryLabel.js'"
check_line "$APP" '  const memoryLabel = useMemoryLabel()'
check_line "$APP" '        memoryLabel={memoryLabel}'
H=app/src/renderer/src/hooks/useMemoryLabel.ts
b=$(git show "$BASE:$H" | shasum -a 256 | cut -d' ' -f1)
h=$(shasum -a 256 "$H" | cut -d' ' -f1)
echo "file  $H  base=$b head=$h"
[ "$b" = "$h" ] || fail=1
echo "diff  $H  lines=$(git diff "$BASE" -- "$H" | wc -l | tr -d ' ')"
echo "result fail=$fail"
exit $fail
