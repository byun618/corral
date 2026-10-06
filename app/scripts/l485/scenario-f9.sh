#!/bin/sh
# LIFE-485 fix3 F9 (r3 R3-02) + fix4 F12·F13 (r4 R4-01·R4-02) — 시한 끝에 서버가 돌고 있는지 모르면(조회 오류) 그 프로세스를 죽이지 않고,
#  ① 조회 오류가 **이어지는 동안에도** 실패 카드(pid 원문·「다시 시도」)를 보인다(F12)
#  ② 조회가 회복된 뒤 「다시 시도」 는 안 돎을 확인하고 남긴 pid 를 먼저 끝낸 뒤 띄운다(F13)
#  hang 가짜로 자동 기동 → spawn 뒤 12초에 `session list` 를 실패로 → 시한 끝 = 모름(pid 생존) → 오류 유지 6초 동안 카드 표본 →
#  조회 회복 → 「다시 시도」 실제 클릭(여전히 hang) → leftover_stopped(첫 pid) → 둘째 시한 → 안 돎 확인 → 둘째 pid 그룹 종료.
#  마지막 orphan-check 종료코드도 FAIL 에 더한다(r4 R4-03). L485_F9_LEAVE=1 이면 일부러 sleep 120 하나를 남겨 그 검사가 잡는지 본다(양성 대조).
#  양성 대조: L485_APP=<r4 태그 빌드> 면 ① 오류 중 카드 ok ② 첫 pid 가 남는다 → FAIL. 측정 뒤 남은 것은 직접 정리한다.
#  사용: [L485_APP=..] [L485_F9_LEAVE=1] sh scenario-f9.sh <ROOT>
ROOT=$1; . "$(dirname "$0")/lib.sh"
rm -rf "$ROOT"; sh "$H/iso-root.sh" "$ROOT" /tmp/l485i/zero.json || { echo "격리 루트 준비 실패 — 멈춘다"; exit 3; }
FK="$ROOT/fake"; mkdir -p "$FK"; cp "$H/fake-herdr.sh" "$FK/herdr"; chmod 755 "$FK/herdr"; echo hang > "$FK/fake-mode"
sh "$H/iso-app.sh" "$ROOT" "$APP" CORRAL_HERDR_BIN="$FK/herdr"
spawn_pids() { grep '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" | /usr/bin/python3 -c "import json,sys; print(' '.join(str(json.loads(l)['pid']) for l in sys.stdin))"; }
alive() { kill -0 "$1" 2>/dev/null && echo alive || echo gone; }
i=0; until grep -q '"tag":"herdr.server.spawn"' "$ROOT/corral.ndjson" 2>/dev/null; do i=$((i+1)); [ $i -gt 150 ] && break; sleep 0.2; done
HP=$(spawn_pids | awk '{print $1}')
echo "spawn pid $HP — 12초 뒤 session list 를 실패로"
sleep 12; echo fail > "$FK/fake-list"; echo "fake-list=fail $(date +%T)"
i=0; until grep -q '"tag":"backend.start.failed"' "$ROOT/corral.ndjson"; do i=$((i+1)); [ $i -gt 100 ] && break; sleep 0.2; done
check "시한 끝 마지막 조회 = 모름(probe unknown)" "$(grep '"tag":"backend.start.failed"' "$ROOT/corral.ndjson" | grep -c '"probe":"unknown"')" 1
check "그룹 종료 로그 없음" "$(grep -c '"tag":"herdr.server.stop_group"' "$ROOT/corral.ndjson")" 0
check "hang pid 생존(죽이지 않음)" "$(alive "$HP")" alive
echo "## ① 조회 오류 유지 6초 — 카드 표본 (F12)"
: > "$ROOT/samples.txt"; i=0
while [ $i -lt 12 ]; do st "d['backend']['kind'] + ' pid=' + str('pid $HP' in d['backend'].get('error','')) + ' scanErr=' + str(d.get('sessionsError') is not None)" >> "$ROOT/samples.txt"; i=$((i+1)); sleep 0.5; done
cat "$ROOT/samples.txt"
check "① 표본 동안 조회 오류가 이어졌다(sessionsError 12/12)" "$(grep -c 'scanErr=True$' "$ROOT/samples.txt")" 12
check "① 오류 중 표본 12개 모두 failed·원문 pid" "$(grep -c '^failed pid=True' "$ROOT/samples.txt")" 12
sh "$H/card.sh" "$ROOT" f9-failed-during-error
check "① 카드 버튼 「다시 시도」" "$(ctl '{"cmd":"eval","code":"Array.from(document.querySelectorAll(\"[data-backend-start]\")).map(b => b.innerText).join(\",\")"}' | /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin).get('result'))")" "다시 시도"
rm -f "$FK/fake-list"; echo "## ② 조회 회복 → 「다시 시도」 실제 클릭 (여전히 hang, F13)"
sleep 2
ctl '{"cmd":"click","selector":"[data-backend-start]"}' | cut -c1-160
i=0; until [ "$(spawn_pids | wc -w | tr -d ' ')" -ge 2 ]; do i=$((i+1)); [ $i -gt 50 ] && break; sleep 0.2; done
HP2=$(spawn_pids | awk '{print $2}'); echo "둘째 spawn pid $HP2"
sleep 0.5
check "② 다시 시도 전에 첫 pid 를 끝냈다(leftover_stopped)" "$(grep '"tag":"backend.start.leftover_stopped"' "$ROOT/corral.ndjson" | grep -c "\"pid\":$HP,")" 1
check "② 첫 pid 종료" "$(alive "$HP")" gone
T1=$(date +%s); i=0; until [ "$(grep -c '"tag":"backend.start.failed"' "$ROOT/corral.ndjson")" -ge 2 ]; do i=$((i+1)); [ $i -gt 120 ] && break; sleep 0.2; done; echo "둘째 시한 ($(( $(date +%s) - T1 ))초)"
grep -E '"tag":"(backend\.start[a-z._]*|herdr\.server\.[a-z._]*)"' "$ROOT/corral.ndjson" | cut -c1-300
check "② spawn 2회" "$(spawn_pids | wc -w | tr -d ' ')" 2
check "② 둘째는 안 돎 확인 → 그룹 종료" "$(sleep 0.5; alive "$HP2")" gone
app_stop
for p in $(spawn_pids); do kill "$p" 2>/dev/null && echo "측정 뒤 정리: $p"; done
LEFT=""; [ -n "${L485_F9_LEAVE:-}" ] && { sleep 120 & LEFT=$!; echo "## 양성 대조: 일부러 남긴 sleep 120 pid $LEFT"; }
sleep 0.5
L485_ORPHAN_EXTRA='[0-9] sleep 120$' sh "$H/orphan-check.sh" | tail -3; OC=$?
OC=$(L485_ORPHAN_EXTRA='[0-9] sleep 120$' sh "$H/orphan-check.sh" >/dev/null 2>&1; echo $?)
check "orphan-check exit" "$OC" 0
[ -n "$LEFT" ] && kill "$LEFT" && echo "양성 대조 sleep $LEFT 정리"
echo "FAIL=$FAIL"; exit $FAIL
