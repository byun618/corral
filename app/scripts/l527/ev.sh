#!/bin/zsh
# os-eval.mjs(CDP 포트) / nev.mjs(네이티브 제어 소켓 경로) 줄임 — ev.sh <port|ctl.sock 경로> '<식>'
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-527-titlebar-claude
case $1 in
  /*) exec $HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/nev.mjs "$@" ;;
  *) exec $HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/os-eval.mjs "$@" ;;
esac
