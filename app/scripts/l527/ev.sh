#!/bin/zsh
# os-eval.mjs(CDP 포트) / nev.mjs(네이티브 제어 소켓 경로) 줄임 — ev.sh <port|ctl.sock 경로> '<식>'
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"  # worktree 루트 — 스크립트 위치 기준(fix2 H5)
case $1 in
  /*) exec $HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/nev.mjs "$@" ;;
  *) exec $HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/os-eval.mjs "$@" ;;
esac
