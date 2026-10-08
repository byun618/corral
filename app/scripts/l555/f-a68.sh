#!/bin/sh
# LIFE-555 A6(U8 Finder 기동) + A8(U5 알림 1회) — 한 번의 LaunchServices 기동.
# 기동: `env -i HOME USER LOGNAME LANG /usr/bin/open --env CORRAL_CONTROL_SOCKET=… --env CORRAL_SHOT_DIR=… /Applications/corral.app`.
#   `env -i` 인 이유(f09 실측): 셸에서 부른 `open` 은 **부른 셸의 env(PATH·세션 마커)를 앱에 물린다** — Finder(launchd env)와 다르다.
#   env 를 비우고 부르면 앱 env 는 launchd 의 것 + 아래 두 변수다(원자료의 앱 PATH 로 확인).
#   LaunchServices 경로(launchd 가 부모, launchd PATH) 그대로이고 env 두 개만 더한다 — 제어 소켓이 있으면 진단·계측(렌더러 콘솔·term probe)이
#   켜진다(G5). 기동 경로·PATH·herdr 해소는 바뀌지 않는다. 사용자 userData(--user-data-dir 없음 → Electron 기본 = ~/Library/Application Support/corral).
# 앱은 끄지 않고 둔다 — 이어서 A7 확인(f-a7.sh)이 같은 실행에서 userData 사용을 보고 끈다.
. "$(dirname "$0")/f-lib.sh"
OUT=$1; ROOT=/tmp/l555f-ls
rm -rf "$ROOT"; mkdir -p "$ROOT/shots"; chmod 700 "$ROOT"
check app_off_at_start "$(inst_mains | grep -c .)" 0
TABS0=$(herdr_tabs); echo "herdr_default_tabs_before=$TABS0"
WS0=$("$HERDR" workspace list 2>/dev/null | json_get 'r.result.workspaces.length'); echo "herdr_default_workspaces_before=$WS0"
NCP0=$(plutil -p "$HOME/Library/Preferences/com.apple.ncprefs.plist" 2>/dev/null | grep -c 'io.github.byun618.corral'); echo "ncprefs_corral_entries_before=$NCP0"
OFF=$(wc -c < "$UD/corral.ndjson" | tr -d ' '); echo "log_offset=$OFF"
T0=$(date '+%Y-%m-%d %H:%M:%S')
env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" LANG=en_US.UTF-8 /usr/bin/open --env "CORRAL_CONTROL_SOCKET=$ROOT/ctl.sock" --env "CORRAL_SHOT_DIR=$ROOT/shots" "$INST"; RC=$?; check ls_open_exit0 "$RC" 0
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 200 ] && break; sleep 0.2; done
check control_socket_up "$([ -S "$ROOT/ctl.sock" ] && echo yes)" yes
# 첫 실행 승인 화면이 막았다면 앱이 제어 소켓까지 오지 못한다 — 사람 개입 없이 소켓이 섰으면 승인 화면 0회
echo "first_run_approval_prompts=$([ -S "$ROOT/ctl.sock" ] && echo 0 || echo unknown) (quarantine xattr $(xattr -l "$INST" | grep -c quarantine)개)"
PID=$(inst_mains | head -1); echo "app pid=$PID"; ps -o pid,ppid,lstart,command -p "$PID"
check a6.parent_launchd "$(ps -o ppid= -p "$PID" | tr -d ' ')" 1
check a6.exe "$(ps -o command= -p "$PID" | cut -d" " -f1)" "$INST/Contents/MacOS/corral"
echo "## 앱 env (LaunchServices) — PATH·마커·제어 소켓"; penv "$PID" | grep -E "^(PATH|CORRAL_[A-Z_]*)=|$MARKERS" | redact | sort
check a6.launchd_path "$(penv "$PID" | sed -n 's/^PATH=//p')" "/usr/bin:/bin:/usr/sbin:/sbin"
check a6.no_markers "$(marker_count "$PID")" 0
echo "## ⓐ herdr.resolve (사용자 userData 로그 $UD/corral.ndjson, offset $OFF 이후)"
i=0; until tail -c +$((OFF+1)) "$UD/corral.ndjson" | grep -q '"tag":"herdr.resolve"'; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.2; done
tail -c +$((OFF+1)) "$UD/corral.ndjson" | grep -E '"tag":"(herdr\.resolve|backend\.status|sessions\.poll)"' | head -5 | cut -c1-300
RES=$(tail -c +$((OFF+1)) "$UD/corral.ndjson" | grep -m1 '"tag":"herdr.resolve"' | json_get 'r.found+" "+r.path')
check a6a.herdr_resolved "$RES" "true /opt/homebrew/bin/herdr"
control a6a.herdr_resolved "$RES" "false null"
echo "## ⓑⓒ 화면 (f-a6.mjs)"
"$N" "$L555/f-a6.mjs" "$ROOT/ctl.sock" "$OUT"; RC=$?; check a6bc.driver_exit0 "$RC" 0
sleep 1; TABS1=$(herdr_tabs); echo "herdr_default_tabs_after=$TABS1"
check a6c.tab_count_restored "$TABS1" "$TABS0"
WS1=$("$HERDR" workspace list 2>/dev/null | json_get 'r.result.workspaces.length'); echo "herdr_default_workspaces_after=$WS1"
check a6c.workspace_count_restored "$WS1" "$WS0"
if [ "${SKIP_A8:-0}" = 1 ]; then echo "## A8 건너뜀 — 알림은 1회만(f09 에서 이미 실측)"; else
echo "## A8 알림 1회 (같은 실행 — LaunchServices 기동 + 측정 소켓 env)"
A8T0=$(date '+%Y-%m-%d %H:%M:%S')
"$N" "$APPDIR/scripts/l485/ctl.mjs" "$ROOT/ctl.sock" '{"cmd":"notify","title":"corral","body":"LIFE-555 A8 알림 실측","timeoutMs":8000}' > "$OUT/a8-notify-result.json"; RC=$?
cat "$OUT/a8-notify-result.json"; check a8.notify_call_exit0 "$RC" 0
sleep 1; screencapture -x "$ROOT/full.png"; W=$(sips -g pixelWidth "$ROOT/full.png" | awk '/pixelWidth/{print $2}')
# 알림 배너 자리(화면 오른쪽 위)만 잘라 커밋한다 — 전체 화면은 /tmp 에서 지운다
sips -c 360 1000 --cropOffset 0 $((W-1000)) "$ROOT/full.png" --out "$ROOT/area.png" > /dev/null; rm -f "$ROOT/full.png"
# 배너만(바탕화면 항목이 찍히지 않게) — f09 는 이 줄 없이 돌았고 커밋 전 같은 값으로 손으로 잘랐다
sips -c 90 350 --cropOffset 42 638 "$ROOT/area.png" --out "$OUT/a8-banner.png" > /dev/null; rm -f "$ROOT/area.png"
sleep 2; A8T1=$(date '+%Y-%m-%d %H:%M:%S')
echo "## A8 OS 로그 ($A8T0 ~ $A8T1, corral·bundle id 관련 행만)"
log show --start "$A8T0" --end "$A8T1" --style compact --predicate 'subsystem == "com.apple.UserNotifications" OR process == "usernoted" OR process == "NotificationCenter" OR process == "corral"' 2>&1 \
  | grep -iE 'corral|byun618' | cut -c1-400 > "$OUT/a8-oslog.txt"
echo "oslog_lines=$(grep -c . "$OUT/a8-oslog.txt")"; head -40 "$OUT/a8-oslog.txt"
check a8.raw_present "$([ -s "$OUT/a8-notify-result.json" ] && echo yes)" yes
NCP1=$(plutil -p "$HOME/Library/Preferences/com.apple.ncprefs.plist" 2>/dev/null | grep -c 'io.github.byun618.corral'); echo "ncprefs_corral_entries_after=$NCP1 (기록만 — 지우지 않는다)"
fi
echo "app_pid=$PID" > "$ROOT/app.pid"
echo "fails=$FAILS"; exit $FAILS
