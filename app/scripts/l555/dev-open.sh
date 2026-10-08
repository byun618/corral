#!/bin/sh
# LIFE-555 A4 개발 경로 회귀 + A5 마커(개발 경로) + A9 카드 스크린샷 — 격리 1회.
# 레포 빌드 CLI(`node cli/corral.mjs open`)가 레포 Electron 을 띄우는지, 마커가 앱 env 에 없는지, 두 번째 open 이 handoff 인지,
# herdr 미설치 카드에 설치 안내가 보이는지.
# 격리: CORRAL_USER_DATA·XDG_CONFIG_HOME·제어 소켓 모두 <ROOT> 아래, herdr 는 없는 경로(CORRAL_HERDR_BIN) — 사용자 herdr 에 붙지 않는다.
#
# **판정은 종료코드다**(fix1 L3) — 아래 CHECK 가 하나라도 실패하면 exit 1. 출력의 `CHECK <이름> pass|fail` 줄이 어느 조건인지 보인다.
# 양성 대조: 세 번째 인자 `control` 이면 제품이 지우지 않는 카나리 `L555_CANARY_MARKER` 를 셸에 싣고 그것도 마커로 센다 —
# 검사기가 앱 env 를 실제로 읽어 마커 잔존을 실패로 판정하는지 보이는 회차다(기대 exit 1).
# 사용: sh scripts/l555/dev-open.sh <ROOT> <원자료 디렉터리> [control]   (app/ 에서, node v24 가 PATH 앞에)
set -u
ROOT=$1; OUT=$2; MODE=${3:-normal}
APP=$(pwd -P)
FAILS=0
check() { if [ "$2" = 1 ]; then echo "CHECK $1 pass"; else echo "CHECK $1 fail"; FAILS=$((FAILS+1)); fi; }
MARKERS='^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_[A-Za-z0-9_]*|ORCA_AGENT_HOOK_[A-Za-z0-9_]*)='
rm -rf "$ROOT"; mkdir -p "$ROOT/xdg" "$ROOT/ud" "$ROOT/shots" "$ROOT/codex"; chmod 700 "$ROOT" "$ROOT/ud"
export CORRAL_USER_DATA="$ROOT/ud" XDG_CONFIG_HOME="$ROOT/xdg" CORRAL_HERDR_BIN="$ROOT/no-herdr" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" \
  CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots"
# 마커 양성 대조 — 이 셸에 마커와 허용 목록 변수를 싣는다
export CLAUDECODE=1 CLAUDE_PID=4242 CLAUDE_EFFORT=high CLAUDE_CODE_L555_PROBE=1 ORCA_AGENT_HOOK_L555=1 CODEX_HOME="$ROOT/codex"
if [ "$MODE" = control ]; then export L555_CANARY_MARKER=1; MARKERS='^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_[A-Za-z0-9_]*|ORCA_AGENT_HOOK_[A-Za-z0-9_]*|L555_CANARY_MARKER)='; fi
echo "mode=$MODE"
echo "## 호출 직전 셸 env 의 마커(양성 대조)"; env | grep -E "$MARKERS|^CODEX_HOME=" | sed -E 's/^([A-Z_]*TOKEN)=.*/\1=<redacted>/' | sort
check shell_has_markers "$([ "$(env | grep -cE "$MARKERS")" -gt 0 ] && echo 1)"
echo "## node"; command -v node; node -v
echo "## corral --version (레포 CLI)"; node cli/corral.mjs --version; check version_exit0 "$([ $? = 0 ] && echo 1)"
echo "## corral open (레포 CLI)"; node cli/corral.mjs open --json > "$ROOT/open1.json"; RC=$?; cut -c1-400 "$ROOT/open1.json"; check open_exit0 "$([ $RC = 0 ] && echo 1)"
PID=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.result?.runtime?.pid??"")' "$ROOT/open1.json" 2>/dev/null)
RID=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.result?.runtime?.runtimeId??"")' "$ROOT/open1.json" 2>/dev/null)
echo "app_pid=$PID runtimeId=$RID" | tee "$ROOT/app.pid"
if [ -n "$PID" ]; then
  echo "## 앱 main 프로세스 (실행 파일 경로)"; CMD=$(ps -o command= -p "$PID"); ps -o pid,ppid,command -p "$PID"
  case "$CMD" in "$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron $APP "*) check repo_electron 1 ;; *) check repo_electron 0 ;; esac
  echo "## 앱 main 프로세스 env 의 마커·허용 목록 (기대: 마커 0개, CODEX_HOME 남음)"
  ENVS=$(ps eww -o command= -p "$PID" | tr ' ' '\n')
  echo "$ENVS" | grep -E "$MARKERS|^(CODEX_HOME|CORRAL_USER_DATA|ELECTRON_RUN_AS_NODE)=" | sed -E 's/^([A-Z_]*TOKEN)=.*/\1=<redacted>/' | sort
  COUNT=$(echo "$ENVS" | grep -cE "$MARKERS"); echo "marker_count=$COUNT"
  check app_env_no_markers "$([ "$COUNT" = 0 ] && echo 1)"
  check app_env_keeps_codex_home "$(echo "$ENVS" | grep -qx "CODEX_HOME=$ROOT/codex" && echo 1)"
else
  check app_pid_known 0
fi
# 종료코드는 명령에서 직접 받는다 — 파이프 끝 `$?` 는 `cut` 의 것이다(r2 L-r2-1)
echo "## corral status (레포 CLI)"; node cli/corral.mjs status --json > "$ROOT/status.json"; RC=$?; cut -c1-300 "$ROOT/status.json"; check status_exit0 "$([ $RC = 0 ] && echo 1)"
echo "## 두 번째 open (handoff — 같은 runtimeId·새 인스턴스 없음 기대)"; node cli/corral.mjs open --json > "$ROOT/open2.json"; RC=$?; cut -c1-300 "$ROOT/open2.json"
RID2=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.result?.runtime?.runtimeId??"")' "$ROOT/open2.json" 2>/dev/null)
check open2_exit0 "$([ $RC = 0 ] && echo 1)"
check open2_same_runtime "$([ -n "$RID" ] && [ "$RID" = "$RID2" ] && echo 1)"
MAINS=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | while read p; do ps -o command= -p "$p"; done | grep -vc -- '--type='); echo "electron_main_count=$MAINS"
check single_instance "$([ "$MAINS" = 1 ] && echo 1)"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.2; done
sleep 2
echo "## 카드 스크린샷 (A9)"; node scripts/l485/ctl.mjs "$ROOT/ctl.sock" '{"cmd":"shot","name":"a9-missing-card"}'
Q=$(node scripts/l485/ctl.mjs "$ROOT/ctl.sock" '{"cmd":"query","selector":"[data-backend-install]"}'); echo "$Q"
check install_hint "$(echo "$Q" | grep -q 'brew install herdr' && echo 1)"
cp "$ROOT"/shots/*.png "$OUT/" 2>/dev/null
echo "## 종료"
for p in $(pgrep -f -- "--user-data-dir=$ROOT/ud"); do ps -o ppid= -p "$p" | grep -qx ' *1' && kill "$p"; done
i=0; while pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { pkill -9 -f -- "--user-data-dir=$ROOT/ud"; break; }; sleep 0.2; done
sleep 1; echo "## 잔존 (기대 없음)"; LEFT=$(pgrep -fl -- "$ROOT"); echo "${LEFT:-none}"
check no_leftover "$([ -z "$LEFT" ] && echo 1)"
echo "fails=$FAILS"
[ "$FAILS" = 0 ]
