# LIFE-490 K8 — l485/native-lib.sh 복사(코드 줄의 l485→l490·L485→L490·ROOT 꼴 /tmp/l490n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 네이티브 회차 공통 — source 해서 쓴다. ROOT·RAWD 를 먼저 정한다.
N="$HOME/.nvm/versions/node/v24.14.1/bin/node"; H=$(cd "$(dirname "$0")" && pwd)
UD="$HOME/Library/Application Support/corral"; HERDR=/opt/homebrew/bin/herdr
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1 (= $3)"; else echo "FAIL $1 (실측 $2 / 기대 $3)"; FAIL=1; fi; }
ctl() { "$N" "$H/ctl.mjs" "$ROOT/ctl.sock" "$1"; }
st() { ctl '{"cmd":"state"}' | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin)['state']; print($1)"; }
wait_phase() { i=0; while [ "$(st "d['link']['phase']")" != "$1" ]; do i=$((i+1)); [ $i -gt ${2:-100} ] && return 1; sleep 0.2; done; return 0; }
wait_card() { i=0; while [ "$(st "d['backend']['kind']")" != "$1" ]; do i=$((i+1)); [ $i -gt ${2:-100} ] && return 1; sleep 0.2; done; return 0; }
# 설치 herdr 의 default 서버 행(life417-native 는 debug 빌드 경로라 안 잡힌다 — 양성 대조는 따로 찍는다)
dservers() { ps -Ao pid=,command= | grep -E '^ *[0-9]+ /opt/homebrew/bin/[h]erdr( --session default)? server$' | awk '{print $1}'; }
running_default() { "$HERDR" session list --json | /usr/bin/python3 -c "import json,sys; print([s['running'] for s in json.load(sys.stdin)['sessions'] if s['default']][0])"; }
life417_row() { ps -Ao pid,command | grep -E '[h]erdr --session life417-native server' | awk '{print $1}'; }
app_stop() { A=$(cat "$ROOT/app.pid"); kill "$A" 2>/dev/null; i=0; while kill -0 "$A" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && { echo "✘ app $A 가 30초 안에 안 끝났다"; FAIL=1; return 1; }; sleep 0.2; done; echo "app $A 종료"; rm -f "$ROOT/ctl.sock"; }
logtail() { tail -c +$(( $(cat "$ROOT/ndjson.offset") + 1 )) "$UD/corral.ndjson"; }
