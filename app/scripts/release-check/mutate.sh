#!/usr/bin/env bash
# LIFE-703 C8 양성 대조(LIFE-729 에 release-upload.sh 쌍 추가) — release.sh·release-upload.sh 의 가드 하나를 빼면 그 가드를 보는 케이스가 FAIL 로 바뀌는지 본다.
# app/scripts/release-check/mutate.sh <원자료 폴더> [가드 이름 …]   (생략 = 전부)
# 쌍마다: 대조(변이 없음) PASS + 변이 FAIL 이어야 그 쌍이 통과다. 변이가 사본을 실제로 바꿨는지(diff 줄 수)도 본다. 하나라도 아니면 exit 1.
# 변이: 셋째 칸이 비면 「# guard:<이름>」 줄의 die 를 true 로(거절 가드), 아니면 그 sed 스크립트(루프·재계산·플래그 — die 가 아닌 가드).
# 한 가드 줄의 다른 절을 따로 보려면 이름을 <가드>@<절> 로 쓴다(가드 줄 찾기는 @ 앞 이름). 「# guard: 이름 집합 = 쌍 목록의 가드 이름 집합」도 본다.
set -uo pipefail
OUT="${1:?원자료 폴더}"; shift; mkdir -p "$OUT" || exit 1; OUT="$(cd "$OUT" && pwd)"
ONLY="${*:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="$HERE/../../../scripts/release.sh"
UPL="$HERE/../../../scripts/release-upload.sh"
SUM="$OUT/mutate-summary.txt"; : > "$SUM"
echo "# mutate $(date '+%F %T') · release.sh sha1 $(shasum < "$REL" | cut -c1-12) · release-upload.sh sha1 $(shasum < "$UPL" | cut -c1-12)" | tee -a "$SUM"
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
version-gt	cut-ver-low	
merged-only	ship-noindirect	/# guard:merged-only$/ s/if \[ "\$st" != MERGED \]; then/if false; then/
pkg-version	ship-pkgver	
remote-ahead	ship-remote-ahead	
rpm-tip	ship-merged-moved	
second-parent	ship-second-parent	
base-changed	ship-base-changed	
unrecorded	ship-unrecorded-merge	
record-valid	ship-forged-record	/# guard:record-valid$/ s/ok = /ok = 1 || /
record-anc	ship-forged-record2	
namespace@bothbad	ns-bothbad	/# guard:namespace$/ s/ && \[ "\$BK" != bad \]//
unrec-main-parent	main-merge-recovery	/# guard:unrec-main-parent$/ s/is_ancestor "\$p2" "origin\/\$BASE" && continue/true/
protected-head	protected-head	/# guard:protected-head$/ s/|release\/\*//
rehearsal-head	ns-rehearsal-realhead	/# guard:rehearsal-head$/ s/if \[ "\$BK" = rehearsal \]; then/if false; then/
wt-prune	wt-rmrf	/# guard:wt-prune$/ s/git worktree prune/true/
merged-link	reuse-name	/# guard:merged-link$/ s/is_ancestor "\$h" "\$ref" &&/true \&\&/
upload-present	ship-noupload	
upload-noapk	ship-build-skipapk	/# guard:upload-noapk$/ s/|| UP_FLAG=--no-apk/|| true/
upload-run	ship-build-ok	/# guard:upload-run$/ s/if \[ "\$SKIP_BUILD" = 0 \]; then/if false; then/
upload-fail	ship-build-uploadfail	
P
)"
# release-upload.sh(LIFE-729) — 셋째 칸이 비면 die → true. addbad 판정 줄은 「addbad "」 → 「true "」(거절 목록에 넣지 않음)
PAIRS_UP="$(cat <<'P'
up-tag-form	upload-badtag	
up-dir-tag	upload-dirtag	
up-files	upload-noapk-missing	
up-files@verdiff	upload-verdiff	
up-release	upload-norelease	
up-state	upload-open	/# guard:up-state$/ s/addbad "/true "/
up-nodigest	upload-nodigest	/# guard:up-nodigest$/ s/addbad "/true "/
up-same	upload-rerun	/# guard:up-same$/ s/if \[ "\$dg" = "sha256:\$h" \]; then/if false; then/
up-mismatch	upload-mismatch	/# guard:up-mismatch$/ s/addbad "/true "/
up-mismatch@sum	upload-mismatch-sum	/# guard:up-mismatch$/ s/addbad "/true "/
up-reject	upload-mismatch	
up-verify	upload-verify-lie	
P
)"
BAD=0
# run_pairs <대상 파일> <L703_MUTANT_TARGET> <쌍 목록>
run_pairs() {
local F="$1" TGT="$2" PL="$3"
# 가드 이름 집합 = 쌍 목록의 가드 이름 집합 — 표시만 하고 쌍이 없는 가드(또는 그 반대)가 생기면 실패
GS="$(grep -oE '# guard:[a-z0-9-]+$' "$F" | sed 's/# guard://' | sort -u | tr '\n' ' ')"
PS="$(echo "$PL" | cut -f1 | sed 's/@.*//' | grep . | sort -u | tr '\n' ' ')"
if [ "$GS" = "$PS" ]; then echo "ok $(basename "$F") 가드 이름 집합 = 쌍 목록 ($(echo $GS | wc -w | tr -d ' ')개)" | tee -a "$SUM"
else echo "BAD $(basename "$F") 가드 이름 집합 ≠ 쌍 목록 — 가드만: $(comm -23 <(echo $GS | tr ' ' '\n') <(echo $PS | tr ' ' '\n') | tr '\n' ' ')· 쌍만: $(comm -13 <(echo $GS | tr ' ' '\n') <(echo $PS | tr ' ' '\n') | tr '\n' ' ')" | tee -a "$SUM"; BAD=$((BAD + 1)); fi
while IFS="$(printf '\t')" read -r g c sedx; do
  [ -n "$g" ] || continue
  [ -z "$ONLY" ] || case " $ONLY " in *" $g "*) ;; *) continue ;; esac
  gm="${g%%@*}"; n="$(grep -c "# guard:$gm\$" "$F")"
  [ "$gm" = verify-tag ] || [ "$n" = 1 ] || { echo "BAD guard:$g — 가드 줄이 $n 개(1개여야 한다)" | tee -a "$SUM"; BAD=$((BAD + 1)); continue; }
  [ -n "$sedx" ] || sedx="/# guard:$gm\$/ s/die \"/true \"/"
  changed="$(sed "$sedx" "$F" | diff "$F" - | grep -c '^>' || true)"
  "$HERE/release-test.sh" "$OUT/control-$g" "$c" > /dev/null 2>&1; crc=$?
  L703_MUTANT="$g" L703_MUTANT_SED="$sedx" L703_MUTANT_TARGET="$TGT" "$HERE/release-test.sh" "$OUT/mutant-$g" "$c" > /dev/null 2>&1; mrc=$?
  cl="$(grep "^$c " "$OUT/control-$g/summary.txt" | cut -d' ' -f2)"; ml="$(grep "^$c " "$OUT/mutant-$g/summary.txt" | cut -d' ' -f2)"
  if [ "$changed" -ge 1 ] && [ "$crc" = 0 ] && [ "$cl" = PASS ] && [ "$mrc" != 0 ] && [ "$ml" = FAIL ]; then r=ok; else r=BAD; BAD=$((BAD + 1)); fi
  echo "$r guard:$g case:$c 변이줄=$changed control=$cl(exit $crc) mutant=$ml(exit $mrc) — $(grep -h '  FAIL ' "$OUT/mutant-$g/$c.log" | head -3 | sed 's/^ *FAIL //' | tr '\n' ';')" | tee -a "$SUM"
done <<EOF2
$PL
EOF2
}
run_pairs "$REL" release "$PAIRS"
run_pairs "$UPL" upload "$PAIRS_UP"
echo "나쁜 쌍 $BAD" | tee -a "$SUM"
[ "$BAD" = 0 ]
