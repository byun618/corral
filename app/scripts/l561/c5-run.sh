#!/bin/sh
# LIFE-561 C5 — 구현 worktree 의 개발 실행을 바인딩 없이(CORRAL_BACKEND_SOCKET·CORRAL_SESSION·CORRAL_HERDR_BIN 없음) 1회 띄워 ⓐ~ⓕ·보강 ⑥ 을 본다.
#   rehearse : 격리 리허설(판정 아님) — HOME·XDG_CONFIG_HOME·userData 전부 /tmp/l561-c5r, brew 무접촉. GUI 드라이버 흐름 확인용
#   native   : 01-criteria 「사용자 기계 변경 계획」 그대로 — 실제 HOME·로그인 셸, userData 만 /tmp/l561-native-ud.
#              brew unlink → 양성 대조 → 실행 → 앱 종료 → 이 회차가 띄운 herdr-dev default 서버 멈춤 → 즉시 brew link (EXIT trap 으로도 되돌린다)
# life417-native 에는 명령·조회를 보내지 않는다 — pgrep 으로 PID 만 읽고, 개발 GUI 쪽 lsof 에서 그 이름을 찾는다.
# 판정은 종료코드. 사용: sh scripts/l561/c5-run.sh <rehearse|native> <원자료 폴더>   (app/ 에서, node v24 가 PATH 앞에)
set -u
MODE=$1; OUT=$2
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
REPO=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd -P)
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
mkdir -p "$OUT"
case "$MODE" in
  rehearse) ROOT=/tmp/l561-c5r; RUN_HOME=$ROOT/h; XDG=$ROOT/xdg ;;
  native) ROOT=/tmp/l561-native-ud; RUN_HOME=$HOME; XDG= ;;
  *) echo "사용: c5-run.sh <rehearse|native> <원자료 폴더>"; exit 2 ;;
