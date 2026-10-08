# LIFE-555 최종 관문 공통 — source 해서 쓴다. 판정은 종료코드다: check 가 하나라도 실패하면 스크립트 끝 `exit $FAILS`.
# 규칙(r1 L3·r2 L-r2-1): 종료코드는 명령에서 직접 받는다 — 파이프 끝 `$?` 로 판정하지 않는다.
# 양성 대조: `control <이름> <실측> <틀린 기대>` — 같은 비교가 틀린 기대에서 **실패하는지** 본다(실패하면 CONTROL pass).
N="$HOME/.nvm/versions/node/v24.14.1/bin/node"
L555=$(cd "$(dirname "$0")" && pwd -P)
APPDIR=$(cd "$L555/../.." && pwd -P)
UD="$HOME/Library/Application Support/corral"
INST=/Applications/corral.app
SHIM_LINK="$HOME/.local/bin/corral"
HERDR=/opt/homebrew/bin/herdr
MARKERS='^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_[A-Za-z0-9_]*|ORCA_AGENT_HOOK_[A-Za-z0-9_]*)='
CANARY='^L555_CANARY_MARKER='
FAILS=0
check() { if [ "$2" = "$3" ]; then echo "CHECK $1 pass (= $3)"; else echo "CHECK $1 fail (실측 [$2] / 기대 [$3])"; FAILS=$((FAILS+1)); fi; }
control() { if [ "$2" != "$3" ]; then echo "CONTROL $1 pass (틀린 기대 [$3] 에서 비교가 실패함 — 실측 [$2])"; else echo "CONTROL $1 fail (틀린 기대가 통과됨)"; FAILS=$((FAILS+1)); fi; }
redact() { sed -E 's/^([A-Z_]*(TOKEN|SECRET|KEY))=.*/\1=<redacted>/'; }
# 프로세스 env 를 한 줄에 하나씩(ps eww) — 값의 공백은 쪼개지지만 이름 판정에는 충분하다
penv() { ps eww -o command= -p "$1" | tr ' ' '\n' | grep -E '^[A-Za-z_][A-Za-z0-9_]*='; }
marker_count() { penv "$1" | grep -cE "$MARKERS"; }
canary_count() { penv "$1" | grep -cE "$MARKERS|$CANARY"; }
# 설치본 main 프로세스(사용자 userData 또는 지정 userData) — `--type=` 이 없는 /Applications 실행 파일
inst_mains() { ps -Ao pid=,command= | grep -F "$INST/Contents/MacOS/corral" | grep -v -- '--type=' | grep -v grep | awk '{print $1}'; }
json_get() { "$N" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=new Function("r","return "+process.argv[1])(JSON.parse(s));console.log(v??"")}catch{console.log("")}})' "$1"; }
herdr_tabs() { "$HERDR" tab list 2>/dev/null | json_get 'r.result.tabs.length'; }
stop_pid() { kill "$1" 2>/dev/null; i=0; while kill -0 "$1" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && { echo "✘ $1 이 30초 안에 안 끝남 — SIGKILL"; kill -9 "$1"; FAILS=$((FAILS+1)); break; }; sleep 0.2; done; }
