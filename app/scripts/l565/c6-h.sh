#!/bin/sh
# LIFE-565 C6 최종 관문 — 격리 루트(/tmp/l565c6/xdg)의 herdr 만 부르는 CLI 손잡이.
# env -i 로 이 셸의 HERDR_SOCKET_PATH(설치본 서버 pane 소켓)·CLAUDE_CODE_* 를 떼고 XDG_CONFIG_HOME 을 고정한다 —
# 이것 없이 herdr CLI 를 부르면 설치본·주인 미상 default 서버로 간다. 사용: sh c6-h.sh [--session 이름] <herdr 인자…>
GUARD="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)/corral-herdr-dev/aa8d1981b699319b/herdr-0.9.0/target/debug/herdr"
exec env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin XDG_CONFIG_HOME=/tmp/l565c6/xdg "$GUARD" "$@"
