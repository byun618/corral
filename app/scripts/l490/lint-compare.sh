#!/bin/sh
# LIFE-490 K7ⓒ — eslint 「새 위반 0」 판정. 기준 commit(87c08227) 의 app 을 /tmp/l490lint-base 에 풀어 같은 node_modules 로 돌리고
# (파일, 규칙, 메시지) 개수를 구현과 비교한다(l485/lint-compare.sh 방식). 신규가 있으면 exit 1, 없으면 0.
# 이 작업이 바꾼 파일 중 검사되지 않은 것이 있으면 exit 2 — 검사 밖 파일의 「신규 0」 은 근거가 아니다. eslint 가 json 을 못 쓰면 exit 2.
# 사용: sh lint-compare.sh <worktree 루트>
W=$1; IMPL=$W/app; export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
B=/tmp/l490lint-base; T=/tmp/l490lint-out
rm -rf "$B" "$T" && mkdir -p "$B" "$T" && git -C "$W" archive 87c08227 app | tar -x -C "$B" && ln -s "$IMPL/node_modules" "$B/app/node_modules"
(cd "$B/app" && npx eslint . -f json -o "$T/base.json"); (cd "$IMPL" && npx eslint . -f json -o "$T/impl.json")
for j in "$T/base.json" "$T/impl.json"; do [ -s "$j" ] || { echo "eslint 가 $j 를 쓰지 않았다"; exit 2; }; done
CHANGED=$(git -C "$W" diff --name-only 87c08227 -- app/src app/scripts/l490 | grep -E '\.(ts|tsx|mjs|js)$' | sed 's#^app/##')
/usr/bin/python3 - "$IMPL" "$B/app" "$T" "$CHANGED" <<'PY'
import json,sys
from collections import Counter
impl,base,t,changed=sys.argv[1],sys.argv[2],sys.argv[3],[c for c in sys.argv[4].split('\n') if c]
def load(p,root):
    return {f['filePath'].split(root.rstrip('/')+'/')[-1]: Counter((m.get('ruleId') or '', m['message']) for m in f['messages']) for f in json.load(open(p))}
a=load(t+'/base.json',base); b=load(t+'/impl.json',impl)
new=[(f,m,n-a.get(f,Counter())[m]) for f in b for m,n in b[f].items() if n>a.get(f,Counter())[m]]
print('base', sum(sum(c.values()) for c in a.values()), 'impl', sum(sum(c.values()) for c in b.values()), '신규', sum(x[2] for x in new))
for x in new: print('  신규', x)
missing=[f for f in changed if f not in b]
for f in changed: print(f, '검사됨' if f in b else '없음', sum(b.get(f,Counter()).values()))
if missing: print('바뀐 파일 미검사:', missing); sys.exit(2)
sys.exit(1 if new else 0)
PY
