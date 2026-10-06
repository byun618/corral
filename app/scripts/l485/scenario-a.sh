#!/bin/sh
# LIFE-485 K4ⓐ~ⓔ·K1ⓑⓒ·K2ⓔ — 재개 0 인 멈춘 default(격리) → 자동 기동·분리·앱 종료 뒤 생존·재부착·환경. 사용: sh scenario-a.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json
echo "## 기동 전 격리 서버 수: $(servers | wc -l | tr -d ' ')"
sh "$H/iso-app.sh" "$ROOT" "$APP"
wait_phase live 150 && echo "link live" || echo "link 가 live 가 아니다"
check "K4ⓐ link phase" "$(st "d['link']['phase']")" live
check "K4ⓐ backend 카드" "$(st "d['backend']['kind']")" ok
echo "## 로그 (해소·조회·spawn·결정)"
grep -E '"tag":"(herdr\.resolve|herdr\.server\.spawn|backend\.(status|start[a-z._]*))"' "$ROOT/corral.ndjson" | cut -c1-400
grep -m2 '"tag":"sessions.poll"' "$ROOT/corral.ndjson" | cut -c1-300
check "K1ⓑ 조회 source=cli(첫 폴)" "$(grep -m1 '"tag":"sessions.poll"' "$ROOT/corral.ndjson" | /usr/bin/python3 -c "import json,sys; print(json.loads(sys.stdin.read())['source'])")" cli
check "K1ⓒ 해소 로그 1줄" "$(grep -c '"tag":"herdr.resolve"' "$ROOT/corral.ndjson")" 1
SP=$(servers); echo "## 서버 pid: $SP"
check "서버 수" "$(echo "$SP" | grep -c .)" 1
APID=$(cat "$ROOT/app.pid")
echo "## ps (서버·앱)"; ps -o pid,ppid,pgid,stat,lstart,command -p "$SP" -p "$APID" | cut -c1-200
check "K4ⓑ 서버 pgid=pid(그룹 리더)" "$(ps -o pgid= -p "$SP" | tr -d ' ')" "$SP"
check "K4ⓑ 서버 STAT 에 s(세션 리더)" "$(ps -o stat= -p "$SP" | grep -c s)" 1
echo "## lsof fd 0-2"; lsof -a -p "$SP" -d 0,1,2 2>/dev/null
check "K4ⓑ stdin=/dev/null" "$(lsof -a -p "$SP" -d 0 -Fn 2>/dev/null | grep -c '^n/dev/null')" 1
check "K4ⓑ stdout=로그 파일" "$(lsof -a -p "$SP" -d 1 -Fn 2>/dev/null | grep -cE "^n(/private)?$ROOT/ud/herdr-server.log")" 1  # macOS 는 /tmp 를 /private/tmp 로 보인다(r10)
check "K4ⓑ stdio 에 PIPE 없음" "$(lsof -a -p "$SP" -d 0,1,2 2>/dev/null | grep -ci pipe)" 0
echo "## 환경 (K4ⓔ) — 양성 대조: 앱 프로세스"
APPV=$(ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -cE '^(CORRAL_|ELECTRON_)')
SRVV=$(ps eww -o command= -p "$SP" | tr ' ' '\n' | grep -cE '^(CORRAL_|ELECTRON_)')
echo "앱 CORRAL_/ELECTRON_ 변수 ${APPV}개: $(ps eww -o command= -p "$APID" | tr ' ' '\n' | grep -E '^(CORRAL_|ELECTRON_)' | cut -d= -f1 | tr '\n' ' ')"
echo "서버 CORRAL_/ELECTRON_ 변수 ${SRVV}개 · XDG: $(ps eww -o command= -p "$SP" | tr ' ' '\n' | grep '^XDG_CONFIG_HOME=')"
[ "$APPV" -gt 0 ] && echo "PASS 양성 대조(앱에서 잡힘)" || { echo "FAIL 양성 대조"; FAIL=1; }
check "K4ⓔ 서버 CORRAL_/ELECTRON_ 변수" "$SRVV" 0
echo "## 앱 종료 (K4ⓒ)"; app_stop; sleep 1
check "K4ⓒ 서버 pid 생존" "$(kill -0 "$SP" 2>/dev/null && echo alive || echo gone)" alive
check "K4ⓒ default running" "$(running_default)" True
ps -o pid,ppid,pgid,stat,command -p "$SP" | cut -c1-160
echo "## 앱 재기동 (K4ⓓ)"
SPAWNS_BEFORE=$(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson")
sh "$H/iso-app.sh" "$ROOT" "$APP"
wait_phase live 150 && echo "link live" || echo "link 가 live 가 아니다"
check "K4ⓓ link phase" "$(st "d['link']['phase']")" live
check "K4ⓓ 서버 수" "$(servers | grep -c .)" 1
check "K4ⓓ 서버 pid 불변" "$(servers)" "$SP"
check "K4ⓓ 재기동 뒤 spawn 로그 증가 0" "$(( $(grep -c '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson") - SPAWNS_BEFORE ))" 0
sh "$H/card.sh" "$ROOT" a-relaunch-live | cut -c1-600
echo "## 정리"; app_stop; server_stop
check "정리 뒤 격리 서버" "$(servers | grep -c .)" 0
echo "FAIL=$FAIL"; exit $FAIL
