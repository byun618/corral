#!/bin/sh
# LIFE-485 fix3 F8 (r3 R3-01, grok M1 재현 모양) — 바인딩이 있는 기동에서 첫 조회 전에 「지정된 세션 … 멈춰 있습니다」 를 그리지 않는다.
#  CORRAL_SESSION=l485r3bound + CORRAL_BACKEND_SOCKET=<존재하는 일반 파일> + CORRAL_HERDR_BIN=<`--version` 이 6초 걸리는 가짜>.
#  제어 소켓이 열린 순간부터 `herdr.resolve` 가 찍히고 첫 조회가 끝날 때까지 backend.kind 를 0.2초마다 표본으로 뜬다 →
#  bound-stopped 0회여야 한다. 조회 뒤는 소켓이 아니라 링크가 reconnecting(배너)로 간다.
#  양성 대조: L485_APP=<r3 태그 0743f4ed 빌드> 면 조회 전 bound-stopped 가 잡혀 FAIL. 사용: [L485_APP=..] sh scenario-f8.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
echo "## app $APP ($(git -C "$APP" rev-parse --short HEAD 2>/dev/null || cat "$APP/../.l485-rev" 2>/dev/null))"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json || { echo "격리 루트 준비 실패 — 멈춘다"; exit 3; }
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo slowversion > "$FK/fake-mode"
: > "$ROOT/not-a-socket"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr" CORRAL_SESSION=l485r3bound CORRAL_BACKEND_SOCKET="$ROOT/not-a-socket"
echo "## 표본 (조회 전 → 첫 sessions.poll 까지)"
: > "$ROOT/samples.txt"; i=0
while [ $i -lt 100 ]; do
  S=$(st "d['backend']['kind'] + ' sessions=' + str(len(d['sessions']))")
  P=$(grep -c '"tag":"sessions.poll"' "$ROOT/corral.ndjson" 2>/dev/null); R=$(grep -c '"tag":"herdr.resolve"' "$ROOT/corral.ndjson" 2>/dev/null)
  echo "t=$i resolve=$R $S" >> "$ROOT/samples.txt"
  [ "$(grep -c 'sessions=1' "$ROOT/samples.txt")" -ge 3 ] && break
  i=$((i+1)); sleep 0.2
done
cat "$ROOT/samples.txt"
PRE=$(grep 'sessions=0' "$ROOT/samples.txt" | grep -c .)
echo "조회 전 표본 ${PRE}개"
[ "$PRE" -ge 5 ] && echo "PASS 조회 전 창을 잡았다 (≥5 표본)" || { echo "FAIL 조회 전 창이 너무 짧다 ($PRE)"; FAIL=1; }
check "조회 전 bound-stopped 표본 수" "$(grep 'sessions=0' "$ROOT/samples.txt" | grep -c 'bound-stopped')" 0
check "조회 뒤 bound-stopped 표본 수" "$(grep 'sessions=1' "$ROOT/samples.txt" | grep -c 'bound-stopped')" 0
check "조회 뒤 지정 세션 running" "$(st "str(d['sessions'][0]['running'])")" True
sh "$H/card.sh" "$ROOT" f8-after-scan
grep -E '"tag":"(herdr\.resolve[a-z._]*|backend\.status|sessions\.poll)"' "$ROOT/corral.ndjson" | cut -c1-260
app_stop
check "정리 뒤 격리 서버" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
