#!/bin/sh
# (LIFE-469: LIFE-468 raw/claude/scripts/clean.sh 그대로 복사 — 원본 LIFE-459)
# 깨끗한 로그인 셸 환경으로 명령 하나를 돈다 (LIFE-458 실측: 이 Orca 터미널의 CLAUDE_CODE_*·ORCA_*
# 가 herdr 서버·corral 로 새면 관문이 오염된다). 넘길 변수는 `KEY=VALUE` 로 앞에 붙인다.
# PATH 는 사용자 claude 설치 위치(~/.local/bin)를 명시한다 — rc 파일 어디에도 없어 env -i 로는 안 잡힌다.
# 사용: sh clean.sh KEY=VALUE ... -- <명령 문자열>
set -eu
VARS=""
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do VARS="$VARS $1"; shift; done
[ "${1:-}" = "--" ] && shift
# shellcheck disable=SC2086
exec env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" TERM=xterm-256color LANG=en_US.UTF-8 SHELL=/bin/zsh PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" $VARS /bin/zsh -l -c "$*"
