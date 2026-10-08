#!/bin/sh
# LIFE-565 최종 관문 — OS 수준 ⌘+클릭 1회(cliclick). 사용자의 실제 마우스를 움직이므로 조건이 다 맞을 때만:
#   ① LIFE-566 개발 GUI 없음 ② HID 유휴 ≥ 20초(사용자가 안 쓰는 중) ③ 앞 창 = 이 회차 개발 앱(PID·소유자 확인)
#   ④ 좌표가 그 창 bounds 안. 하나라도 어긋나면 누르지 않고 그 사유로 끝낸다(공백 → 보류).
# 최대 $1 초(기본 100) 동안 ②를 기다린다. app/ 에서: sh scripts/l565/os-click.sh [대기초]
set -u
WAIT=${1:-100}; N="$HOME/.nvm/versions/node/v24.14.1/bin/node"; ROOT=/tmp/l565n
idle() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {printf "%d", $NF/1000000000; exit}'; }
g566() { ps -axo pid=,command= | grep -E 'LIFE-566.*Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep; }
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | head -1)
echo "at=$(date '+%T') app_pid=$APID"
i=0; while :; do
  [ -n "$(g566)" ] && { echo "GUARD 566-gui-present — 누르지 않음"; exit 10; }
  I=$(idle); [ "$I" -ge 20 ] && break
  i=$((i+2)); [ $i -ge "$WAIT" ] && { echo "GUARD idle-not-reached (마지막 유휴 ${I}s, ${WAIT}s 대기) — 누르지 않음"; exit 11; }
  sleep 2
done
echo "idle_ok=$(idle)s 566=none"
# 앞세우기: 제어 채널 show(창 show+focus) — 입력이 아니라 창 조작
"$N" -e "import('./scripts/l565/lib.mjs').then(async l=>console.log('show', JSON.stringify(await l.control({cmd:'window-visibility',action:'show'}))))"
sleep 1
FRONT=$(osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true' 2>&1)
FNAME=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>&1)
echo "front_pid=$FRONT front_name=$FNAME"
[ "$FRONT" = "$APID" ] || { echo "GUARD front-not-dev-app — 누르지 않음"; exit 12; }
# 좌표: 대상 셀의 화면 좌표(창 screenX/Y + 제목줄 높이 + 셀 client 좌표) 와 창 bounds
GEO=$("$N" -e "
import('./scripts/l565/lib.mjs').then(async l=>{
  const t=await l.termRead(); const at=l.locate(t,'l565-os-cliclick'); if(!at){console.log('none');return}
  const g=await l.evalJs('(() => { const s=document.querySelector(\".term-host .xterm-screen\").getBoundingClientRect(); return { sx: window.screenX, sy: window.screenY, ow: window.outerWidth, oh: window.outerHeight, ih: window.innerHeight, iw: window.innerWidth, left: s.left, top: s.top, w: s.width, h: s.height, zoom: window.devicePixelRatio } })()')
  const cw=g.w/t.cols, ch=g.h/t.rows, bar=g.oh-g.ih
  const x=Math.round(g.sx + g.left + (at.col+3+0.5)*cw), y=Math.round(g.sy + bar + g.top + (at.row+0.5)*ch)
  const inside = x>g.sx && x<g.sx+g.ow && y>g.sy+bar && y<g.sy+g.oh
  console.log([x,y,inside?1:0,JSON.stringify(g)].join(' '))
})")
echo "geo=$GEO"
[ "$GEO" = none ] && { echo "GUARD target-not-on-screen — 누르지 않음"; exit 16; }
set -- $GEO; X=$1; Y=$2; IN=$3
[ "$IN" = 1 ] || { echo "GUARD coords-outside-window — 누르지 않음"; exit 13; }
I=$(idle); [ "$I" -ge 20 ] || { echo "GUARD idle-lost-before-click (${I}s) — 누르지 않음"; exit 14; }
FRONT2=$(osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true' 2>&1)
[ "$FRONT2" = "$APID" ] || { echo "GUARD front-changed — 누르지 않음"; exit 15; }
ORIG=$(cliclick p:. 2>&1); echo "pointer_before=$ORIG"
LOGN=$(grep -c '"window.open.' $ROOT/corral.ndjson); HTTPN=$(wc -l < $ROOT/http.ndjson)
echo "## cliclick kd:cmd m:$X,$Y w:300 c:$X,$Y ku:cmd  at=$(date '+%T')"
cliclick -m verbose kd:cmd "m:$X,$Y" w:300 "c:$X,$Y" ku:cmd 2>&1; echo "cliclick_exit=$?"
sleep 3
case "$ORIG" in *,*) cliclick "m:$ORIG" >/dev/null 2>&1; echo "pointer_restored=$ORIG";; esac
echo "main_log_new:"; grep '"window.open.' $ROOT/corral.ndjson | tail -n +$((LOGN+1)) | cut -c1-300
echo "http_new:"; tail -n +$((HTTPN+1)) $ROOT/http.ndjson
