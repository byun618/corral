#!/bin/zsh
# LIFE-527 fix1 F3 음성 대조 — os-up 이 끌 때 F18 false 를 종료코드로 내는가. 지문 파일은 임시 파일(사용자 ~/.orca/keybindings.json 무접촉).
# 실행 중 임시 파일을 바꾸고 SIGTERM — 기대 exit 1. 명령줄에 작업 폴더가 안 들어가게 파일로 돈다(504 가드가 래퍼 셸을 잡는다).
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"  # worktree 루트 — 스크립트 위치 기준(fix2 H5)
D=specs/LIFE-527-titlebar/raw/claude/fix1/os/$1; K=/tmp/l527-f18ctl/kb.json
mkdir -p $D /tmp/l527-f18ctl && echo '{"a":1}' > $K
W=/tmp/l527os
$HOME/.nvm/versions/node/v24.14.1/bin/node app/scripts/l527/os-up.mjs --work $W --out $D --no-orca --keybindings-file $K > $D/stdout.txt 2>&1 &
up=$!
for i in $(seq 1 60); do [ -f $W/os-state.json ] && break; /bin/sleep 1; done
echo '{"a":2}' > $K
kill -TERM $up; wait $up; code=$?
echo "os-up exit=$code" >> $D/stdout.txt
exit $code