esac
UD=$ROOT/ud
LOGIN() { env HOME="$RUN_HOME" /bin/zsh -lc "$1" </dev/null 2>/dev/null; }
L417() { pgrep -f -- '--session life417-native server' | tr '\n' ' '; }
echo "mode=$MODE root=$ROOT guard=$GUARD repo=$REPO"
echo "guard_sha=$(shasum -a 256 "$GUARD" | cut -c1-64)"
# 시작 전: 사용자 userData 로 떠 있는 개발 GUI(레포 Electron)가 있으면 멈춘다 — 끄지 않는다
DEV=$(ps -axo pid=,command= | grep -E 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ' | grep -v -- '--type=' | grep -v grep)
echo "dev_gui_before=${DEV:-none}"
[ -z "$DEV" ] || { echo "개발 GUI 가 이미 떠 있다 — 손대지 않고 멈춘다"; exit 3; }
L417_BEFORE=$(L417); echo "life417_native_pids_before=$L417_BEFORE"
HD="${XDG:-$RUN_HOME/.config}/herdr-dev"
echo "herdr_dev_before:"; ls -1 "$HD" "$HD/sessions" 2>&1 | sed "s#$HOME#~#g"
rm -rf "$ROOT"; mkdir -p "$UD" "$ROOT/shots"; chmod 700 "$ROOT" "$UD"
[ "$MODE" = rehearse ] && mkdir -p "$RUN_HOME" "$XDG"
UNLINKED=0
relink() {
  if [ "$UNLINKED" = 1 ]; then
    echo "## brew link herdr"; brew link herdr 2>&1; echo "link_exit=$?"; UNLINKED=0
    echo "after_link_command_v=$(LOGIN 'command -v herdr')"; ls -l /opt/homebrew/bin/herdr 2>&1 | sed "s#$HOME#~#g"
  fi
}
trap relink EXIT INT TERM
if [ "$MODE" = native ]; then
  echo "## brew unlink 전"; BEFORE_CV=$(LOGIN 'command -v herdr'); echo "login_command_v=$BEFORE_CV"; ls -l /opt/homebrew/bin/herdr 2>&1
  check pre_command_v_present "$([ -n "$BEFORE_CV" ] && echo 1)"
  echo "## brew unlink herdr"; UNLINKED=1; brew unlink herdr 2>&1; echo "unlink_exit=$?"
  AFTER_CV=$(LOGIN 'command -v herdr'); echo "login_command_v_after_unlink=${AFTER_CV:-(빈 결과)}"; ls -l /opt/homebrew/bin/herdr 2>&1
  OTHERS=$(ls -l /usr/local/bin/herdr "$HOME/.local/bin/herdr" "$HOME/.cargo/bin/herdr" 2>/dev/null); echo "other_places=${OTHERS:-none}"
  check positive_control_no_herdr "$([ -z "$AFTER_CV" ] && [ ! -e /opt/homebrew/bin/herdr ] && [ -z "$OTHERS" ] && echo 1)"
fi
echo "## 개발 실행 (바인딩 없음, 로그인 셸에서)"
LAUNCH='exec "$L561_EL" "$L561_APP" --user-data-dir="$CORRAL_USER_DATA"'
env -u CORRAL_BACKEND_SOCKET -u CORRAL_SESSION -u CORRAL_HERDR_BIN HOME="$RUN_HOME" ${XDG:+XDG_CONFIG_HOME="$XDG"} \
  CORRAL_USER_DATA="$UD" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots" \
  L561_EL="$EL" L561_APP="$APP" /bin/zsh -lc "$LAUNCH" > "$ROOT/electron.log" 2>&1 </dev/null &
P=$!; echo "app_pid=$P"
i=0; until grep -q '"herdr.resolve"' "$ROOT/corral.ndjson" 2>/dev/null; do i=$((i+1)); [ $i -gt 300 ] && break; sleep 0.2; done
echo "## 앱 env 의 바인딩 (기대 없음)"; ps eww -o command= -p "$P" | tr ' ' '\n' | grep -E '^(CORRAL_BACKEND_SOCKET|CORRAL_SESSION|CORRAL_HERDR_BIN|HOME|CORRAL_USER_DATA)=' | sed "s#$HOME#~#g"
check app_env_unbound "$(ps eww -o command= -p "$P" | tr ' ' '\n' | grep -qE '^(CORRAL_BACKEND_SOCKET|CORRAL_SESSION|CORRAL_HERDR_BIN)=' || echo 1)"
RES=$(grep '"herdr.resolve"' "$ROOT/corral.ndjson" | head -1); echo "ⓐ $RES" | sed "s#$HOME#~#g"
check a_resolve_repo_guard "$(echo "$RES" | grep -q '"source":"repo-guard"' && echo "$RES" | grep -qF "\"path\":\"$GUARD\"" && echo 1)"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
echo "## GUI (ⓒⓓⓔ)"; node scripts/l561/c5-gui.mjs "$ROOT/ctl.sock" "$OUT" "$REPO" > "$ROOT/gui.out" 2>&1; GUI_RC=$?
sed "s#$HOME#~#g" "$ROOT/gui.out"; check gui_driver "$([ $GUI_RC = 0 ] && echo 1)"
echo "## 로그: backend·session"; grep -E '"(backend.status|backend.start[a-z._]*|session.select[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-400 | sed "s#$HOME#~#g"
SPID=$(grep '"backend.start.ready"' "$ROOT/corral.ndjson" | head -1 | sed -E 's/.*"pid":([0-9]+).*/\1/')
echo "## ⓑ·⑥ 서버 프로세스 (pid ${SPID:-?})"; ps -o pid,ppid,command -p "${SPID:-0}" 2>&1 | sed "s#$HOME#~#g"
SCMD=$(ps -o command= -p "${SPID:-0}" 2>/dev/null)
check b_server_executable_is_guard "$([ "$SCMD" = "$GUARD server" ] && echo 1)"
ALLSRV=$(ps -axo pid=,command= | grep -F "$GUARD" | grep -v grep); echo "guard_processes:"; echo "$ALLSRV" | sed "s#$HOME#~#g"
echo "## ⓔ 개발 GUI 프로세스들의 열린 파일에서 life417-native (기대 없음)"
APIDS=$(pgrep -f -- "--user-data-dir=$UD" | tr '\n' ',' | sed 's/,$//'); echo "app_pids=$APIDS"
LS=$(lsof -nP -p "$APIDS" 2>/dev/null); echo "lsof_lines=$(echo "$LS" | wc -l | tr -d ' ')"
echo "lsof_unix_lines=$(echo "$LS" | grep -c ' unix ')"
# 양성 대조: 같은 lsof 가 이 회차의 default 소켓(herdr-dev 최상위 — 리허설에서 sessions/default 가 아니라 최상위였다)을 보는가
echo "$LS" | grep -E ' unix |herdr' | sed "s#$HOME#~#g" > "$OUT/c5e-lsof-gui.txt"
echo "lsof_herdr_dev_lines=$(echo "$LS" | grep -c 'herdr-dev/')"
echo "## 같은 lsof 를 서버 pid 에 (도구가 unix 소켓 경로를 보이는지)"; lsof -nP -p "${SPID:-0}" 2>/dev/null | grep -E ' unix ' | sed "s#$HOME#~#g"
echo "lsof_life417_lines=$(echo "$LS" | grep -c 'life417-native')"
check e_gui_no_life417_socket "$(echo "$LS" | grep -q 'life417-native' || echo 1)"
echo "## 앱 종료"
kill "$P" 2>/dev/null; for p in $(pgrep -f -- "--user-data-dir=$UD"); do kill "$p" 2>/dev/null; done
i=0; while pgrep -f -- "--user-data-dir=$UD" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "--user-data-dir=$UD"; break; }; sleep 0.2; done
wait "$P" 2>/dev/null
echo "## 이 회차가 띄운 herdr-dev default 서버 멈춤 (pid ${SPID:-?})"
if [ -n "$SPID" ] && [ "$(ps -o command= -p "$SPID" 2>/dev/null)" = "$GUARD server" ]; then
  kill -TERM "$SPID"; i=0; while kill -0 "$SPID" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -KILL "$SPID"; break; }; sleep 0.2; done
fi
check f_server_stopped "$([ -n "$SPID" ] && ! kill -0 "$SPID" 2>/dev/null && echo 1)"
relink
if [ "$MODE" = native ]; then
  CV=$(LOGIN 'command -v herdr'); check f_brew_link_restored "$([ "$CV" = /opt/homebrew/bin/herdr ] && [ -L /opt/homebrew/bin/herdr ] && echo 1)"
fi
L417_AFTER=$(L417); echo "life417_native_pids_after=$L417_AFTER"
check e_life417_pid_same "$([ "$L417_BEFORE" = "$L417_AFTER" ] && echo 1)"
echo "herdr_dev_after:"; ls -1 "$HD" "$HD/sessions" 2>&1 | sed "s#$HOME#~#g"
cp "$ROOT/corral.ndjson" "$OUT/c5-corral.ndjson"; sed -i '' "s#$HOME#~#g" "$OUT/c5-corral.ndjson"
sleep 1; LEFT=$(pgrep -fl -- "$ROOT/"; ps -axo pid=,command= | grep -F "$GUARD" | grep -v grep); echo "leftover=${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
echo "fails=$FAILS"
[ "$FAILS" = 0 ]
