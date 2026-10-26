#!/bin/sh
# usage: esc.sh <pane> <key...> — sends keys, polls agent status up to 10s, prints ms until status leaves 'working'
H=/tmp/l582z1/hd; P=$1; shift
ms() { python3 -c 'import time;print(int(time.time()*1000))'; }
B=$($H agent get $P | grep -o '"agent_status":"[^"]*"\|"state_change_seq":[0-9]*' | tr '\n' ' ')
T0=$(ms); $H pane send-keys $P "$@"
while :; do S=$($H agent get $P | grep -o '"agent_status":"[^"]*"' ); case "$S" in *working*) ;; *) break;; esac; [ $(( $(ms) - T0 )) -gt 10000 ] && break; sleep 0.2; done
echo "before: $B | after: $S $($H agent get $P | grep -o '"state_change_seq":[0-9]*') | ms=$(( $(ms) - T0 ))"
