#!/bin/sh
# LIFE-485 K8ⓑ N2 — 버튼 기동(코디 위임 승인 --allow-session-restore): N1 의 앱에서 「서버 시작」 실제 클릭 → 설치 herdr 서버가 분리돼 뜨고 live·카드 사라짐,
# 재개된 agent 를 `herdr agent list`(종류·상태 칸만)로 기록 — 재개 pane 에 입력하지 않는다. 앱 종료 → 서버 생존(pid 불변) → 앱 재기동 → 새 spawn 없이 붙음.
# 서버는 끄지 않고 남긴다 — native-down.sh 가 멈추고 원복한다. 사용: sh native-n2.sh <ROOT> <app> <raw>
ROOT=$1; APP=$2; RAWD=$3; . "$(dirname "$0")/native-lib.sh"
check "N2 전제: 카드 confirm" "$(st "d['backend']['kind']")" confirm
ctl '{"cmd":"click","selector":"[data-backend-start]"}' | cut -c1-300
wait_phase live 150 && echo "link live"
sleep 2
sh "$H/card.sh" "$ROOT" n2-after-button
check "N2 link" "$(st "d['link']['phase']")" live
check "N2 카드 사라짐" "$(st "d['backend']['kind']")" ok
SP=$(dservers); echo "$SP" > "$ROOT/server.pid"; echo "서버 pid $SP"
check "N2 설치 default server 수" "$(echo "$SP" | grep -c .)" 1
check "N2 spawn 로그 pid = 프로세스 표" "$(logtail | grep '"tag":"herdr.server.spawn"' | /usr/bin/python3 -c "import json,sys; print(json.loads(sys.stdin.readline())['pid'])")" "$SP"
APID=$(cat "$ROOT/app.pid")
ps -o pid,ppid,pgid,stat,lstart,command -p "$SP" -p "$APID" | cut -c1-200
check "N2 분리: pgid=pid" "$(ps -o pgid= -p "$SP" | tr -d ' ')" "$SP"
check "N2 분리: 세션 리더(s)" "$(ps -o stat= -p "$SP" | grep -c s)" 1
lsof -a -p "$SP" -d 0,1,2 2>/dev/null
check "N2 stdin /dev/null" "$(lsof -a -p "$SP" -d 0 -Fn 2>/dev/null | grep -c '^n/dev/null')" 1
check "N2 stdio PIPE 없음" "$(lsof -a -p "$SP" -d 0,1,2 2>/dev/null | grep -ci pipe)" 0
APPV=$(ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -cE '^(CORRAL_|ELECTRON_)'); SRVV=$(ps eww -o command= -p "$SP" | tr ' ' '\n' | grep -cE '^(CORRAL_|ELECTRON_)')
echo "앱 CORRAL_/ELECTRON_ ${APPV}개(양성 대조) · 서버 ${SRVV}개"
check "N2 서버 env CORRAL_/ELECTRON_" "$SRVV" 0
echo "## 재개된 agent (종류·상태만)"; sleep 8; sh "$H/agent-status.sh" | tee "$RAWD/n2-agent-status.json"
"$N" "$H/restored-agents.mjs" "$SP" "$RAWD"
echo "## 앱 종료 → 서버 생존"; app_stop; sleep 2
check "N2 앱 종료 뒤 서버 pid 생존" "$(kill -0 "$SP" 2>/dev/null && echo alive || echo gone)" alive
check "N2 앱 종료 뒤 running" "$(running_default)" True
ps -o pid,ppid,pgid,stat,command -p "$SP" | cut -c1-160
echo "## 앱 재기동 → 붙음"
SPB=$(logtail | grep -c '"tag":"herdr.server.spawn"')
sh "$H/native-app.sh" "$ROOT" "$APP" "$RAWD" n2-relaunch || exit 1
wait_phase live 150 && echo "link live"
sleep 2
sh "$H/card.sh" "$ROOT" n2-relaunch-live
check "N2 재기동 link" "$(st "d['link']['phase']")" live
check "N2 재기동 서버 pid 불변·1개" "$(dservers)" "$SP"
check "N2 재기동 spawn 증가 0" "$(( $(logtail | grep -c '"tag":"herdr.server.spawn"') - SPB ))" 0
logtail | grep -E '"tag":"(backend\.[a-z._]*|herdr\.server\.spawn|herdr\.resolve|control\.click)"' | cut -c1-300
app_stop
echo "FAIL=$FAIL"; exit $FAIL
