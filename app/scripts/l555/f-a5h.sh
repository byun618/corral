#!/bin/sh
# LIFE-555 A5 herdr 다리 — 설치본이 herdr 서버를 띄울 때 넘기는 env 에 마커가 없다. 격리 herdr 루트 1회.
# 격리: XDG_CONFIG_HOME=<ROOT>/xdg(herdr 세션 디렉터리) · CORRAL_USER_DATA=<ROOT>/ud · 제어 소켓 <ROOT>/ctl.sock. 빈 루트라 재개 0 → 앱이 자동 기동한다.
# 띄운 격리 서버는 반드시 멈춘다(XDG 격리 `herdr server stop`). 사용자 default 서버는 건드리지 않는다(전후 pid 대조).
# 판정기 양성 대조: 카나리 L555_CANARY_MARKER 를 싣고 서버 env 에서 카나리까지 세면 0 이 아님을 본다.
. "$(dirname "$0")/f-lib.sh"
OUT=$1; ROOT=/tmp/l555f-h
CTL() { "$N" "$APPDIR/scripts/l485/ctl.mjs" "$ROOT/ctl.sock" "$1"; }
dservers() { ps -Ao pid=,command= | grep -E '^ *[0-9]+ /opt/homebrew/bin/[h]erdr( --session default)? server$' | awk '{print $1}'; }
rm -rf "$ROOT"; mkdir -p "$ROOT/xdg/herdr" "$ROOT/ud" "$ROOT/shots"; chmod 700 "$ROOT" "$ROOT/ud"
BEFORE=$(dservers | sort | tr '\n' ' '); echo "herdr server pids before: $BEFORE"
export XDG_CONFIG_HOME="$ROOT/xdg" CORRAL_USER_DATA="$ROOT/ud" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_SHOT_DIR="$ROOT/shots" CORRAL_LOG="$ROOT/corral.ndjson"
export CODEX_HOME="$HOME/.codex" L555_CANARY_MARKER=1
echo "shell_marker_count=$(env | grep -cE "$MARKERS")"
echo "## 격리 session list"; "$HERDR" session list --json | json_get 'JSON.stringify(r.sessions.filter(s=>s.default))'
corral open --json > "$ROOT/open.json"; RC=$?; check open_exit0 "$RC" 0
APP=$(json_get 'r.result.runtime.pid' < "$ROOT/open.json"); echo "app pid=$APP"; ps -o pid,ppid,command -p "$APP"
check app_exe "$(ps -o command= -p "$APP" | sed 's/ --user-data-dir=.*//')" "$INST/Contents/MacOS/corral"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
# 격리 서버 = XDG_CONFIG_HOME 이 이 ROOT 인 herdr server
iso_server() { for p in $(ps -Ao pid=,command= | grep -E '/opt/homebrew/bin/[h]erdr.* server$' | awk '{print $1}'); do penv "$p" | grep -qx "XDG_CONFIG_HOME=$ROOT/xdg" && echo "$p"; done; }
i=0; S=""; while [ -z "$S" ]; do S=$(iso_server | head -1); i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
echo "## 백엔드 상태"; CTL '{"cmd":"state"}' | json_get 'JSON.stringify(r.state.backend)'
grep -E '"tag":"(herdr\.resolve|herdr\.server\.spawn|backend\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-260
echo "isolated herdr server pid=$S"; check iso_server_found "$([ -n "$S" ] && echo yes)" yes
if [ -n "$S" ]; then
  ps -o pid,ppid,command -p "$S"
  echo "## 격리 herdr 서버 env — 마커·카나리·허용 목록"; penv "$S" | grep -E "$MARKERS|$CANARY|^(CODEX_HOME|XDG_CONFIG_HOME|CORRAL_[A-Z_]*|ELECTRON_[A-Z_]*)=" | sort
  check herdr.server_markers "$(marker_count "$S")" 0
  control herdr.server_markers "$(canary_count "$S")" 0
  check herdr.keeps_CODEX_HOME "$(penv "$S" | grep -cx "CODEX_HOME=$HOME/.codex")" 1
  check herdr.no_corral_vars "$(penv "$S" | grep -cE '^(CORRAL_|ELECTRON_)')" 0
fi
echo "## 격리 서버 멈춤 (XDG 격리 herdr server stop)"; "$HERDR" server stop; echo "stop_exit=$?"
i=0; while [ -n "$S" ] && kill -0 "$S" 2>/dev/null; do i=$((i+1)); [ $i -gt 100 ] && { kill "$S"; break; }; sleep 0.2; done
check iso_server_gone "$([ -n "$S" ] && kill -0 "$S" 2>/dev/null && echo alive || echo gone)" gone
echo "## 앱 끄기"; stop_pid "$APP"; sleep 1
LEFT=$(pgrep -fl -- "$ROOT"); echo "leftover: ${LEFT:-none}"; check no_leftover "${LEFT:-none}" none
AFTER=$(dservers | sort | tr '\n' ' '); echo "herdr server pids after: $AFTER"
check default_server_untouched "$AFTER" "$BEFORE"
unset XDG_CONFIG_HOME
rm -rf "$ROOT"
echo "fails=$FAILS"; exit $FAILS
