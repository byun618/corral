#!/bin/sh
# LIFE-485 K5 「확인 필요」·K2ⓔ·K3⑤ — 재개 ≥1(합성) 멈춘 default(격리) → 확인 카드, 아무것도 누르지 않으면 30초 동안 서버가 뜨지 않는다.
# 격리 규칙 4: 이 루트에서는 「서버 시작」 을 누르지 않는다(누르면 provider 가 뜬다). 사용: sh scenario-b.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; mkdir -p /tmp/l485i; "$N" "$H/synth-restore.mjs" /tmp/l485i/restore3.json
sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/restore3.json
U0=$(shasum -a 256 "$HOME/.config/herdr/session.json" | cut -d' ' -f1); S0=$(shasum -a 256 "$ROOT/xdg/herdr/session.json" | cut -d' ' -f1)
sh "$H/iso-app.sh" "$ROOT" "$APP"
wait_card confirm 150 && echo "카드 confirm" || echo "카드가 confirm 이 아니다"
sh "$H/card.sh" "$ROOT" b-confirm-restore3
check "K5 카드" "$(st "d['backend']['kind']")" confirm
check "K2ⓔ 격리 파일 계수(claude 2·codex 1)" "$(st "json.dumps(d['backend']['restore'])")" '{"known": true, "total": 3, "agents": [{"kind": "claude", "count": 2}, {"kind": "codex", "count": 1}]}'
# query 는 button 의 value('')를 읽는다(r12) — innerText 로 본다
check "K5 버튼 문구" "$(ctl '{"cmd":"eval","code":"Array.from(document.querySelectorAll(\"[data-backend-start]\")).map(b => b.innerText).join(\",\")"}' | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")" "서버 시작"
echo "## 30초 관찰 — 누르지 않는다"
i=0; while [ $i -lt 6 ]; do sleep 5; i=$((i+1)); echo "t+$((i*5))s 서버 $(servers | grep -c .)개 · default running=$(running_default) · 카드 $(st "d['backend']['kind']")"; done
check "K5 30초 뒤 서버 수" "$(servers | grep -c .)" 0
check "K5 30초 뒤 running" "$(running_default)" False
check "spawn 로그 0" "$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")" 0
check "K2ⓔ 사용자 session.json 해시 불변" "$(shasum -a 256 "$HOME/.config/herdr/session.json" | cut -d' ' -f1)" "$U0"
check "격리 session.json 해시 불변" "$(shasum -a 256 "$ROOT/xdg/herdr/session.json" | cut -d' ' -f1)" "$S0"
grep -E '"tag":"(herdr\.resolve|backend\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-300
app_stop
check "정리 뒤 격리 서버" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
