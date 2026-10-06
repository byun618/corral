#!/bin/sh
# LIFE-485 K7ⓒ — eslint 신규 위반 0 판정: 기준선(41e27696 의 app 을 /tmp/l485-base 에 풀어 같은 node_modules 로)과 구현의 (파일, 규칙, 메시지) 집합 차.
# 신규가 있으면 exit 1, 없으면 0. 사용: sh lint-compare.sh <worktree 루트>
W=$1; export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
rm -rf /tmp/l485-base && mkdir -p /tmp/l485-base && git -C "$W" archive 41e27696 app | tar -x -C /tmp/l485-base && ln -s "$W/app/node_modules" /tmp/l485-base/app/node_modules
(cd /tmp/l485-base/app && npx eslint . -f json -o /tmp/l485t/lint-base.json); (cd "$W/app" && npx eslint . -f json -o /tmp/l485t/lint-impl.json)
/usr/bin/python3 - "$W" <<'PY'
import json,sys
def load(p,root):
    return {f['filePath'].split(root)[-1]: sorted((m.get('ruleId') or '', m['message']) for m in f['messages']) for f in json.load(open(p))}
a=load('/tmp/l485t/lint-base.json','/tmp/l485-base/app/'); b=load('/tmp/l485t/lint-impl.json', sys.argv[1].rstrip('/')+'/app/')
new=[(f,m) for f in b for m in b[f] if m not in a.get(f,[])]
print('base', sum(map(len,a.values())), 'impl', sum(map(len,b.values())), '신규', len(new), new[:5])
for f in ['src/main/adapter/internal/server.ts','src/main/backend-start.ts','src/renderer/src/components/BackendCard.tsx','src/main/adapter/internal/server.test.ts','src/main/backend-start.test.ts']: print(f, '검사됨' if f in b else '없음', len(b.get(f,[])))
sys.exit(1 if new else 0)
PY
