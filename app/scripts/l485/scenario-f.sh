#!/bin/sh
# LIFE-485 K5 「herdr 없음」·K3⑦ — CORRAL_HERDR_BIN 을 없는 경로로(격리). 사용: sh scenario-f.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$ROOT/no-such-herdr"
wait_card missing 150 && echo "카드 missing"
sh "$H/card.sh" "$ROOT" f-missing
check "K5 herdr 없음 카드" "$(st "d['backend']['kind']")" missing
sleep 5
check "spawn 0" "$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 0
check "격리 서버 0" "$(servers | grep -c .)" 0
grep -E '"tag":"(herdr\.resolve|backend\.[a-z._]*|sessions\.poll)"' "$ROOT/corral.ndjson" | head -4 | cut -c1-300
app_stop
echo "FAIL=$FAIL"; exit $FAIL
