#!/usr/bin/env bash
# LIFE-703 C8 양성 대조 — release.sh 의 가드 한 줄(「# guard:<이름>」 줄의 die → true)을 빼면 그 가드를 보는 케이스가 FAIL 로 바뀌는지 본다.
# app/scripts/l703/mutate.sh <원자료 폴더>
# 쌍마다: 대조(변이 없음) PASS + 변이 FAIL 이어야 그 쌍이 통과다. 하나라도 아니면 exit 1.
set -uo pipefail
OUT="${1:?원자료 폴더}"; mkdir -p "$OUT" || exit 1; OUT="$(cd "$OUT" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAIRS="open-release:cut-open-local tag-exists:cut-tag-exists other-repo:cut-otherrepo pr-open:gather-precheck wt-dirty:gather-dirty head-moved:ship-headmoved base-contained:ship-mainmoved finish-shipped:finish-unshipped"
SUM="$OUT/mutate-summary.txt"; : > "$SUM"
REL="$HERE/../../../scripts/release.sh"
echo "# mutate $(date '+%F %T') · release.sh sha1 $(shasum < "$REL" | cut -c1-12)" | tee -a "$SUM"
BAD=0
for p in $PAIRS; do
  g="${p%%:*}"; c="${p#*:}"
  n="$(grep -c "# guard:$g\$" "$REL")"
  [ "$n" = 1 ] || { echo "$g 가드 줄이 $n 개 — 1개여야 한다" | tee -a "$SUM"; BAD=$((BAD + 1)); continue; }
  "$HERE/release-test.sh" "$OUT/control-$g" "$c" > /dev/null 2>&1; crc=$?
  L703_MUTANT="$g" "$HERE/release-test.sh" "$OUT/mutant-$g" "$c" > /dev/null 2>&1; mrc=$?
  cl="$(grep "^$c " "$OUT/control-$g/summary.txt" | cut -d' ' -f2)"; ml="$(grep "^$c " "$OUT/mutant-$g/summary.txt" | cut -d' ' -f2)"
  if [ "$crc" = 0 ] && [ "$cl" = PASS ] && [ "$mrc" != 0 ] && [ "$ml" = FAIL ]; then r=ok; else r=BAD; BAD=$((BAD + 1)); fi
  echo "$r guard:$g case:$c control=$cl(exit $crc) mutant=$ml(exit $mrc) — $(grep -h '  FAIL ' "$OUT/mutant-$g/$c.log" | head -3 | sed 's/^ *FAIL //' | tr '\n' ';')" | tee -a "$SUM"
done
echo "나쁜 쌍 $BAD" | tee -a "$SUM"
[ "$BAD" = 0 ]
