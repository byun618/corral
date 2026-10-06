#!/bin/sh
# LIFE-485 K8ⓐ N1 — 확인 화면(부수효과 없음): default 멈춤 + 재개 3개 상태에서 앱 기동 → 확인 카드(claude 1·grok 2),
# 60초 동안 default running:false · 설치 herdr default server 0개(양성 대조: life417-native 행은 잡힌다) · session.json 해시 불변.
# 사용: sh native-n1.sh <ROOT> <app> <raw>
ROOT=$1; APP=$2; RAWD=$3; . "$(dirname "$0")/native-lib.sh"
S0=$(shasum -a 256 "$HOME/.config/herdr/session.json" | cut -d' ' -f1)
sh "$H/native-app.sh" "$ROOT" "$APP" "$RAWD" n1 || exit 1
wait_card confirm 150 && echo "카드 confirm"
sh "$H/card.sh" "$ROOT" n1-confirm
check "N1 카드" "$(st "d['backend']['kind'] + '/' + d['backend'].get('reason','')")" confirm/stopped
check "N1 재개 계수" "$(st "json.dumps(d['backend']['restore'])")" '{"known": true, "total": 3, "agents": [{"kind": "claude", "count": 1}, {"kind": "grok", "count": 2}]}'
check "N1 문구" "$(ctl '{"cmd":"eval","code":"document.querySelector(\"[data-backend-restore]\")?.innerText ?? null"}' | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin)['result'])")" "서버를 시작하면 에이전트 세션 3개가 다시 붙습니다 (claude 1 · grok 2)"
echo "## 60초 관찰 — 누르지 않는다"
i=0; while [ $i -lt 6 ]; do sleep 10; i=$((i+1)); echo "t+$((i*10))s default running=$(running_default) · 설치 default server $(dservers | grep -c .)개 · life417 행 $(life417_row) · 카드 $(st "d['backend']['kind']") · session.json $(shasum -a 256 "$HOME/.config/herdr/session.json" | cut -c1-12)"; done
check "N1 60초 뒤 running" "$(running_default)" False
check "N1 60초 뒤 설치 default server" "$(dservers | grep -c .)" 0
check "N1 양성 대조 life417 행" "$(life417_row)" 44782
check "N1 session.json 해시 불변" "$(shasum -a 256 "$HOME/.config/herdr/session.json" | cut -d' ' -f1)" "$S0"
check "N1 spawn 로그 0" "$(logtail | grep -c '"tag":"herdr.server.spawn"')" 0
echo "## 로그(해소·조회·결정)"; logtail | grep -E '"tag":"(herdr\.resolve|backend\.[a-z._]*)"' | cut -c1-300; logtail | grep -m1 '"tag":"sessions.poll"' | cut -c1-300
check "N1 해소 경로" "$(logtail | grep -m1 '"tag":"herdr.resolve"' | /usr/bin/python3 -c "import json,sys; print(json.loads(sys.stdin.read())['path'])")" /opt/homebrew/bin/herdr
check "N1 조회 source" "$(logtail | grep -m1 '"tag":"sessions.poll"' | /usr/bin/python3 -c "import json,sys; print(json.loads(sys.stdin.read())['source'])")" cli
echo "FAIL=$FAIL"; exit $FAIL
