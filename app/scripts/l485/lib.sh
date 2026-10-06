# LIFE-485 격리 회차 공통 — source 해서 쓴다.
N="$HOME/.nvm/versions/node/v24.14.1/bin/node"; H=$(cd "$(dirname "$0")" && pwd); APP=${L485_APP:-$(cd "$H/../.." && pwd)}
FAIL=0
[ -f /tmp/l485i/zero.json ] || { mkdir -p /tmp/l485i; "$N" "$H/synth-restore.mjs" /tmp/l485i/zero.json zero; }  # 재개 0 격리 원본
check() { if [ "$2" = "$3" ]; then echo "PASS $1 (= $3)"; else echo "FAIL $1 (실측 $2 / 기대 $3)"; FAIL=1; fi; }
ctl() { "$N" "$H/ctl.mjs" "$ROOT/ctl.sock" "$1"; }
st() { ctl '{"cmd":"state"}' | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin)['state']; print($1)"; }
wait_phase() { i=0; while [ "$(st "d['link']['phase']")" != "$1" ]; do i=$((i+1)); [ $i -gt ${2:-100} ] && return 1; sleep 0.2; done; return 0; }
wait_card() { i=0; while [ "$(st "d['backend']['kind']")" != "$1" ]; do i=$((i+1)); [ $i -gt ${2:-100} ] && return 1; sleep 0.2; done; return 0; }
# 이 격리 루트(XDG_CONFIG_HOME)를 환경에 가진 herdr server 프로세스 pid 들 — ps eww 로 환경까지 본다
servers() { ps -Ao pid=,command= | grep -E '/[h]erdr( --session [^ ]+)? server$' | awk '{print $1}' | while read -r p; do ps eww -o command= -p "$p" | grep -q "XDG_CONFIG_HOME=$ROOT/xdg" && echo "$p"; done; }
herdr_iso() { XDG_CONFIG_HOME="$ROOT/xdg" /opt/homebrew/bin/herdr "$@"; }
running_default() { herdr_iso session list --json | /usr/bin/python3 -c "import json,sys; print([s['running'] for s in json.load(sys.stdin)['sessions'] if s['default']][0])"; }
app_stop() { A=$(cat "$ROOT/app.pid"); kill "$A" 2>/dev/null; i=0; while kill -0 "$A" 2>/dev/null; do i=$((i+1)); [ $i -gt 100 ] && { kill -9 "$A"; echo "app $A SIGKILL"; break; }; sleep 0.2; done; echo "app $A 종료"; rm -f "$ROOT/ctl.sock"; }
server_stop() { herdr_iso server stop >/dev/null 2>&1; i=0; while [ -n "$(servers)" ]; do i=$((i+1)); [ $i -gt 50 ] && { for p in $(servers); do kill "$p"; done; echo "server kill"; break; }; sleep 0.2; done; echo "격리 서버 정지: 남은 $(servers | wc -l | tr -d ' ')개 · default running=$(running_default)"; }
