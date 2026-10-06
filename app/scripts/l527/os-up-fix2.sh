#!/bin/zsh
# LIFE-527 fix2 — 격리 corral + Orca 198 dev 를 os-up 으로 띄운다(명령줄에 작업 폴더가 안 들어가게 파일로 — 504 가드).
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"  # worktree 루트 — 스크립트 위치 기준
exec $HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/os-up.mjs --work /tmp/l527os --out specs/LIFE-527-titlebar/raw/claude/fix2/os/$1 ${@:2} > specs/LIFE-527-titlebar/raw/claude/fix2/os/$1.stdout 2>&1
