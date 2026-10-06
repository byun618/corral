#!/bin/sh
# LIFE-485 fix2 F5 (r2 R2-01①, grok M1) — 낡은 「시작 실패」 가 남아 이후 멈춤을 가리지 않는다. 재개 0(격리).
#  exit 가짜로 자동 기동 → 실패 카드 → 바깥에서 진짜 herdr server 를 띄움(늦게 뜬 서버) → 앱이 붙어 live·카드 사라짐 →
#  그 서버 stop → 실패 카드가 아니라 확인(exited)·재개 요약. 양성 대조: L485_APP=<r2 태그 빌드> 면 failed 가 남아 FAIL.
#  사용: [L485_APP=<app 디렉터리>] sh scenario-f5a.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
echo "## app $APP ($(git -C "$APP" rev-parse --short HEAD 2>/dev/null || cat "$APP/../.l485-rev" 2>/dev/null))"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json || exit 3
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo exit > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
wait_card failed 150 && echo "카드 failed"
check "① 자동 기동 실패" "$(st "d['backend']['kind']")" failed
echo "## 바깥에서 진짜 server 기동 (늦게 뜬 서버 흉내)"
XDG_CONFIG_HOME="$ROOT/xdg" nohup /opt/homebrew/bin/herdr server > "$ROOT/outside-server.log" 2>&1 &
i=0; until [ "$(running_default)" = True ]; do i=$((i+1)); [ $i -gt 75 ] && break; sleep 0.2; done; echo "바깥 서버 $(servers) running=$(running_default)"
wait_card ok 100 && echo "카드 ok"
wait_phase live 150 && echo "link live"
sh "$H/card.sh" "$ROOT" f5a-late-live
check "② 늦게 뜬 서버 관측 → 카드 사라짐" "$(st "d['backend']['kind']")" ok
check "② failure_cleared 로그" "$(grep -c '"tag":"backend.start.failure_cleared"' "$ROOT/corral.ndjson")" 1
echo "## 그 서버 stop"; herdr_iso server stop; i=0; while [ -n "$(servers)" ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
wait_card confirm 100 && echo "카드 confirm"
sh "$H/card.sh" "$ROOT" f5a-exited
check "③ 멈춤 → 확인(exited)" "$(st "d['backend']['kind'] + '/' + d['backend'].get('reason','')")" confirm/exited
check "③ 재개 요약 유지" "$(st "json.dumps(d['backend'].get('restore'))")" '{"known": true, "total": 0, "agents": []}'
check "③ 자동 재기동 없음(spawn 1 그대로)" "$(sleep 3; grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 1
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-300
app_stop; server_stop
check "정리 뒤 격리 서버" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
