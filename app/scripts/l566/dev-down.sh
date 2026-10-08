#!/bin/sh
# LIFE-566 — dev-up.sh 가 띄운 앱·herdr l566 세션을 끄고 잔존을 본다. 사용: sh scripts/l566/dev-down.sh <ROOT>
set -u
ROOT=$1
case "$ROOT" in /tmp/l566n-*) ;; *) echo "ROOT 는 /tmp/l566n-*"; exit 2 ;; esac
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
stop() { kill "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 75 ] && { kill -9 "$1"; break; }; sleep 0.2; done; }
A=$(cat "$ROOT/app.pid"); B=$(cat "$ROOT/backend.pid")
ps -o command= -p "$A" 2>/dev/null | grep -qF -- "--user-data-dir=$ROOT/ud" && stop "$A"
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do stop "$p"; done
ps -o command= -p "$B" 2>/dev/null | grep -qF -- "--session l566 server" && stop "$B"
sleep 0.5
echo "잔존:"; ps -Ao pid=,ppid=,etime=,command= | grep -E -- "$ROOT|--session l566 " | grep -v grep || echo "없음"
"$GUARD" session list 2>&1 | grep -E '^l566' || echo "herdr l566 세션 목록 없음"
# 이 작업이 만든 herdr 세션 폴더만 지운다(다른 세션 폴더는 무접촉) — 세션이 멈췄을 때만
if ! "$GUARD" session list 2>/dev/null | awk '$1=="l566"{print $2}' | grep -q running; then rm -rf "$HOME/.config/herdr-dev/sessions/l566" && echo "herdr-dev/sessions/l566 제거"; fi
