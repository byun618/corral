#!/bin/sh
# 격리 앱만 끈다(herdr 는 herdr.sh stop). sh app-down.sh <ROOT>
ROOT=$1; case "$ROOT" in /tmp/l6g/*) ;; *) exit 2 ;; esac
for pid in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do kill "$pid" 2>/dev/null; done
i=0; while pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "--user-data-dir=$ROOT/ud"; break; }; sleep 0.2; done
echo "app down remaining=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | wc -l | tr -d ' ') at=$(date -u +%FT%TZ)" | tee -a "$ROOT/made.txt"
