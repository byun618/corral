#!/bin/sh
# LIFE-604 R1-G ① — 격리 프로필 기동(l603/up.sh 를 옮김, ROOT = /tmp/l604g-*). 모의 출처(CORRAL_WORK_MOCK=1) · 가짜 LA 주소 · 로그·ui-prefs·연결 파일 모두 ROOT 아래.
#   app/ 에서: sh scripts/l604/up.sh <ROOT=/tmp/l604g-*> [KEY=VALUE ...]   (CDP: L604_EXTRA_ARGS=--remote-debugging-port=<PORT>)
# - userData = <ROOT>/ud(런타임 소켓 = <ROOT>/ud/runtime/rpc.sock — transport.ts 기본값이 userData 아래) · 제어 소켓 = <ROOT>/ctl/ctl.sock
# - herdr = 레포 guard 바이너리의 이름 세션 `l604g-<ROOT 꼬리>`. 설치본 corral · 그 userData · 사용자 herdr 세션 · 기본 소켓 무접촉.
# - 만든 경로·PID 는 <ROOT>/made.txt 에 한 줄씩(down.sh 와 회차 기록이 읽는다).
# - L604_HERDR_ENV="K=V ..." 는 격리 herdr 서버(→ pane 셸) env 에 더한다(최종 관문: DISABLE_AUTO_UPDATE=true — omz 업데이트 질문이 에이전트 명령 첫 글자를 먹는다).
# - L604_DRY=1 이면 아무것도 띄우지 않고 쓸 환경만 찍고 끝난다(자기점검용).
# - **창 모드는 손 넘김 뒤에만(R2-B)**: 지금 제품에는 창을 비활성으로 띄우는 길이 없다(main `ready-to-show → show()` — 바꾸지 않는다). 첫 실행에서
#   포커스를 뺏고 나서 막는 것은 늦다 — 그래서 **띄우기 전에** `L604_HANDOFF=<코디가 준 『질의응답』 답 id>` 가 없으면 herdr 도 띄우지 않고 exit 9.
#   창 없는 회차(C9·C5·C10)는 `windowless.test.tsx`(vitest) 몫이고, 런타임만 필요하면 `L604_SERVE=1`(창 없음 — 손 넘김 불필요).
# - **포커스 증거(R1-G)**: 창 모드는 띄우기 전·뒤의 맨 앞 앱을 `lsappinfo front` 로 <ROOT>/focus.txt 에 적는다(OS 입력 없음 — 읽기만).
#   띄우기 전 맨 앞 앱을 못 읽으면(빈 값) 비교가 무의미하다 — 띄우지 않고 exit 2. 관찰 창 = 제어 소켓 뒤 최대 30초(창 show 까지 넉넉히),
#   바뀌면 그 시각을 적고 멈춘다. 손 넘김 id 와 stolen 여부는 focus.txt 에 남는다(뺏김은 손 넘김 아래라 실패가 아니다 — 증거다).
# 실패 전파: 가드 위반 exit 2·5 · 이미 떠 있음 3 · env 누수 4 · 소켓 안 뜸 1 · 손 넘김 없음 9. 성공만 마지막 줄 「up ok」.
set -u
ROOT=${1:-}; [ $# -gt 0 ] && shift
case "$ROOT" in /tmp/l604g-*) ;; *) echo "ROOT 는 /tmp/l604g-*"; exit 2 ;; esac
case "$ROOT" in *..*|*' '*) echo "ROOT 에 .. · 공백 금지"; exit 2 ;; esac
INSTALLED_UD="$HOME/Library/Application Support/corral"
case "$ROOT/ud" in "$INSTALLED_UD"*) echo "✘ 격리 userData 가 설치본 아래"; exit 5;; esac
SESSION="l604g-$(basename "$ROOT" | sed 's/^l604g-//')"
case "$SESSION" in default|corral|'') echo "✘ herdr 세션 이름이 기본값"; exit 5;; esac
SOCK="$HOME/.config/herdr-dev/sessions/$SESSION/herdr.sock"
ENVS="CORRAL_SESSION=$SESSION CORRAL_BACKEND_SOCKET=$SOCK CORRAL_USER_DATA=$ROOT/ud CORRAL_CONTROL_SOCKET=$ROOT/ctl/ctl.sock CORRAL_SHOT_DIR=$ROOT/shots CORRAL_LA_MCP_URL=http://127.0.0.1:9/mcp CORRAL_WORK_MOCK=1 CORRAL_WORK_TEST_CIPHER=1 CORRAL_WORK_IPC_TRACE=$ROOT/ipc-trace.ndjson CORRAL_SETTINGS=$ROOT/ud/settings.json CORRAL_LOG=$ROOT/ud/corral.ndjson CORRAL_WORK_CONNECTIONS=$ROOT/ud/work-connections.json CORRAL_WORK_ACTIVITY=$ROOT/ud/work-activity.json CORRAL_WORK_START_PENDING=$ROOT/ud/work-start-pending.json CORRAL_UI_PREFS=$ROOT/ud/ui-prefs.json CORRAL_REGISTRY=$ROOT/ud/repos.json"
if [ "${L604_DRY:-}" = 1 ]; then echo "$ENVS" | tr ' ' '\n'; echo "dry ok"; exit 0; fi
if [ "${L604_SERVE:-}" != 1 ] && [ -z "${L604_HANDOFF:-}" ]; then
  echo "handoff_required — 창 모드는 『질의응답』 손 넘김 답 id(L604_HANDOFF=<id>) 뒤에만 띄운다. 창 없는 회차는 windowless.test.tsx · 런타임만은 L604_SERVE=1"; exit 9
