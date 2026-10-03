#!/bin/sh
# LIFE-493 수정 r2 G1 — 빌드 하나의 네이티브 넘침(built) 회차: up → seq built → down. native-k5 없이 세 빌드 같은 걸음.
# 사용: sh native-ab-built.sh <ROOT=/tmp/l493n*> <app 폴더> <raw 폴더> <회수>
set -u
ROOT=$1; APP=$2; RAWD=$3; N=$4
HERE=$(cd "$(dirname "$0")" && pwd)
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
FX=/private/tmp/l467n1-fx
mkdir -p "$RAWD"
rm -rf "$FX" && mkdir -p "$FX" && (cd "$FX" && git init -q -b main && echo fx > README.md && git add . && git -c user.name=fx -c user.email=fx@local commit -qm init)
shasum -a 256 "$HOME/.config/herdr/session.json" > "$RAWD/session-json-sha-before.txt"
git -C "$APP" rev-parse --short HEAD > "$RAWD/app-commit.txt"; git -C "$APP" status --short -- src >> "$RAWD/app-commit.txt"
sh "$HERE/native-up.sh" "$ROOT" "$APP" "$RAWD" --allow-session-restore > "$RAWD/native-up.log" 2>&1; UP=$?
echo "up $UP"
if [ $UP -ne 0 ]; then tail -5 "$RAWD/native-up.log"; exit $UP; fi
"$NODE" "$HERE/native-seq.mjs" "$ROOT" "$RAWD" "$FX" built "$N" > "$RAWD/seq-built.log" 2>&1; echo "seq built $? $(tail -1 "$RAWD/seq-built.log" | cut -c1-120)"
sh "$HERE/native-down.sh" "$ROOT" "$RAWD" > "$RAWD/native-down.log" 2>&1; echo "down $? $(tail -1 "$RAWD/native-down.log")"
shasum -a 256 "$HOME/.config/herdr/session.json" > "$RAWD/session-json-sha-after.txt"
[ "$(cut -d' ' -f1 "$RAWD/session-json-sha-before.txt")" = "$(cut -d' ' -f1 "$RAWD/session-json-sha-after.txt")" ] && echo "session.json ok" || echo "session.json MISMATCH"
rm -rf "$FX"
