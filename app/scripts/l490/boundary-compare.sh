#!/bin/sh
# LIFE-490 K7ⓒ — `check:boundary` 대조. 기준 commit(87c08227) 도 위반이 있어(R4 wire-leak 7건 — 이 작업 전부터) 「통과」 를 exit 0 으로 볼 수 없다.
# 기준과 구현의 위반 목록(rule, file, tokens)을 비교해 새 위반이 있으면 exit 1, 없으면 0. 사용: sh boundary-compare.sh <worktree 루트>
W=$1; export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
B=/tmp/l490bnd-base; T=/tmp/l490bnd-out
rm -rf "$B" "$T" && mkdir -p "$B" "$T" && git -C "$W" archive 87c08227 app | tar -x -C "$B" && ln -s "$W/app/node_modules" "$B/app/node_modules"
(cd "$B/app" && node scripts/check-boundary.mjs > "$T/base.txt"); echo "base exit=$?"
(cd "$W/app" && node scripts/check-boundary.mjs > "$T/impl.txt"); echo "impl exit=$?"
/usr/bin/python3 - "$T" <<'PY'
import json,sys,re
t=sys.argv[1]
def load(p):
    text=open(p).read()
    # 출력 = 요약 객체 다음 위반 배열 — 둘째 JSON 값을 읽는다
    dec=json.JSONDecoder(); s,i=dec.raw_decode(text); rest=text[i:].lstrip()
    v=dec.raw_decode(rest)[0] if rest else []
    return s,{(x['rule'],x['file'],tuple(x.get('tokens',[]))) for x in v}
sa,a=load(t+'/base.txt'); sb,b=load(t+'/impl.txt')
print('base', sa, 'impl', sb)
new=sorted(b-a); gone=sorted(a-b)
for x in new: print('  신규', x)
for x in gone: print('  사라짐', x)
sys.exit(1 if new else 0)
PY
