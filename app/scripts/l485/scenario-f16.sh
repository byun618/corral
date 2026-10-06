#!/bin/sh
# LIFE-485 fix5 F16 (r5 R5-02, grok L1) — 조회 오류가 이어져도 링크가 live 면 낡은 실패 카드로 터미널을 가리지 않고, 실패를 걷는다.
#  exit 가짜로 자동 기동 실패 → `session list` 를 실패로(파일시스템 폴백) → 바깥에서 진짜 server 기동(재개 0 격리) →
#  폴백이 default running·링크 live → 카드 ok·`failure_cleared` → 조회 회복 뒤 그 서버 stop → confirm/exited(실패 아님).
#  양성 대조: L485_APP=<r5 태그 빌드> 면 live 인데 failed 가 남는다 → FAIL. 사용: [L485_APP=..] sh scenario-f16.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json || { echo "격리 루트 준비 실패 — 멈춘다"; exit 3; }
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo exit > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
wait_card failed 150 && echo "카드 failed"
check "자동 기동 실패" "$(st "d['backend']['kind']")" failed
echo fail > "$FK/fake-list"; echo "fake-list=fail"; sleep 3
echo "## 바깥에서 진짜 server 기동 (조회 오류 중)"
XDG_CONFIG_HOME="$ROOT/xdg" nohup /opt/homebrew/bin/herdr server > "$ROOT/outside-server.log" 2>&1 &
i=0; until [ -S "$ROOT/xdg/herdr/herdr.sock" ]; do i=$((i+1)); [ $i -gt 75 ] && break; sleep 0.2; done; echo "바깥 서버 $(servers) sock=$([ -S "$ROOT/xdg/herdr/herdr.sock" ] && echo yes)"
wait_phase live 150 && echo "link live"
sleep 1
: > "$ROOT/samples.txt"; i=0
while [ $i -lt 10 ]; do st "d['backend']['kind'] + ' link=' + d['link']['phase'] + ' scanErr=' + str(d.get('sessionsError') is not None)" >> "$ROOT/samples.txt"; i=$((i+1)); sleep 0.5; done
cat "$ROOT/samples.txt"
sh "$H/card.sh" "$ROOT" f16-live-during-error
check "조회 오류가 이어졌다(10/10)" "$(grep -c 'scanErr=True$' "$ROOT/samples.txt")" 10
check "live 동안 카드 ok(10/10)" "$(grep -c '^ok link=live' "$ROOT/samples.txt")" 10
check "낡은 실패를 걷었다(failure_cleared)" "$(grep -c '"tag":"backend.start.failure_cleared"' "$ROOT/corral.ndjson")" 1
rm -f "$FK/fake-list"; echo "## 조회 회복 → 그 서버 stop"; sleep 2
herdr_iso server stop; i=0; while [ -n "$(servers)" ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
wait_card confirm 100 && echo "카드 confirm"
check "멈춤 → 확인(exited), 실패 아님" "$(st "d['backend']['kind'] + '/' + d['backend'].get('reason','')")" confirm/exited
grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-260
app_stop; server_stop
OC=$(sh "$H/orphan-check.sh" >"$ROOT/orphan.txt" 2>&1; echo $?); tail -1 "$ROOT/orphan.txt"
check "orphan-check exit" "$OC" 0
echo "FAIL=$FAIL"; exit $FAIL
