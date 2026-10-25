#!/bin/sh
# LIFE-675 g1 포커스 완충 — 0.3초마다 앞 앱을 본다. 앞 앱이 격리 앱(--user-data-dir=<ROOT>/ud 의 주 프로세스)이면
# 그 직전 앞 앱(번들 경로)으로 되돌리고 로그에 한 줄. 끝내기: <ROOT>/refocus.stop 파일을 만든다.
# 사용: sh scripts/l675/refocus.sh <ROOT=/tmp/l675q-*> <로그>
set -u
ROOT=$1; LOG=$2
case "$ROOT" in /tmp/l675q-*) ;; *) echo "ROOT 는 /tmp/l675q-*"; exit 2 ;; esac
last=""; n=0
echo "# refocus start $(date '+%FT%T') root=$ROOT" >> "$LOG"
while [ ! -f "$ROOT/refocus.stop" ]; do
  asn=$(lsappinfo front 2>/dev/null)
  pid=$(lsappinfo info -only pid "$asn" 2>/dev/null | sed 's/.*=//')
  iso=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | tr '\n' ' ')
  case " $iso " in
    *" $pid "*)
      if [ -n "$pid" ]; then
        n=$((n+1))
        echo "$(date '+%FT%T') front=isolated pid=$pid -> back to ${last:-(모름)} (#$n)" >> "$LOG"
        [ -n "$last" ] && open -a "$last"
      fi ;;
    *)
      bp=$(lsappinfo info -only bundlepath "$asn" 2>/dev/null | sed 's/.*="//; s/"$//')
      [ -n "$bp" ] && last=$bp ;;
  esac
  sleep 0.3
done
echo "# refocus stop $(date '+%FT%T') root=$ROOT refocused=$n last_front=$last" >> "$LOG"
