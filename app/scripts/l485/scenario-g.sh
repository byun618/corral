#!/bin/sh
# LIFE-485 K5 「지정 세션 꺼짐」·「재연결 중」·K3①⑩·K6ⓑ — 측정 하네스 바인딩(CORRAL_BACKEND_SOCKET+CORRAL_SESSION, 격리).
#  ① 소켓 없음 → 지정 세션 꺼짐 카드, 10초 동안 spawn 0 (default 재개 0 이어도)
#  ② 연결을 받자마자 끊는 가짜 소켓 → 재연결 중 카드
#  ③ 하네스가 직접 띄운 격리 이름 세션 서버에 바인딩 → live, spawn 0 (K6ⓑ). 사용: sh scenario-g.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
BS="$ROOT/bound.sock"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_BACKEND_SOCKET="$BS" CORRAL_SESSION=l485-bound
wait_card bound-stopped 150 && echo "카드 bound-stopped"
sh "$H/card.sh" "$ROOT" g-bound-stopped
check "K5 지정 세션 꺼짐" "$(st "d['backend']['kind']")" bound-stopped
sleep 10
check "K3⑩ 10초 spawn 0" "$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 0
check "K3⑩ 격리 서버 0" "$(servers | grep -c .)" 0
echo "## 가짜 소켓 (재연결 중)"
"$N" "$H/fake-listener.mjs" "$BS" > "$ROOT/fake-listener.log" 2>&1 & FL=$!
wait_card reconnecting 100 && echo "카드 reconnecting"
sh "$H/card.sh" "$ROOT" g-reconnecting
check "K5 재연결 중" "$(st "d['backend']['kind']")" reconnecting
kill "$FL"; wait "$FL" 2>/dev/null; rm -f "$BS"
app_stop
echo "## 하네스 경로 (K6ⓑ) — 격리 이름 세션 서버를 하네스가 직접 띄운다"
rm -f "$ROOT/ud/runtime/profile.json"
XDG_CONFIG_HOME="$ROOT/xdg" nohup /opt/homebrew/bin/herdr --session l485h server > "$ROOT/l485h.log" 2>&1 & HS=$!
i=0; until [ -S "$ROOT/xdg/herdr/sessions/l485h/herdr.sock" ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
echo "하네스 서버 pid $HS"; ps -o pid,ppid,command -p "$HS"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_BACKEND_SOCKET="$ROOT/xdg/herdr/sessions/l485h/herdr.sock" CORRAL_SESSION=l485h
wait_phase live 150 && echo "link live"
sh "$H/card.sh" "$ROOT" g-harness-live
check "K6ⓑ link" "$(st "d['link']['phase']")" live
check "K6ⓑ 카드 없음" "$(st "d['backend']['kind']")" ok
check "K6ⓑ spawn 0(전 회차 합)" "$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 0
check "K6ⓑ default 미기동" "$(running_default)" False
app_stop
XDG_CONFIG_HOME="$ROOT/xdg" /opt/homebrew/bin/herdr --session l485h server stop >/dev/null 2>&1; sleep 1
kill -0 "$HS" 2>/dev/null && { kill "$HS"; echo "하네스 서버 kill"; }
check "하네스 서버 정리" "$(kill -0 "$HS" 2>/dev/null && echo alive || echo gone)" gone
echo "FAIL=$FAIL"; exit $FAIL
