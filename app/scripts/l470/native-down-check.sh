#!/bin/sh
# LIFE-470 R2-03 자기점검 — native-down 의 ⑧·판정(native-down-tail.sh)을 가짜 익명화기로 돌린다. 프로세스·사용자 파일은 건드리지 않는다.
#   ⓐ 실패 익명화기(출력 후 exit 7) + 앞 단계 통과 → 전체 exit ≠ 0, 「✔ raw 익명화」·「판정: 원복 통과」 없음
#   ⓑ 성공 익명화기 + 앞 단계 통과 → exit 0, 둘 다 있음 (양성 대조)
#   ⓒ 성공 익명화기 + 앞 단계 실패 → exit 1
#   ⓓ 음성 대조 — 예전 줄 모양(`sanitize | tail -1 && pass || fail`)에 실패 익명화기를 넣으면 「✔」 가 나온다(가림 재현)
# 사용: sh native-down-check.sh — 종료코드 0 = 네 항목 모두 기대대로
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
W=$(mktemp -d /tmp/l470-downcheck-XXXXXX)
printf "console.log('익명화: x');console.log('대응표 항목: 가짜');process.exit(7)\n" > "$W/bad.mjs"
printf "console.log('대응표 항목: 가짜')\n" > "$W/good.mjs"
mkdir -p "$W/raw"
OK=0
run() { sh "$HERE/native-down-tail.sh" "$W/raw" "$W/none.json" "$W/$1.log" "$2" "$W/$3.mjs" > "$W/$1.out" 2>&1; echo $?; }
has() { grep -qF -- "$2" "$W/$1.out"; }

A=$(run a 0 bad)
if [ "$A" != 0 ] && ! has a "✔ raw 익명화" && ! has a "판정: 원복 통과"; then echo "✔ ⓐ 실패 익명화기 → exit $A, 성공 문구 없음"; else echo "✘ ⓐ exit $A"; OK=1; fi
B=$(run b 0 good)
if [ "$B" = 0 ] && has b "✔ raw 익명화" && has b "판정: 원복 통과"; then echo "✔ ⓑ 성공 익명화기 → exit 0, 성공 문구"; else echo "✘ ⓑ exit $B"; OK=1; fi
C=$(run c 1 good)
if [ "$C" = 1 ] && has c "판정: 원복 미달"; then echo "✔ ⓒ 앞 단계 실패 → exit 1"; else echo "✘ ⓒ exit $C"; OK=1; fi
D=$(sh -c "pass() { echo '✔ raw 익명화'; }; fail() { echo '✘ raw 익명화 실패'; }; \"$NODE\" \"$W/bad.mjs\" | tail -1 && pass || fail")
case "$D" in *"✔ raw 익명화"*) echo "✔ ⓓ 음성 대조 — 예전 파이프 모양은 실패를 가린다(재현)";; *) echo "✘ ⓓ 예전 모양이 가리지 않았다: $D"; OK=1;; esac
echo "--- ⓐ 출력"; cat "$W/a.out"
rm -rf "$W"
[ "$OK" = 0 ] && { echo "자기점검 통과"; exit 0; } || { echo "자기점검 실패"; exit 1; }
