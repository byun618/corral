#!/bin/sh
# LIFE-485 fix3 F9 (r3 R3-02) — 시한이 끝날 때 서버가 돌고 있는지 모르면(조회 오류) 그 프로세스를 죽이지 않는다.
#  hang 가짜로 자동 기동 → spawn 뒤 12초에 `session list` 를 실패로 바꿈 → 시한(15초) 끝 마지막 조회 = 모름 →
#  `backend.start.failed probe:unknown`, hang pid 생존. 조회를 되살리면 실패 카드 원문에 pid·「끝내지 않았다」.
#  양성 대조: L485_APP=<r3 태그 빌드> 면 조회 오류를 안 돎으로 읽어 그룹을 끝낸다 → FAIL. 측정 뒤 남은 것은 직접 정리한다.
#  사용: [L485_APP=..] sh scenario-f9.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
echo "## app $APP ($(git -C "$APP" rev-parse --short HEAD 2>/dev/null || cat "$APP/../.l485-rev" 2>/dev/null))"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json || { echo "격리 루트 준비 실패 — 멈춘다"; exit 3; }
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo hang > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
i=0; until grep -q '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
HP=$(grep -m1 '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" | /usr/bin/python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['pid'])")
echo "spawn pid $HP — 12초 뒤 session list 를 실패로"
sleep 12; echo fail > "$FK/fake-list"; echo "fake-list=fail $(date +%T)"
i=0; until grep -q '"tag":"backend.start.failed"' "$ROOT/corral.ndjson"; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.2; done
grep -E '"tag":"(backend\.start[a-z._]*|herdr\.server\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-320
check "시한 끝 마지막 조회 = 모름(probe unknown)" "$(grep '"tag":"backend.start.failed"' "$ROOT/corral.ndjson" | grep -c '"probe":"unknown"')" 1
check "그룹 종료 로그 없음" "$(grep -c '"tag":"herdr.server.stop_group"' "$ROOT/corral.ndjson")" 0
check "hang pid 생존(죽이지 않음)" "$(kill -0 "$HP" 2>/dev/null && echo alive || echo gone)" alive
rm -f "$FK/fake-list"; echo "fake-list 해제 — 조회 회복"
wait_card failed 100 && echo "카드 failed"
sh "$H/card.sh" "$ROOT" f9-unknown
check "실패 원문에 pid·끝내지 않음" "$(st "str(('pid $HP' in d['backend'].get('error','')) and ('끝내지 않았다' in d['backend'].get('error','')))")" True
app_stop
kill "$HP" 2>/dev/null && echo "측정 뒤 정리: $HP"; sleep 0.5
check "정리 뒤 hang pid" "$(kill -0 "$HP" 2>/dev/null && echo alive || echo gone)" gone
L485_ORPHAN_EXTRA='[0-9] sleep 120$' sh "$H/orphan-check.sh" | tail -1
echo "FAIL=$FAIL"; exit $FAIL
