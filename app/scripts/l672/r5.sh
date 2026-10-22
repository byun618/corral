#!/usr/bin/env bash
# LIFE-672 R5 — app/ 에서 typecheck·lint·check:boundary·test 를 직렬로 돌리고, lint 실패 파일 목록을 기준(510152c65) 목록과 비교한다.
# app/scripts/l672/r5.sh <원자료 폴더> [기준 lint-files.txt]   (node v24 · 짧은 TMPDIR 로)
# 기준 기본값 = specs/LIFE-672-release-index-lock/raw/claude/r5/base/lint-files.txt (510152c65 에서 같은 방식으로 뽑은 목록)
# 종료: 0 새 실패 0 · 1 새 실패 있음
set -uo pipefail
OUT="${1:?원자료 폴더}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASEF="${2:-$ROOT/specs/LIFE-672-release-index-lock/raw/claude/r5/base/lint-files.txt}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
cd "$ROOT/app" || exit 1
{ echo "# r5 $(date '+%F %T') · node $(node -v) · TMPDIR=${TMPDIR:-} · HEAD $(git rev-parse --short HEAD) + 작업 트리"; uptime; } > "$OUT/exits.txt"
for s in typecheck lint check:boundary test; do
  npm run "$s" > "$OUT/$s.log" 2>&1; echo "$s exit=$?" >> "$OUT/exits.txt"
done
grep -E "^/" "$OUT/lint.log" | sed "s#^$ROOT/##" | sort -u > "$OUT/lint-files.txt"
grep -E "Test Files|Tests  |run-nodetest" "$OUT/test.log" | tail -5 > "$OUT/test-tail.txt"
grep -E "problems" "$OUT/lint.log" >> "$OUT/exits.txt"
cat "$OUT/test-tail.txt" >> "$OUT/exits.txt"
NEW="$(comm -13 "$BASEF" "$OUT/lint-files.txt")"
{ echo "## lint 실패 파일 — 기준에 없고 지금 있는 것"; echo "${NEW:-(없음)}"; } >> "$OUT/exits.txt"
gzip -f "$OUT/lint.log" "$OUT/test.log"
cat "$OUT/exits.txt"
BAD=0
[ "$(grep -cE '^(typecheck|check:boundary|test) exit=0$' "$OUT/exits.txt")" = 3 ] || BAD=1
[ -z "$NEW" ] || BAD=1
exit $BAD
