#!/bin/sh
# LIFE-493 수정 r2 G1 — 빌드 하나의 네이티브 A/B 회차: up → seq plain → native-k5 → seq overflow → down.
# 사용: sh native-ab-cycle.sh <ROOT=/tmp/l493n*> <app 폴더> <raw 폴더> <회수>
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
ps -Ao pid,ppid,command | grep -E "herdr --session default|Electron" | grep -F -e "herdr --session default" -e "$APP" | grep -v grep | cut -c1-160 > "$RAWD/pids-started.txt"
"$NODE" "$HERE/native-seq.mjs" "$ROOT" "$RAWD" "$FX" plain "$N" > "$RAWD/seq-plain.log" 2>&1; echo "seq plain $? $(tail -1 "$RAWD/seq-plain.log" | cut -c1-120)"
"$NODE" "$HERE/native-k5.mjs" "$ROOT" "$RAWD" "$FX" > "$RAWD/k5-driver.log" 2>&1; echo "k5 $? $(grep -c '✘' "$RAWD/k5-driver.log") fails: $(grep '✘' "$RAWD/k5-driver.log" | cut -c1-60 | tr '\n' ' ')"
"$NODE" "$HERE/native-seq.mjs" "$ROOT" "$RAWD" "$FX" overflow "$N" > "$RAWD/seq-overflow.log" 2>&1; echo "seq overflow $? $(tail -1 "$RAWD/seq-overflow.log" | cut -c1-120)"
sh "$HERE/native-down.sh" "$ROOT" "$RAWD" > "$RAWD/native-down.log" 2>&1; echo "down $? $(tail -1 "$RAWD/native-down.log")"
shasum -a 256 "$HOME/.config/herdr/session.json" > "$RAWD/session-json-sha-after.txt"
[ "$(cut -d' ' -f1 "$RAWD/session-json-sha-before.txt")" = "$(cut -d' ' -f1 "$RAWD/session-json-sha-after.txt")" ] && echo "session.json ok" || echo "session.json MISMATCH"
for p in $(pgrep -x claude) $(pgrep -f "grok|codex"); do c=$(lsof -a -p $p -d cwd -Fn 2>/dev/null | grep ^n | cut -c2-); case "$c" in "$FX"*) echo "ORPHAN $p";; esac; done > "$RAWD/orphans-after.txt"
echo "orphans $(wc -l < "$RAWD/orphans-after.txt" | tr -d ' ')"
rm -rf "$FX"
