#!/bin/sh
# LIFE-485 fix5 F15 (r5 R5-01, grok M1) — 남긴 자식이 끝나면 잊는다. 다음 기동이 끝난 번호의 그룹에 신호를 보내지 않는다.
#  hang 가짜로 자동 기동 → 12초에 `session list` 실패 → 시한 끝 모름(pid 남김) → 그 hang 을 **바깥에서** 끝냄 →
#  조회 회복 → 「다시 시도」 실제 클릭 → `leftover_exited` 1·`leftover_stopped`/`leftover_skipped` 0·spawn 2.
#  남의 그룹을 끝내는 실험은 하지 않는다(끝난 번호에 신호가 가는지만 본다). 양성 대조: L485_APP=<r5 태그 빌드> 면 stop 이 시도된다 → FAIL.
#  사용: [L485_APP=..] sh scenario-f15.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json || { echo "격리 루트 준비 실패 — 멈춘다"; exit 3; }
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo hang > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
spawn_pids() { grep '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" | /usr/bin/python3 -c "import json,sys; print(' '.join(str(json.loads(l)['pid']) for l in sys.stdin))"; }
alive() { kill -0 "$1" 2>/dev/null && echo alive || echo gone; }
i=0; until grep -q '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
HP=$(spawn_pids | awk '{print $1}'); echo "spawn pid $HP · ps: $(ps -o pid=,pgid=,args= -p "$HP")"
sleep 12; echo fail > "$FK/fake-list"; echo "fake-list=fail $(date +%T)"
i=0; until grep -q '"tag":"backend.start.failed"' "$ROOT/corral.ndjson"; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.2; done
check "시한 끝 모름 → pid 남김(생존)" "$(alive "$HP")" alive
echo "## 남긴 hang 을 바깥에서 끝냄 (pid $HP)"; kill -TERM "$HP"; sleep 1
check "바깥 종료 확인" "$(alive "$HP")" gone
rm -f "$FK/fake-list"; echo "## 조회 회복 → 「다시 시도」 실제 클릭"; sleep 2
ctl '{"cmd":"click","selector":"[data-backend-start]"}' | cut -c1-160
i=0; until [ "$(spawn_pids | wc -w | tr -d ' ')" -ge 2 ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
HP2=$(spawn_pids | awk '{print $2}'); echo "둘째 spawn pid $HP2"
T1=$(date +%s); i=0; until [ "$(grep -c '"tag":"backend.start.failed"' "$ROOT/corral.ndjson")" -ge 2 ]; do i=$((i+1)); [ $i -gt 120 ] && break; sleep 0.2; done; echo "둘째 시한 ($(( $(date +%s) - T1 ))초)"
grep -E '"tag":"(backend\.start[a-z._]*|herdr\.server\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-300
check "끝난 자식을 잊었다(leftover_exited)" "$(grep -c '"tag":"backend.start.leftover_exited"' "$ROOT/corral.ndjson")" 1
check "끝난 번호에 stop 시도 없음(leftover_stopped)" "$(grep -c '"tag":"backend.start.leftover_stopped"' "$ROOT/corral.ndjson")" 0
check "skip 도 없음(기억 자체가 없다)" "$(grep -c '"tag":"backend.start.leftover_skipped"' "$ROOT/corral.ndjson")" 0
check "spawn 2회" "$(spawn_pids | wc -w | tr -d ' ')" 2
check "둘째는 안 돎 확인 → 그룹 종료" "$(sleep 0.5; alive "$HP2")" gone
app_stop
for p in $(spawn_pids); do kill "$p" 2>/dev/null && echo "측정 뒤 정리: $p"; done
OC=$(sh "$H/orphan-check.sh" >"$ROOT/orphan.txt" 2>&1; echo $?); tail -2 "$ROOT/orphan.txt"
check "orphan-check exit" "$OC" 0
echo "FAIL=$FAIL"; exit $FAIL
