#!/bin/zsh
# os-act.mjs 줄임 — act.sh <pid> <창 번호> <라벨> <cliclick 명령…>. 로그 = raw/claude/os/actions.jsonl (ACT_LOG 로 바꿀 수 있다)
# 추가 플래그는 환경변수로: OS_ACT_FLAGS="--window-drag" · OS_ACT_FLAGS="--window-drag --expect-frame 400,106"
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-527-titlebar-claude
pid=$1 win=$2 label=$3; shift 3
exec $HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/os-act.mjs --pid $pid --window $win --log ${ACT_LOG:-specs/LIFE-527-titlebar/raw/claude/os/actions.jsonl} --label "$label" ${=OS_ACT_FLAGS} -- "$@"
