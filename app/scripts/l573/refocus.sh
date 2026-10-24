#!/bin/sh
# LIFE-573 — 포커스 완충 루프. 0.3초마다 `lsappinfo front` 를 보고, 앞 앱이 격리 Electron(번들 경로 $1)이면
# 직전 앞 앱(pid)으로 되돌린다. 발동마다 $2 에 한 줄. 사용: sh refocus.sh <Electron.app 경로> <로그>
BUNDLE=$1; LOG=$2; PREV=""; N=0
echo "start $(date '+%F %T') bundle=$BUNDLE" | sed "s#$HOME#~#g" >> "$LOG"
while :; do
  ASN=$(lsappinfo front 2>/dev/null)
  INFO=$(lsappinfo info -only bundlepath -only pid "$ASN" 2>/dev/null)
  BP=$(printf '%s' "$INFO" | sed -n 's/.*"LSBundlePath"="\([^"]*\)".*/\1/p' | head -1)
  PID=$(printf '%s' "$INFO" | sed -n 's/.*"pid"=\([0-9]*\).*/\1/p' | head -1)
  if [ "$BP" = "$BUNDLE" ]; then
    N=$((N+1))
    R=$(osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is ${PREV:-0}) to true" 2>&1)
    echo "refocus#$N $(date '+%T') isolated_pid=$PID -> prev=$PREV result=${R:-ok}" >> "$LOG"
  elif [ -n "$PID" ]; then
    PREV=$PID
  fi
  sleep 0.3
done
