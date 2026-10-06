#!/bin/sh
# LIFE-485 fix1 (r1 R1-10) — 경합: corral 의 자동 기동(느린 가짜 — 4초 뒤 진짜 `herdr server` 로 exec)이 끝나기 전에 하네스가 진짜 서버를 먼저 띄운다.
# corral 이 띄운 쪽은 살아 있는 소켓 락에 exit 1 로 진다 → 실패 카드 없이 그 서버에 붙어야 한다(격리, 재개 0). 사용: sh scenario-r.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo slow > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
wait_card starting 100 && echo "카드 starting (corral 자동 기동 중)"
XDG_CONFIG_HOME="$ROOT/xdg" nohup /opt/homebrew/bin/herdr server > "$ROOT/harness-server.log" 2>&1 & HS=$!
echo "하네스 서버 pid $HS"
SEEN_FAILED=no; i=0; while [ $i -lt 60 ]; do i=$((i+1)); sleep 0.2; K=$(st "d['backend']['kind'] + '/' + d['link']['phase']"); echo "t$i $K"; echo "$K" | grep -q '^failed/' && SEEN_FAILED=yes; done
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.spawn)"' "$ROOT/corral.ndjson" | cut -c1-300
echo "## corral 이 띄운 쪽 로그"; cat "$ROOT/ud/herdr-server.log" | tail -3
# r45: 하네스 서버가 corral 의 다음 조회에 먼저 보이면 `ready` 로, 자식 종료가 먼저 보이면 `lost_race` 로 끝난다 — 어느 쪽이든 실패가 아니다.
# lost_race 분기 자체는 backend-start.test.ts 가 결정적으로 덮는다. 여기서는 끝난 분기를 적고 실패 카드·서버 수를 판정한다.
echo "끝난 분기: $(grep -oE '"tag":"backend\.start\.(ready|lost_race|failed)"' "$ROOT/corral.ndjson" | tr '\n' ' ')"
check "R1-10 기동이 실패 없이 끝남(ready 또는 lost_race 1회)" "$(grep -cE '"tag":"backend\.start\.(ready|lost_race)"' "$ROOT/corral.ndjson")" 1
check "R1-10 실패 로그 0" "$(grep -c '"tag":"backend.start.failed"' "$ROOT/corral.ndjson")" 0
check "R1-10 corral 쪽 서버는 락에 졌다(already running)" "$(grep -c 'already running' "$ROOT/ud/herdr-server.log")" 1
check "R1-10 실패 카드 안 뜸" "$SEEN_FAILED" no
check "R1-10 link" "$(st "d['link']['phase']")" live
check "R1-10 서버 1개·하네스 pid" "$(servers)" "$HS"
app_stop; server_stop
check "정리" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
