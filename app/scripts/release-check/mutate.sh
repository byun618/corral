#!/usr/bin/env bash
# LIFE-703 C8 양성 대조(LIFE-729 에 release-upload.sh·제3자 고지 대조기 쌍 추가) — release.sh·release-upload.sh 의 가드 하나를 빼면 그 가드를 보는 케이스가 FAIL 로 바뀌는지 본다.
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
apk-chain	ship-build-apkbad	/# guard:apk-chain$/ s/\$APK_RERUN \&\& \$UPLOAD_ALL/$APK_RERUN ; $UPLOAD_ALL/
P
)"
# release-upload.sh(LIFE-729) — 셋째 칸이 비면 die → true. addbad 판정 줄은 「addbad "」 → 「true "」(거절 목록에 넣지 않음)
# up-verify@state 는 끝 대조의 state 절만 뺀다 — 가짜 gh 가 state≠uploaded asset 의 digest 를 비우므로 FGH_STATE_LIE(digest 는 맞게·state=open)로만 판별된다
# up-upfail@stdin 은 루프 안 gh 의 </dev/null 을 뺀다 — FGH_UPLOAD_EAT_STDIN 으로 남은 목록이 사라지는지 본다
# 「--apk 파일이 없다」 die 는 쌍(표지)이 없다 — 빼도 바로 뒤 MISSING 점검이 같은 파일을 「필요한 파일이 없다」 로 거절하는 동치 변이라 판별할 케이스가 없다
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
up-verify@state	upload-verify-state	s/\[ "\$(printf '%s' "\$line" | cut -f2)" = uploaded \] && //
up-retry	upload-retry-reject	
up-apk-place	upload-apk-place	
up-upfail	upload-failmid	
up-upfail@stdin	upload-stdin	/# guard:up-upfail$/ s| </dev/null||
up-apk-conflict	upload-apk-place	
up-apk-name	upload-apk-place	
P
)"
# 제3자 고지 대조기(LIFE-729 C9ⓓⓔ) — notice-test.sh 로 판별. 셋째 칸이 비면 가드 줄의 bad( 를 void( 로(그 사유를 세지 않음)
# 「고지 목록이 없다」 exit(대조기 머리)는 쌍이 없다 — 빼도 바로 뒤 원문 파일 읽기가 같은 exit 1 로 끝나는 동치 변이다
PAIRS_NV="$(cat <<'P'
nv-text	dmg-notext	
nv-placeholder	dmg-placeholder	
nv-header	dmg-txthead	
nv-file	dmg-filesha	
nv-tie	dmg-tie	
nv-vendored	dmg-drop-vendored	
nv-unmapped	dmg-unmapped	
nv-npm	dmg-drop-asar	
nv-npm@map	dmg-drop-map	
nv-npm@hash	dmg-drop-hash	
nv-npm@stale	dmg-stale	
nv-nomap	dmg-nomap	
nv-nores	dmg-nores	
nv-unres	dmg-unres	
nv-crate	dmg-drop-crate	
nv-std	dmg-drop-std	
nv-cppns	dmg-drop-cppns	
nv-sym	dmg-drop-sym	
nv-nosym	dmg-nosym	
nv-native	dmg-drop-native	
nv-electron	dmg-electron	
nv-chromium	dmg-drop-chromium	
nv-fw	dmg-nofw	
P
)"
PAIRS_AV="$(cat <<'P'
av-text	apk-notext	
av-text@reason	apk-reason	
av-placeholder	apk-placeholder	
av-header	apk-txthead	
av-cache	apk-nocache	
av-classowner	apk-packagelist	
av-class	apk-class	
av-noclass	apk-noclass	
av-libcxx	apk-drop-libcxx	
av-so	apk-so	
av-soowner	apk-appmodules	
av-version	apk-version	
av-version@stale	apk-stale	
av-asset	apk-asset	
av-assetowner	apk-drop-font	
av-nowork	apk-nowork	
av-find	apk-nomapfile	
av-tie	apk-tie	
av-npm	apk-drop-npm	
av-nosrc	apk-emptymap	
av-nores	apk-nores	
av-unres	apk-unres	
P
)"
# EAS 아카이브 규칙(.easignore, LIFE-729 R3-1) — notice-test.sh eas-archive 로 판별. 가드 표지는 규칙 바로 위 주석 줄이라 셋째 칸에 그 규칙 줄을 지우는 sed 를 적는다
PAIRS_EAS="$(cat <<'P'
eas-lib	eas-archive	s|^!/app/scripts/notices-lib\.mjs$|# (변이) 공용 lib 예외 뺌|
eas-spdx	eas-archive	s|^!/app/scripts/spdx$|# (변이) SPDX 예외 뺌|
P
)"
BAD=0
# run_pairs <대상 파일> <L703_MUTANT_TARGET> <쌍 목록> [하네스 — 기본 release-test.sh] [빈 셋째 칸의 기본 sed 꼴 — 기본 die → true]
run_pairs() {
local F="$1" TGT="$2" PL="$3" RUN="${4:-$HERE/release-test.sh}" DEF="${5:-s/die \"/true \"/}"
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
  [ -n "$sedx" ] || sedx="/# guard:$gm\$/ $DEF"
  changed="$(sed "$sedx" "$F" | diff "$F" - | grep -c '^>' || true)"
  "$RUN" "$OUT/control-$g" "$c" > /dev/null 2>&1; crc=$?
  L703_MUTANT="$g" L703_MUTANT_SED="$sedx" L703_MUTANT_TARGET="$TGT" "$RUN" "$OUT/mutant-$g" "$c" > /dev/null 2>&1; mrc=$?
  cl="$(grep "^$c " "$OUT/control-$g/summary.txt" | cut -d' ' -f2)"; ml="$(grep "^$c " "$OUT/mutant-$g/summary.txt" | cut -d' ' -f2)"
  if [ "$changed" -ge 1 ] && [ "$crc" = 0 ] && [ "$cl" = PASS ] && [ "$mrc" != 0 ] && [ "$ml" = FAIL ]; then r=ok; else r=BAD; BAD=$((BAD + 1)); fi
  echo "$r guard:$g case:$c 변이줄=$changed control=$cl(exit $crc) mutant=$ml(exit $mrc) — $(grep -h '  FAIL ' "$OUT/mutant-$g/$c.log" | head -3 | sed 's/^ *FAIL //' | tr '\n' ';')" | tee -a "$SUM"
done <<EOF2
$PL
EOF2
}
run_pairs "$REL" release "$PAIRS"
run_pairs "$UPL" upload "$PAIRS_UP"
run_pairs "$HERE/../verify-notices.mjs" notice-dmg "$PAIRS_NV" "$HERE/notice-test.sh" 's/bad(/void(/'
run_pairs "$HERE/../../../mobile/scripts/verify-notices.mjs" notice-apk "$PAIRS_AV" "$HERE/notice-test.sh" 's/bad(/void(/'
run_pairs "$HERE/../../../.easignore" notice-eas "$PAIRS_EAS" "$HERE/notice-test.sh"
echo "나쁜 쌍 $BAD" | tee -a "$SUM"
[ "$BAD" = 0 ]
