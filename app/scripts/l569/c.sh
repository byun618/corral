#!/bin/sh
# LIFE-569 — 개발 인스턴스 런타임 소켓만 부르는 CLI 손잡이. env -i 로 이 셸의 HERDR_*·CLAUDE_CODE_*(설치본 pane 의 것)를 뗀다 —
# 떼지 않으면 caller 신원이 설치본 herdr 의 pane 으로 실린다. 설치본 프로필 소켓에는 절대 가지 않는다(--socket 고정).
# 사용: sh c.sh <corral 인자…>
APP=$(cd "$(dirname "$0")/../.." && pwd -P)
exec env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin CORRAL_USER_DATA=/tmp/l569n/ud \
  "$HOME/.nvm/versions/node/v24.14.1/bin/node" "$APP/cli/corral.mjs" --socket /tmp/l569n/ud/runtime/rpc.sock "$@"
