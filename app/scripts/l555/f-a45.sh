#!/bin/sh
# LIFE-555 A4·A5 네이티브 — 앱이 꺼진 상태에서 마커가 있는 셸(이 워커 세션 셸)의 PATH corral open.
# 앱 main 실행 파일이 설치본 MacOS 아래 · env 마커 0 · 허용 목록 유지 · 두 번째 open 은 같은 runtimeId handoff · main 1개. 끝에 앱을 끈다.
# 허용 목록 변수는 이 셸에 없어서 **기본값과 같은 값**(~/.codex·~/.grok·~/.claude)으로 싣는다 — 앱 동작은 미설정과 같다.
# 판정기 양성 대조: 제품이 지우지 않는 카나리 L555_CANARY_MARKER 를 함께 싣고, 같은 프로세스 env 에서 카나리까지 세면 0 이 아님을 본다.
. "$(dirname "$0")/f-lib.sh"
OUT=$1
check app_off_at_start "$(inst_mains | grep -c .)" 0
export CODEX_HOME="$HOME/.codex" GROK_HOME="$HOME/.grok" CLAUDE_CONFIG_DIR="$HOME/.claude" L555_CANARY_MARKER=1
echo "## 호출 직전 셸 env 의 마커 이름(양성 대조)"; env | grep -E "$MARKERS" | cut -d= -f1 | sort | tr '\n' ' '; echo
SHELL_MARKERS=$(env | grep -cE "$MARKERS"); echo "shell_marker_count=$SHELL_MARKERS"
control shell_has_markers "$SHELL_MARKERS" 0
echo "command -v corral = $(command -v corral)"
check corral_is_path_shim "$(command -v corral)" "$SHIM_LINK"
corral open --json > /tmp/l555f-a45.open; RC=$?; cut -c1-400 /tmp/l555f-a45.open; echo; check open1_exit0 "$RC" 0
PID=$(json_get 'r.result.runtime.pid' < /tmp/l555f-a45.open); RID=$(json_get 'r.result.runtime.runtimeId' < /tmp/l555f-a45.open)
echo "pid=$PID runtimeId=$RID"
echo "## A4 앱 main 프로세스"; ps -o pid,ppid,lstart,command -p "$PID"
EXE=$(ps -o command= -p "$PID" | sed 's/ --user-data-dir=.*//')
check a4.exe_under_installed "$EXE" "$INST/Contents/MacOS/corral"
control a4.exe_under_installed "$EXE" "$APPDIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
echo "cdhash(실행 중 번들)=$(codesign -dvvv "$INST" 2>&1 | sed -n 's/^CDHash=//p')"
echo "## A5 앱 main 프로세스 env — 마커·허용 목록·카나리"
penv "$PID" | grep -E "$MARKERS|$CANARY|^(CODEX_HOME|GROK_HOME|CLAUDE_CONFIG_DIR|CORRAL_USER_DATA|ELECTRON_RUN_AS_NODE)=" | sort
check a5.app_markers "$(marker_count "$PID")" 0
control a5.app_markers "$(canary_count "$PID")" 0
check a5.keeps_CODEX_HOME "$(penv "$PID" | grep -cx "CODEX_HOME=$HOME/.codex")" 1
check a5.keeps_GROK_HOME "$(penv "$PID" | grep -cx "GROK_HOME=$HOME/.grok")" 1
check a5.keeps_CLAUDE_CONFIG_DIR "$(penv "$PID" | grep -cx "CLAUDE_CONFIG_DIR=$HOME/.claude")" 1
check a5.no_run_as_node "$(penv "$PID" | grep -c '^ELECTRON_RUN_AS_NODE=')" 0
echo "## A4 두 번째 open (handoff)"
corral open --json > /tmp/l555f-a45.open2; RC=$?; cut -c1-300 /tmp/l555f-a45.open2; echo; check open2_exit0 "$RC" 0
check a4.same_runtime "$(json_get 'r.result.runtime.runtimeId' < /tmp/l555f-a45.open2)" "$RID"
check a4.same_pid "$(json_get 'r.result.runtime.pid' < /tmp/l555f-a45.open2)" "$PID"
check a4.single_main "$(inst_mains | grep -c .)" 1
echo "## 끄기 (SIGTERM $PID)"; stop_pid "$PID"; sleep 1
check app_off_at_end "$(inst_mains | grep -c .)" 0
rm -f /tmp/l555f-a45.*
echo "fails=$FAILS"; exit $FAILS
