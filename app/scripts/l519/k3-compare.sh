#!/bin/sh
# LIFE-519 fix1 R1-claude-06 — K3ⓑ 기준 사본/고친 코드 k3-server 출력 대조. 머리(# 줄) 제외 본문이 같으면 exit 0.
# 사용(app/): sh scripts/l519/k3-compare.sh <기준 txt> <고친 txt>
set -u
echo "# 기준 $1"; echo "# 고친 $2"
grep -v '^#' "$1" > "${TMPDIR:-/tmp}/l519-k3-base.$$"; grep -v '^#' "$2" > "${TMPDIR:-/tmp}/l519-k3-fixed.$$"
echo "# 본문 줄 수 $(wc -l < "${TMPDIR:-/tmp}/l519-k3-base.$$" | tr -d ' ') / $(wc -l < "${TMPDIR:-/tmp}/l519-k3-fixed.$$" | tr -d ' ')"
diff "${TMPDIR:-/tmp}/l519-k3-base.$$" "${TMPDIR:-/tmp}/l519-k3-fixed.$$"; RC=$?
rm -f "${TMPDIR:-/tmp}/l519-k3-base.$$" "${TMPDIR:-/tmp}/l519-k3-fixed.$$"
[ "$RC" = 0 ] && echo "같음" || echo "다름"
exit $RC
