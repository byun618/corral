#!/bin/sh
# LIFE-485 fix2 F5 (r2 R2-01②) — 시한 초과한 자식을 남기지 않는다.
#  hang 가짜로 자동 기동 → 15초 시한 → 실패 → 「다시 시도」(여전히 hang) → 다시 시한 → 앱 종료 →
#  spawn 로그의 pid 가 하나도 살아 있지 않아야 한다(시한 초과 때 그룹을 끝냈다). 고아 검사에 hang 의 `sleep 120` 도 센다.
#  양성 대조: L485_APP=<r2 태그 빌드> 로 돌리면 hang 자식이 남아 FAIL. 측정 뒤 남은 것은 이 스크립트가 직접 정리한다.
#  사용: [L485_APP=<app 디렉터리>] sh scenario-f5.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
echo "## app $APP ($(git -C "$APP" rev-parse --short HEAD 2>/dev/null || cat "$APP/../.l485-rev" 2>/dev/null))"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo hang > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
T0=$(date +%s); wait_card failed 200 && echo "1차 실패 카드 (경과 $(( $(date +%s) - T0 ))초)"
check "시한 초과 → 실패" "$(st "d['backend']['kind']")" failed
echo "## 「다시 시도」 실제 클릭 (여전히 hang)"
ctl '{"cmd":"click","selector":"[data-backend-start]"}' | cut -c1-200
wait_card starting 50 && echo "시작 중"
T1=$(date +%s); wait_card failed 200 && echo "2차 실패 카드 (경과 $(( $(date +%s) - T1 ))초)"
sh "$H/card.sh" "$ROOT" f5-failed-after-retry
PIDS=$(grep '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" | /usr/bin/python3 -c "import json,sys; print(' '.join(str(json.loads(l)['pid']) for l in sys.stdin))")
echo "## spawn pid: $PIDS"
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-320
app_stop
sleep 1
ALIVE=0; for p in $PIDS; do if kill -0 "$p" 2>/dev/null; then ALIVE=$((ALIVE+1)); echo "살아 있음 $p: $(ps -o pid=,pgid=,etime=,command= -p "$p")"; fi; done
check "spawn 2회(자동 1 + 다시 시도 1)" "$(echo $PIDS | wc -w | tr -d ' ')" 2
check "앱 종료 뒤 살아 있는 hang 자식 수" "$ALIVE" 0
echo "## 고아 검사 (hang 의 sleep 120 포함)"
L485_ORPHAN_EXTRA='[0-9] sleep 120$' sh "$H/orphan-check.sh"; OC=$?
check "orphan-check exit" "$OC" 0
for p in $PIDS; do kill "$p" 2>/dev/null && echo "측정 뒤 정리: $p"; done
sleep 0.5; echo "정리 뒤 남은 spawn pid: $(for p in $PIDS; do kill -0 "$p" 2>/dev/null && echo "$p"; done | grep -c .)"
echo "FAIL=$FAIL"; exit $FAIL
