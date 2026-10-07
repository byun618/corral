#!/bin/sh
# LIFE-490 fix2 L-5(b) — `native-down.sh` 를 셋째 인자 없이 한 번 부르면 사용자 데이터에 닿기 전에 exit 2 로 멈추는가.
# 전후로 userData 전체·~/.config/herdr 최상위 manifest(l470/native-manifest.mjs — 파일별 해시)를 떠서 같은지 본다. 네이티브 관문은 돌리지 않는다.
# 사용: sh down-argcheck.sh <ROOT=/tmp/l490n*> <raw 폴더>. 종료코드 0 = native-down exit 2 · 전=후 같음.
set -u
ROOT=$1; RAWD=$2
HERE=$(cd "$(dirname "$0")/../l470" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD="$HOME/Library/Application Support/corral"
HCFG="$HOME/.config/herdr"
mkdir -p "$RAWD"
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$RAWD/ud-before.json"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$RAWD/herdr-before.json"
sh "$(dirname "$0")/native-down.sh" "$ROOT" "$RAWD/down" > "$RAWD/native-down.stdout" 2>&1; RC=$?
"$NODE" "$HERE/native-manifest.mjs" "$UD" > "$RAWD/ud-after.json"
"$NODE" "$HERE/native-manifest.mjs" "$HCFG" --top > "$RAWD/herdr-after.json"
echo "native-down exit $RC (기대 2)"; cat "$RAWD/native-down.stdout"
[ -e "$RAWD/down" ] && echo "raw/down 폴더가 생겼다(기대: 없음)" || echo "raw/down 폴더 없음 — 첫 줄에서 멈췄다"
OK=0
cmp -s "$RAWD/ud-before.json" "$RAWD/ud-after.json" && echo "✔ userData manifest 전=후 ($(grep -o '"files":[0-9]*' "$RAWD/ud-after.json" || echo '?'))" || { echo "✘ userData manifest 다름"; OK=1; }
cmp -s "$RAWD/herdr-before.json" "$RAWD/herdr-after.json" && echo "✔ herdr 최상위 manifest 전=후" || { echo "✘ herdr 최상위 manifest 다름"; OK=1; }
[ "$RC" = 2 ] || OK=1
exit $OK
