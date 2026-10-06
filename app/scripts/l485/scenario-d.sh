#!/bin/sh
# LIFE-485 K5 「시작 중」·「시작 실패」·K4ⓕⓖⓗ — 설치 herdr 를 감싼 가짜(fake-herdr.sh)를 CORRAL_HERDR_BIN 으로 물린다(격리, 재개 0).
#  ① exit 모드: 자동 기동 → 즉시 종료 → 실패 카드(원문)·앱 생존
#  ② slow 모드로 바꾸고 「다시 시도」 연타(실제 클릭 1 + IPC 4 동시) → 시작 중 카드 → spawn 1회 → live
#  ③ 앱 재기동(hang 모드) — 서버가 이미 돌아 spawn 없음 확인 뒤 서버 stop → 확인(exited)… 은 C 가 봤다. 여기서는 hang 시한만:
#     새 루트에서 hang 모드 자동 기동 → 15초 시한 → 실패 카드. 사용: sh scenario-d.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo exit > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
APID=$(cat "$ROOT/app.pid")
wait_card failed 150 && echo "카드 failed"
sh "$H/card.sh" "$ROOT" d-failed-exit
check "K4ⓖ 즉시 종료 → 실패 카드" "$(st "d['backend']['kind']")" failed
check "K4ⓖ 원문에 가짜의 stderr" "$(st "str('일부러 바로 종료' in d['backend']['error'])")" True
check "K4ⓖ 앱 생존" "$(kill -0 "$APID" 2>/dev/null && echo alive || echo gone)" alive
check "K3⑨ 실패 뒤 자동 재시도 없음(5초)" "$(sleep 5; grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 1
echo slow > "$FK/fake-mode"
SP0=$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")
echo "## 「다시 시도」 실제 클릭 + IPC 4회 동시 (K4ⓕ)"
ctl '{"cmd":"click","selector":"[data-backend-start]"}' | cut -c1-200
ctl '{"cmd":"eval","code":"Promise.all([1,2,3,4].map(() => window.corral.startBackend())).then(() => \"done\")"}' > "$ROOT/concurrent.json" &
sleep 1
sh "$H/card.sh" "$ROOT" d-starting
check "K5 시작 중 카드" "$(st "d['backend']['kind']")" starting
wait_phase live 150 && echo "link live"
wait; cat "$ROOT/concurrent.json"
check "K4ⓕ 버튼+IPC 4회 → spawn 증가" "$(( $(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson") - SP0 ))" 1
check "K4ⓕ 격리 서버 수" "$(servers | grep -c .)" 1
check "K4ⓕ 합쳐진 요청 로그 ≥1" "$( [ "$(grep -c '"tag":"backend.start.joined"' "$ROOT/corral.ndjson")" -ge 1 ] && echo yes || echo no)" yes
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.spawn)"' "$ROOT/corral.ndjson" | cut -c1-300
app_stop; server_stop
echo "## hang 모드 — 시한 (K4ⓗ)"
ROOT2="${ROOT}h"; rm -rf "$ROOT2"; sh "$H/iso-root.sh" "$ROOT2" /tmp/l485i/zero.json; mkdir -p "$ROOT2/fake"; cp "$H/fake-herdr.sh" "$ROOT2/fake/herdr"; chmod 755 "$ROOT2/fake/herdr"; echo hang > "$ROOT2/fake/fake-mode"
ROOT_SAVE=$ROOT; ROOT=$ROOT2
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$ROOT/fake/herdr"
T0=$(date +%s); wait_card failed 150 && echo "카드 failed (경과 $(( $(date +%s) - T0 ))초)"
sh "$H/card.sh" "$ROOT" d-failed-timeout
check "K4ⓗ 시한 초과 → 실패" "$(st "d['backend']['kind']")" failed
check "K4ⓗ 원문" "$(st "str('15초 안에 준비되지 않았다' in d['backend']['error'])")" True
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.spawn)"' "$ROOT/corral.ndjson" | cut -c1-300
HP=$(grep '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" | /usr/bin/python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['pid'])")
app_stop; kill "$HP" 2>/dev/null; echo "hang 가짜 pid $HP 정리: $(kill -0 "$HP" 2>/dev/null && echo alive || echo gone)"
ROOT=$ROOT_SAVE
echo "FAIL=$FAIL"; exit $FAIL
