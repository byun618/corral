#!/usr/bin/env bash
# LIFE-703 C8 양성 대조 — release.sh 의 가드 하나를 빼면 그 가드를 보는 케이스가 FAIL 로 바뀌는지 본다.
# app/scripts/l703/mutate.sh <원자료 폴더> [가드 이름 …]   (생략 = 전부)
# 쌍마다: 대조(변이 없음) PASS + 변이 FAIL 이어야 그 쌍이 통과다. 변이가 사본을 실제로 바꿨는지(diff 줄 수)도 본다. 하나라도 아니면 exit 1.
# 변이: 셋째 칸이 비면 「# guard:<이름>」 줄의 die 를 true 로(거절 가드), 아니면 그 sed 스크립트(루프·재계산·플래그 — die 가 아닌 가드).
set -uo pipefail
OUT="${1:?원자료 폴더}"; shift; mkdir -p "$OUT" || exit 1; OUT="$(cd "$OUT" && pwd)"
ONLY="${*:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="$HERE/../../../scripts/release.sh"
SUM="$OUT/mutate-summary.txt"; : > "$SUM"
echo "# mutate $(date '+%F %T') · release.sh sha1 $(shasum < "$REL" | cut -c1-12)" | tee -a "$SUM"
# 이름<TAB>케이스<TAB>sed(빈 칸 = die → true)
PAIRS="$(cat <<'P'
open-release	cut-open-local	
tag-exists	cut-tag-exists	
other-repo	cut-otherrepo	
pr-open	gather-precheck	
wt-dirty	gather-dirty	
head-moved	ship-headmoved	/# guard:head-moved$/ s/|| MOVED=/|| true MOVED=/
base-contained	ship-mainmoved	
finish-shipped	finish-unshipped	
namespace	ns-main-rehearsal	
ns-chars	ns-pipe-both	
stacked	gather-stacked	/# guard:stacked$/ s/CUR_TIP=.*/CUR_TIP="$TIP"/
cut-oldest	record-cutquote	/# guard:cut-oldest$/ s/{ cutc = c }/{ if (!cutc) cutc = c }/
gather-merged	gather-after-exit7	
late-head	ship-headmove-late	
ship-dirty	ship-dirty	/# guard:ship-dirty$/ s/wt_clean_or_die "출고"/true/
tag-merge	ship-tag-on-tip	
abort-merged	abort-after-merge	
head-oid	finish-headmoved	/# guard:head-oid$/ s/elif .*; then/elif true; then/
delete-fail	finish-deletefail	/# guard:delete-fail$/ s/UNRESOLVED=[^;]*; //
wait-loop	ship-indirect-late	/# guard:wait-loop$/ s/now="\$(date +%s)"; .*/now=0; break/
mergeable-loop	ship-mergeable-late	/# guard:mergeable-loop$/ s/\$(seq 1 "\$TRIES")/1/
verify-tag	ship-ok	s/ --verify-tag --title/ --title/
P
)"
BAD=0
while IFS="$(printf '\t')" read -r g c sedx; do
  [ -n "$g" ] || continue
  [ -z "$ONLY" ] || case " $ONLY " in *" $g "*) ;; *) continue ;; esac
  n="$(grep -c "# guard:$g\$" "$REL")"
  [ "$g" = verify-tag ] || [ "$n" = 1 ] || { echo "BAD guard:$g — 가드 줄이 $n 개(1개여야 한다)" | tee -a "$SUM"; BAD=$((BAD + 1)); continue; }
  [ -n "$sedx" ] || sedx="/# guard:$g\$/ s/die \"/true \"/"
  changed="$(sed "$sedx" "$REL" | diff "$REL" - | grep -c '^>' || true)"
  "$HERE/release-test.sh" "$OUT/control-$g" "$c" > /dev/null 2>&1; crc=$?
  L703_MUTANT="$g" L703_MUTANT_SED="$sedx" "$HERE/release-test.sh" "$OUT/mutant-$g" "$c" > /dev/null 2>&1; mrc=$?
  cl="$(grep "^$c " "$OUT/control-$g/summary.txt" | cut -d' ' -f2)"; ml="$(grep "^$c " "$OUT/mutant-$g/summary.txt" | cut -d' ' -f2)"
  if [ "$changed" -ge 1 ] && [ "$crc" = 0 ] && [ "$cl" = PASS ] && [ "$mrc" != 0 ] && [ "$ml" = FAIL ]; then r=ok; else r=BAD; BAD=$((BAD + 1)); fi
  echo "$r guard:$g case:$c 변이줄=$changed control=$cl(exit $crc) mutant=$ml(exit $mrc) — $(grep -h '  FAIL ' "$OUT/mutant-$g/$c.log" | head -3 | sed 's/^ *FAIL //' | tr '\n' ';')" | tee -a "$SUM"
done <<EOF2
$PAIRS
EOF2
echo "나쁜 쌍 $BAD" | tee -a "$SUM"
[ "$BAD" = 0 ]
