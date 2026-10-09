#!/bin/sh
# LIFE-576 K6 — OS 수준 끌기 1회(cliclick). 사용자의 실제 마우스를 움직이므로 조건이 다 맞을 때만 (l565/os-click.sh 와 같은 가드):
#   ① HID 유휴 ≥ 20초(사용자가 안 쓰는 중) ② 앞 창 = 이 회차 개발 앱(PID 확인) ③ 좌표가 그 창 bounds 안 ④ 누르기 직전 다시 ①②.
# 하나라도 어긋나면 누르지 않고 그 사유로 끝낸다(공백 → 보류). 권한 변경 없음. app/ 에서: sh scripts/l576/os-drag.sh <원자료 폴더> [대기초]
# 끄는 것: corral 구획 마지막 루트 덩어리(자식 없음) → 맨 위 덩어리 윗변(순서 끌기). 판정 = ui-prefs 순서 첫 자리 + 렌더러 이벤트 계수(os-drag.mjs verify).
set -u
OUT=$1; WAIT=${2:-180}; N="$HOME/.nvm/versions/node/v24.14.1/bin/node"; ROOT=/tmp/l576n
idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {printf "%d", $NF/1000000000; exit}'; }
APID=$(cat "$ROOT/app.pid")
echo "at=$(date '+%T') app_pid=$APID"
i=0; while :; do
  I=$(idle); [ "$I" -ge 20 ] && break
  i=$((i+2)); [ $i -ge "$WAIT" ] && { echo "GUARD idle-not-reached (마지막 유휴 ${I}s, ${WAIT}s 대기) — 누르지 않음"; exit 11; }
  sleep 2
done
echo "idle_ok=$(idle)s"
"$N" -e "import('./scripts/l576/lib.mjs').then(async l=>console.log('show', JSON.stringify(await l.control({cmd:'window-visibility',action:'show'}))))"
sleep 1
FRONT=$(osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true' 2>&1)
FNAME=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>&1)
echo "front_pid=$FRONT front_name=$FNAME"
[ "$FRONT" = "$APID" ] || { echo "GUARD front-not-dev-app — 누르지 않음"; exit 12; }
GEO=$("$N" scripts/l576/os-drag.mjs geo "$OUT")
echo "geo=$GEO"
set -- $GEO; SX=$1; SY=$2; TX=$3; TY=$4; IN=$5
[ "$IN" = 1 ] || { echo "GUARD coords-outside-window — 누르지 않음"; exit 13; }
I=$(idle); [ "$I" -ge 20 ] || { echo "GUARD idle-lost-before-drag (${I}s) — 누르지 않음"; exit 14; }
FRONT2=$(osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true' 2>&1)
[ "$FRONT2" = "$APID" ] || { echo "GUARD front-changed — 누르지 않음"; exit 15; }
ORIG=$(cliclick p:. 2>/dev/null | tail -1); echo "pointer_before=$ORIG"
MY=$(( (SY + TY) / 2 ))
echo "## cliclick m:$SX,$SY dd:$SX,$SY dm:$SX,$((SY-8)) dm:$SX,$MY dm:$TX,$TY du:$TX,$TY  at=$(date '+%T')"
cliclick -m verbose -w 120 "m:$SX,$SY" "dd:$SX,$SY" "dm:$SX,$((SY-8))" "dm:$SX,$((SY-20))" "dm:$SX,$MY" "dm:$TX,$((TY+10))" "dm:$TX,$TY" w:400 "du:$TX,$TY" 2>&1; echo "cliclick_exit=$?"
sleep 3
case "$ORIG" in *,*) cliclick "m:$ORIG" >/dev/null 2>&1; echo "pointer_restored=$ORIG";; esac
"$N" scripts/l576/os-drag.mjs verify "$OUT"; echo "verify_exit=$?"
