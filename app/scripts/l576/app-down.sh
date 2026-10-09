#!/bin/sh
# LIFE-576 — 개발 앱만 멈춘다(SIGTERM, 정상 종료 경로). herdr 이름 세션은 남긴다.
set -u
ROOT=/tmp/l576n
stop() { [ -n "$1" ] || return 0; kill -TERM "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 75 ] && { echo "KILL $1"; kill -KILL "$1"; break; }; sleep 0.2; done; }
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); do echo "stop app $p at=$(date '+%T')"; stop "$p"; done
sleep 1
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do echo "stop leftover $p"; stop "$p"; done
rm -f "$ROOT/ctl.sock"
echo "app_left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')"
