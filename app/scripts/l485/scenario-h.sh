#!/bin/sh
# LIFE-485 K6ⓐ·K3② — default 가 이미 돌 때(격리, 하네스가 띄움) → 새 spawn 0, 같은 서버에 붙는다. 사용: sh scenario-h.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
XDG_CONFIG_HOME="$ROOT/xdg" nohup /opt/homebrew/bin/herdr server > "$ROOT/pre.log" 2>&1 & 
i=0; until [ "$(running_default)" = True ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
S0=$(servers); echo "미리 띄운 서버 $S0"
sh "$H/iso-app.sh" "$ROOT" "$APP"
wait_phase live 150 && echo "link live"
sleep 2
check "K6ⓐ link" "$(st "d['link']['phase']")" live
check "K6ⓐ spawn 0" "$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 0
check "K6ⓐ 서버 pid 불변·1개" "$(servers)" "$S0"
app_stop; server_stop
check "정리" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
