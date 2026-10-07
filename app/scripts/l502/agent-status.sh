#!/bin/sh
# LIFE-502 K4 — l490/agent-status.sh 복사(l490→l502·L490→L502·worktree 이름만 sed 로 바꿈, 그 밖 변경은 아래 「L502 변경」 줄). 아래는 원 주석.
# LIFE-490 K8 — l485/agent-status.sh 복사(코드 줄의 l485→l502·L485→L502·ROOT 꼴 /tmp/l502n*·이 worktree 경로만 바꿈, 주석 줄은 원문). 아래는 원 주석.
# LIFE-485 K8ⓑ — `herdr agent list`(설치 default)에서 종류·상태 칸만 뽑는다(경로·세션 id·제목 미기록).
/opt/homebrew/bin/herdr agent list | /usr/bin/python3 -c "
import json,sys
d=json.load(sys.stdin); a=d.get('result',{}).get('agents',[])
keep=('agent','kind','status','state','agent_status')
print(json.dumps({'count':len(a),'agents':[{k:v for k,v in x.items() if k in keep} for x in a],'keys_seen':sorted({k for x in a for k in x})},ensure_ascii=False))"
