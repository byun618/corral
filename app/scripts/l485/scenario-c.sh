#!/bin/sh
# LIFE-485 K5 「도중 종료」·「서버 시작」 실제 클릭·K3⑧ — 재개 0(격리): 자동 기동 → live → 격리 서버 stop → 확인 카드(exited),
# 자동 재기동 없음(15초 관찰) → 카드의 「서버 시작」 실제 클릭 → live·카드 사라짐. 사용: sh scenario-c.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
REPO="$ROOT/repo"; mkdir -p "$REPO" && git -C "$REPO" init -q && git -C "$REPO" -c user.email=l485@x -c user.name=l485 commit -q --allow-empty -m init
sh "$H/iso-app.sh" "$ROOT" "$APP"
wait_phase live 150 && echo "link live (자동 기동)"
ctl "{\"cmd\":\"add-repo\",\"root\":\"$REPO\"}" | cut -c1-200
sleep 1; S1=$(servers); echo "자동 기동 서버 $S1"
echo "## 격리 서버 stop (도중 종료)"; herdr_iso server stop; i=0; while [ -n "$(servers)" ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
wait_card confirm 100 && echo "카드 confirm"
sh "$H/card.sh" "$ROOT" c-exited
check "K5 도중 종료 카드" "$(st "d['backend']['kind'] + '/' + d['backend'].get('reason','')")" confirm/exited
echo "## 15초 관찰 — 자동 재기동 없음 (K3⑧)"
i=0; while [ $i -lt 3 ]; do sleep 5; i=$((i+1)); echo "t+$((i*5))s 서버 $(servers | grep -c .)개 · running=$(running_default) · 카드 $(st "d['backend']['kind']") · link $(st "d['link']['phase']")"; done
check "K3⑧ 15초 뒤 서버 수" "$(servers | grep -c .)" 0
SP0=$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")
echo "## 「서버 시작」 클릭 (실제 입력 이벤트)"
ctl '{"cmd":"click","selector":"[data-backend-start]"}' | cut -c1-300
# 시작 중을 잡는다 — 짧다. 놓치면 그대로 적는다(시작 중 카드는 scenario-d 의 느린 가짜로 따로 본다)
st "d['backend']['kind']"
wait_phase live 150 && echo "link live (버튼)"
sleep 1
sh "$H/card.sh" "$ROOT" c-after-button
check "K5 버튼 뒤 카드 사라짐" "$(st "d['backend']['kind']")" ok
check "K5 버튼 뒤 link" "$(st "d['link']['phase']")" live
check "K5 버튼 뒤 서버 수" "$(servers | grep -c .)" 1
check "K5 버튼 뒤 spawn 1회 증가" "$(( $(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson") - SP0 ))" 1
check "버튼 trigger 로그" "$(grep -c '"tag":"backend.start","trigger":"button"' "$ROOT/corral.ndjson")" 1
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.spawn|control\.click)"' "$ROOT/corral.ndjson" | cut -c1-300
app_stop; server_stop
check "정리 뒤 격리 서버" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
