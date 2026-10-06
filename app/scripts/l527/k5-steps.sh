#!/bin/zsh
# LIFE-527 K5 — OS 수준 입력 한 단계: 렌더러 이벤트 기록 비우기 → cliclick(os-act 안전 확인) → 관측(k5-observe.js) 한 줄(JSON) 을 out 에 덧붙인다.
# step.sh <port|ctl.sock 경로> <pid> <창 번호> <out.jsonl> <라벨> <cliclick 명령…>
# 종료코드(fix1 F3): 기록 비우기 실패 = 4 · act 거절·실패 = act 의 코드(거절 3) · 관측 실패 = 5 · 전부 성공 = 0.
#   실패해도 그 단계의 줄은 out 에 남긴다(exit·observeExit 칸). 일괄 수집하는 호출자는 각 단계 종료코드를 직접 처리한다.
cd /Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-527-titlebar-claude
S=app/scripts/l527
port=$1 pid=$2 win=$3 out=$4 label=$5; shift 5
if ! $S/ev.sh $port 'Object.assign(window, { __l527: [], __l527move: null }) && true' > /dev/null; then
  echo "{\"label\":$(printf '%s' "$label" | /usr/bin/python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"exit\":null,\"resetExit\":1}" >> $out
  echo "$label 기록 비우기 실패"; exit 4
fi
act=$($S/act.sh $pid $win "$label" "$@"); code=$?
sleep 0.8
seen=$($S/ev.sh $port "$(cat $S/k5-observe.js)"); observeCode=$?
echo "{\"label\":$(printf '%s' "$label" | /usr/bin/python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'),\"exit\":$code,\"observeExit\":$observeCode,\"act\":${act:-null},\"seen\":${seen:-null}}" >> $out
echo "$label exit=$code observe=$observeCode act=$act"
echo "  seen=$seen" | cut -c1-900
[ $code -ne 0 ] && exit $code
[ $observeCode -ne 0 ] && exit 5
exit 0
