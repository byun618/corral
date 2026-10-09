#!/bin/sh
# LIFE-571 (LIFE-566 에서 복사) — dev-up.sh 가 띄운 앱·herdr l571 세션을 끄고 잔존을 본다. 사용: sh scripts/l571/dev-down.sh <ROOT>
set -u
ROOT=$1
case "$ROOT" in /tmp/l571-*) ;; *) echo "ROOT 는 /tmp/l571-*"; exit 2 ;; esac
# 칸 = 지금 source.json 패치 digest 앞 16자(build-dev-guard.mjs 와 같은 규칙) — 패치 guard(LIFE-571 shift-enter 포함)를 쓴다.
KEY=${L571_GUARD_KEY:-$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')}
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
stop() { kill "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 75 ] && { kill -9 "$1"; break; }; sleep 0.2; done; }
A=$(cat "$ROOT/app.pid"); B=$(cat "$ROOT/backend.pid")
ps -o command= -p "$A" 2>/dev/null | grep -qF -- "--user-data-dir=$ROOT/ud" && stop "$A"
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do stop "$p"; done
ps -o command= -p "$B" 2>/dev/null | grep -qF -- "--session l571 server" && stop "$B"
sleep 0.5
echo "잔존:"; ps -Ao pid=,ppid=,etime=,command= | grep -E -- "$ROOT|--session l571 " | grep -v -e grep -e dev-down || echo "없음"
"$GUARD" session list 2>&1 | grep -E '^l571' || echo "herdr l571 세션 목록 없음"
# 이 작업이 만든 herdr 세션 폴더만 지운다(다른 세션 폴더는 무접촉) — 세션이 멈췄을 때만
if ! "$GUARD" session list 2>/dev/null | awk '$1=="l571"{print $2}' | grep -q running; then rm -rf "$HOME/.config/herdr-dev/sessions/l571" && echo "herdr-dev/sessions/l571 제거"; fi
