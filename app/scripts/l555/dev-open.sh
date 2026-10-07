#!/bin/sh
# LIFE-555 A4 개발 경로 회귀 + A5 마커(개발 경로) + A9 카드 스크린샷 — 격리 1회.
# 레포 빌드 CLI(`node cli/corral.mjs open`)가 레포 Electron 을 띄우는지, 마커가 앱 env 에 없는지, herdr 미설치 카드에 설치 안내가 보이는지.
# 격리: CORRAL_USER_DATA·XDG_CONFIG_HOME·제어 소켓 모두 <ROOT> 아래, herdr 는 없는 경로(CORRAL_HERDR_BIN) — 사용자 herdr 에 붙지 않는다.
# 사용: sh scripts/l555/dev-open.sh <ROOT> <원자료 디렉터리>   (app/ 에서, node v24 가 PATH 앞에)
set -u
ROOT=$1; OUT=$2
APP=$(pwd -P)
rm -rf "$ROOT"; mkdir -p "$ROOT/xdg" "$ROOT/ud" "$ROOT/shots" "$ROOT/codex"; chmod 700 "$ROOT" "$ROOT/ud"
export CORRAL_USER_DATA="$ROOT/ud" XDG_CONFIG_HOME="$ROOT/xdg" CORRAL_HERDR_BIN="$ROOT/no-herdr" CORRAL_CONTROL_SOCKET="$ROOT/ctl.sock" \
  CORRAL_LOG="$ROOT/corral.ndjson" CORRAL_SHOT_DIR="$ROOT/shots"
# 마커 양성 대조 — 이 셸에 마커와 허용 목록 변수를 싣는다
export CLAUDECODE=1 CLAUDE_PID=4242 CLAUDE_EFFORT=high CLAUDE_CODE_L555_PROBE=1 ORCA_AGENT_HOOK_L555=1 CODEX_HOME="$ROOT/codex"
echo "## 호출 직전 셸 env 의 마커(양성 대조)"; env | grep -E '^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_|ORCA_AGENT_HOOK_|CODEX_HOME)' | sed -E 's/^([A-Z_]*TOKEN)=.*/\1=<redacted>/' | sort
echo "## node"; command -v node; node -v
echo "## corral --version (레포 CLI)"; node cli/corral.mjs --version; echo "exit=$?"
echo "## corral open (레포 CLI)"; node cli/corral.mjs open --json; echo "open_exit=$?"
PID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | while read p; do ps -o ppid= -p "$p" | grep -qx ' *1' && echo "$p"; done | head -1)
[ -n "$PID" ] || PID=$(pgrep -fo -- "--user-data-dir=$ROOT/ud")
echo "app_pid=$PID" | tee "$ROOT/app.pid"
echo "## 앱 main 프로세스 (실행 파일 경로)"; ps -o pid,ppid,command -p "$PID"
echo "## 앱 main 프로세스 env 의 마커 (기대: 마커 0개, CODEX_HOME 남음)"
ps eww -o command= -p "$PID" | tr ' ' '\n' | grep -E '^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_|ORCA_AGENT_HOOK_|CODEX_HOME|CORRAL_USER_DATA|ELECTRON_RUN_AS_NODE)=' | sort
echo "marker_count=$(ps eww -o command= -p "$PID" | tr ' ' '\n' | grep -cE '^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_[A-Z_]*|ORCA_AGENT_HOOK_[A-Z_]*)=')"
echo "## corral status (레포 CLI)"; node cli/corral.mjs status --json; echo "status_exit=$?"
echo "## 두 번째 open (handoff — 새 인스턴스 없음 기대)"; node cli/corral.mjs open --json; echo "open2_exit=$?"
echo "electron_main_count=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | while read p; do ps -o command= -p "$p"; done | grep -vc -- '--type=')"
i=0; until [ -S "$ROOT/ctl.sock" ]; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.2; done
sleep 2
echo "## 카드 스크린샷 (A9)"; node scripts/l485/ctl.mjs "$ROOT/ctl.sock" '{"cmd":"shot","name":"a9-missing-card"}'; echo "shot_exit=$?"
node scripts/l485/ctl.mjs "$ROOT/ctl.sock" '{"cmd":"query","selector":"[data-backend-install]"}'; echo "query_exit=$?"
cp "$ROOT"/shots/*.png "$OUT/" 2>/dev/null
echo "## 종료"; kill "$PID"; i=0; while kill -0 "$PID" 2>/dev/null; do i=$((i+1)); [ $i -gt 50 ] && { kill -9 "$PID"; break; }; sleep 0.2; done
sleep 1; echo "## 잔존 (기대 없음)"; pgrep -fl -- "$ROOT" || echo none