fi
# 앱을 못 읽으면 빈 글 — 그때 비교는 늘 「바뀜」 이거나 늘 「같음」 이라 증거가 아니다.
front() { A=$(lsappinfo front 2>/dev/null); [ -n "$A" ] || return 0; echo "$A pid=$(lsappinfo info -only pid "$A" 2>/dev/null | sed 's/.*=//') $(lsappinfo info -only name "$A" 2>/dev/null | sed 's/.*=//')"; }
# 창 모드는 herdr 를 띄우기 전에도 한 번 본다 — 못 읽는 환경이면 아무것도 띄우지 않고 끝난다.
if [ "${L604_SERVE:-}" != 1 ] && [ -z "$(front)" ]; then echo "✘ 맨 앞 앱을 못 읽는다(lsappinfo) — 포커스 증거 없음, 띄우지 않는다"; exit 2; fi
APP=$(pwd -P); EL="$APP/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
KEY=$(node -e 'const fs=require("fs"),c=require("crypto");const s=JSON.parse(fs.readFileSync("backend/source.json"));console.log(c.createHash("sha256").update(Buffer.concat(s.patches.map(n=>fs.readFileSync("backend/"+n)))).digest("hex").slice(0,16))')
GUARD="$(git rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/$KEY/herdr-0.9.0/target/debug/herdr"
[ -x "$GUARD" ] || { echo "guard 없음 $GUARD"; exit 2; }
pgrep -f -- "--user-data-dir=$ROOT/ud" >/dev/null && { echo "이 ROOT 의 앱이 이미 떠 있다"; exit 3; }
mkdir -p "$ROOT/ud" "$ROOT/shots" "$ROOT/ctl"; chmod 700 "$ROOT" "$ROOT/ud" "$ROOT/ctl"
echo "path $ROOT" >> "$ROOT/made.txt"
if [ ! -S "$SOCK" ]; then
  sh "$APP/scripts/l470/clean.sh" ${L604_HERDR_ENV:-} -- "nohup '$GUARD' --session $SESSION server > '$ROOT/herdr-server.out' 2>&1 & echo \$! > '$ROOT/herdr.pid'" </dev/null
  i=0; until [ -S "$SOCK" ]; do i=$((i+1)); [ $i -gt 150 ] && { echo "herdr 세션 소켓 안 뜸"; exit 1; }; sleep 0.2; done
  echo "path $(dirname "$SOCK")" >> "$ROOT/made.txt"
  echo "pid herdr $(cat "$ROOT/herdr.pid")" >> "$ROOT/made.txt"
