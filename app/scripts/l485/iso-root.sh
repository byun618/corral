#!/bin/sh
# LIFE-485 격리 herdr 루트를 만들고 양성 대조를 찍는다. 사용: sh iso-root.sh <ROOT> <session.json 원본|none>
# 격리 = XDG_CONFIG_HOME=<ROOT>/xdg — herdr 0.9.0 의 세션 디렉터리는 XDG_CONFIG_HOME/herdr (00-analysis S1).
set -eu
ROOT=$1; SRC=$2
mkdir -p "$ROOT/xdg/herdr" "$ROOT/ud"; chmod 700 "$ROOT"  # 런타임 소켓 디렉터리는 0700 이어야 한다(r08 실패)
[ "$SRC" = none ] || cp "$SRC" "$ROOT/xdg/herdr/session.json"
echo "## 격리 session list (XDG_CONFIG_HOME=$ROOT/xdg):"
XDG_CONFIG_HOME="$ROOT/xdg" /opt/homebrew/bin/herdr session list --json | /usr/bin/python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps([s for s in d['sessions'] if s['default']]))"
