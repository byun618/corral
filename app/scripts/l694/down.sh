#!/bin/sh
# LIFE-694 최종 관문 — up.sh 가 띄운 앱·herdr 를 끄고 고아까지 확인한다. sh scripts/l694/down.sh <ROOT=/tmp/l694g-*>
set -u
ROOT=$1; case "$ROOT" in /tmp/l694g-*) ;; *) echo "ROOT 는 /tmp/l694g-*"; exit 2 ;; esac
for pid in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do kill "$pid" 2>/dev/null; done
i=0; while pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "--user-data-dir=$ROOT/ud"; break; }; sleep 0.2; done
BIN=$(cat "$ROOT/herdr.bin" 2>/dev/null); S=$(cat "$ROOT/herdr.session" 2>/dev/null); P=$(cat "$ROOT/herdr.pid" 2>/dev/null)
[ -n "$BIN" ] && [ -n "$S" ] && sh "$(dirname "$0")/../l470/clean.sh" -- "'$BIN' --session $S server stop" </dev/null >/dev/null 2>&1
i=0; while [ -n "$P" ] && kill -0 "$P" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill "$P"; sleep 1; break; }; sleep 0.2; done
echo "down app_left=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | wc -l | tr -d ' ') herdr_alive=$([ -n "$P" ] && kill -0 "$P" 2>/dev/null && echo 1 || echo 0) session_procs=$(pgrep -f -- "--session $S" | wc -l | tr -d ' ') orphans_ppid1=$(ps -axo ppid=,command= | awk '$1==1' | grep -c -- "$ROOT\|$S") at=$(date -u +%FT%TZ)" | tee -a "$ROOT/made.txt"
# 이름 세션 폴더(이 관문이 만든 `l694g-*` 하나)를 지운다 — herdr 는 세션을 영속해 다음 기동에 workspace 를 되살린다(g03 에서 확인).
case "$S" in l694g-*) D="$HOME/.config/herdr-dev/sessions/$S"; [ -d "$D" ] && rm -rf "$D"; echo "session_dir_removed=$S exists_after=$([ -e "$D" ] && echo 1 || echo 0)" | tee -a "$ROOT/made.txt" ;; esac
