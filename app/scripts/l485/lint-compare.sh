#!/bin/sh
# LIFE-485 K7ⓒ — eslint 신규 위반 0 판정: 기준선(41e27696 의 app 을 /tmp/l485-base 에 풀어 같은 node_modules 로)과 구현의 (파일, 규칙, 메시지) 집합 차.
# 신규가 있으면 exit 1, 없으면 0. 핵심 5파일 중 검사되지 않은 것이 있으면 exit 2(fix3 R3-05). eslint 가 json 을 못 썼으면(설정·파싱 실패 등) exit 2 —
# eslint 자체의 exit 1 은 위반이 있다는 뜻이라 정상 경로로 둔다 (r2 R2-05: 지난 json 을 읽어 통과하던 구멍). 사용: sh lint-compare.sh <worktree 루트> [구현 app 디렉터리 — 양성 대조용, 기본 <worktree>/app]
W=$1; IMPL=${2:-$W/app}; export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
rm -rf /tmp/l485-base && mkdir -p /tmp/l485-base && git -C "$W" archive 41e27696 app | tar -x -C /tmp/l485-base && ln -s "$W/app/node_modules" /tmp/l485-base/app/node_modules
rm -f /tmp/l485t/lint-base.json /tmp/l485t/lint-impl.json
(cd /tmp/l485-base/app && npx eslint . -f json -o /tmp/l485t/lint-base.json); (cd "$IMPL" && npx eslint . -f json -o /tmp/l485t/lint-impl.json)
for j in /tmp/l485t/lint-base.json /tmp/l485t/lint-impl.json; do [ -s "$j" ] || { echo "eslint 가 $j 를 쓰지 않았다"; exit 2; }; done
/usr/bin/python3 - "$IMPL" <<'PY'
import json,sys
from collections import Counter
# fix3 (r3 R3-05): 집합 포함이 아니라 개수 비교 — 같은 (파일, 규칙, 메시지) 위반이 하나 늘어도 신규로 센다
def load(p,root):
    return {f['filePath'].split(root)[-1]: Counter((m.get('ruleId') or '', m['message']) for m in f['messages']) for f in json.load(open(p))}
a=load('/tmp/l485t/lint-base.json','/tmp/l485-base/app/'); b=load('/tmp/l485t/lint-impl.json', sys.argv[1].rstrip('/')+'/')
new=[(f,m,n-a.get(f,Counter())[m]) for f in b for m,n in b[f].items() if n>a.get(f,Counter())[m]]
print('base', sum(sum(c.values()) for c in a.values()), 'impl', sum(sum(c.values()) for c in b.values()), '신규', sum(x[2] for x in new), new[:5])
core=['src/main/adapter/internal/server.ts','src/main/backend-start.ts','src/renderer/src/components/BackendCard.tsx','src/main/adapter/internal/server.test.ts','src/main/backend-start.test.ts']
missing=[f for f in core if f not in b]
for f in core: print(f, '검사됨' if f in b else '없음', sum(b.get(f,Counter()).values()))
# 핵심 파일이 검사 대상에 없으면 「신규 0」 은 근거가 아니다 — 판정 불가 exit 2
if missing: print('핵심 파일 미검사:', missing); sys.exit(2)
sys.exit(1 if new else 0)
PY