fi
echo "herdr_pid=$(cat "$ROOT/herdr.pid") session=$SESSION"
# K1: L604_SERVE=1 이면 창 없는 런타임(`corral serve`)만 띄운다 — Electron 창이 뜰 때 앞으로 와 다른 창에서 치던 OS 키 입력을 받는다(K1 k34).
# K1b R5-C: 같은 ROOT 에 serve 나 소켓이 이미 있으면 띄우지 않는다 — 옛 소켓으로 「up ok」 가 나가지 않게. 「up ok」 는 새 serve 가 살아 있고 그 소켓이 응답할 때만.
if [ "${L604_SERVE:-}" = 1 ]; then
  OLD=$(cat "$ROOT/serve.pid" 2>/dev/null || true)
  { [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; } && { echo "이 ROOT 의 serve 가 이미 떠 있다 ($OLD)"; exit 3; }
  [ -e "$ROOT/ud/runtime/rpc.sock" ] && { echo "런타임 소켓이 이미 있다 — down.sh 먼저"; exit 3; }
  # shellcheck disable=SC2086
  sh "$APP/scripts/l470/clean.sh" $ENVS CORRAL_HERDR_BIN="$GUARD" "$@" -- "exec '$(command -v node)' '$APP/cli/corral.mjs' serve --json" > "$ROOT/serve.log" 2>&1 </dev/null &
  SPID=$!; echo "$SPID" > "$ROOT/serve.pid"; echo "pid serve $SPID" >> "$ROOT/made.txt"
  i=0; until [ -S "$ROOT/ud/runtime/rpc.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "런타임 소켓 안 뜸"; exit 1; }; kill -0 "$SPID" 2>/dev/null || { echo "serve 가 죽었다"; exit 1; }; sleep 0.2; done
  i=0; until CORRAL_RUNTIME_SOCKET="$ROOT/ud/runtime/rpc.sock" node "$APP/cli/corral.mjs" terminal list --json >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 50 ] && { echo "런타임 소켓이 응답하지 않는다"; exit 1; }; sleep 0.2; done
  kill -0 "$SPID" 2>/dev/null || { echo "serve 가 죽었다"; exit 1; }
  echo "serve_pid=$SPID at=$(date '+%T')"
  SENV=$(ps eww -o command= -p "$SPID") || { echo "✘ serve env 를 못 읽었다"; exit 4; }
  echo "$SENV" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
  echo "up ok"; exit 0
fi
rm -f "$ROOT/ctl/ctl.sock"
# 맨 앞 앱 = ASN(앱 인스턴스마다 다름 — 이름이 같은 설치본 corral 과 격리 앱을 가른다) + pid + 이름.
FRONT_BEFORE=$(front); echo "before $(date '+%T') ${FRONT_BEFORE:-?} handoff=$L604_HANDOFF" >> "$ROOT/focus.txt"
[ -n "$FRONT_BEFORE" ] || { echo "✘ 띄우기 전 맨 앞 앱을 못 읽었다 — 포커스 증거 없음, 띄우지 않는다"; exit 2; }
LAUNCH='if [ -n "${L604_EXE:-}" ]; then exec "$L604_EXE" --user-data-dir="$CORRAL_USER_DATA" ${L604_EXTRA_ARGS:-}; else exec "$L604_EL" "$L604_APP" --user-data-dir="$CORRAL_USER_DATA" ${L604_EXTRA_ARGS:-}; fi'
N=$(ls "$ROOT"/electron-*.log 2>/dev/null | wc -l | tr -d ' ')
# shellcheck disable=SC2086
sh "$APP/scripts/l470/clean.sh" $ENVS CORRAL_HERDR_BIN="$GUARD" "$@" \
  L604_EL="$EL" L604_APP="${L604_APP_DIR:-$APP}" L604_EXE="${L604_EXE:-}" -- "$LAUNCH" > "$ROOT/electron-$N.log" 2>&1 </dev/null &
i=0; until [ -S "$ROOT/ctl/ctl.sock" ]; do i=$((i+1)); [ $i -gt 300 ] && { echo "제어 소켓 안 뜸"; exit 1; }; sleep 0.2; done
APID=$(pgrep -f -- "--user-data-dir=$ROOT/ud" | sort -n | head -1); echo "$APID" > "$ROOT/app.pid"
echo "pid app $APID" >> "$ROOT/made.txt"
echo "app_pid=$APID launch=$N at=$(date '+%T')"
# 창이 그려질(ready-to-show → show) 때까지 최대 30초 맨 앞 앱을 본다 — 5초는 첫 빌드·느린 기동에서 show 전에 끝났다(리뷰 r2).
STOLEN=0; i=0; while [ $i -lt 150 ]; do i=$((i+1)); NOW=$(front); [ "$NOW" != "$FRONT_BEFORE" ] && { STOLEN=1; break; }; sleep 0.2; done
echo "after $(date '+%T') ${NOW:-?} stolen=$STOLEN waited=$((i * 2 / 10))s handoff=$L604_HANDOFF" >> "$ROOT/focus.txt"
ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -qE '^(CLAUDE_CODE_[A-Z_]+|CLAUDECODE)=' && { echo "✘ 워커 env 가 샜다"; exit 4; }
echo "up ok"
