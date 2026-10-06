# LIFE-526 K2ⓒⓓ — before↔after 회차의 sidebar diff 를 단위별로 대조해 md 표로 낸다.
# 사용: python3 k2-diff.py <before 회차 폴더> <after 회차 폴더> <상태> [<before-units 회차 폴더>]
import json, sys, os
from collections import Counter
before, after, state = sys.argv[1], sys.argv[2], sys.argv[3]
units_dir = sys.argv[4] if len(sys.argv) > 4 else None
load = lambda d, n: json.load(open(os.path.join(d, n), encoding='utf8'))
def rows(d):
    diff = load(d, f'sidebar-{state}-diff.json')
    out = Counter()
    det = {}
    for f in diff['findings']:
        key = (f['id'], f['kind'], f.get('index', 0))
        out[f['id']] += 1
        det.setdefault(f['id'], []).append(f)
    return diff['summary'], out, det
def fmt(fs):
    parts = []
    for f in fs:
        d = f['detail']
        if isinstance(d, list):
            parts.append(f"{f['kind']}" + (f"[{f['index']}]" if f.get('index') else '') + ': ' + ', '.join(f"{x['prop']} {x.get('left')}→{x.get('right')}" for x in d))
        else:
            parts.append(f"{f['kind']}: {d.get('left')} / {d.get('right')}")
    return '<br>'.join(parts)
bs, bc, bd = rows(before)
as_, ac, ad = rows(after)
self_b = [load(before, f'sidebar-{state}-{a}-selfdiff.json') for a in ('orca', 'corral')]
self_a = [load(after, f'sidebar-{state}-{a}-selfdiff.json') for a in ('orca', 'corral')]
cnt = lambda s: f"{len(s['atTolerance']['findings']) if 'findings' in s['atTolerance'] else s['atTolerance'].get('summary',{}).get('total','?')}"
print(f'# K2 before↔after — sidebar/{state}\n')
print(f'- before: `{os.path.relpath(before)}` · after: `{os.path.relpath(after)}`')
print(f'- 전체 차이: before {bs["total"]} → after {as_["total"]}')
print(f'- 자기 diff 잡음(허용치 기준, orca/corral): before {cnt(self_b[0])}/{cnt(self_b[1])} → after {cnt(self_a[0])}/{cnt(self_a[1])}\n')
ids = list(dict.fromkeys(list(bc) + list(ac)))
foot = [i for i in ids if i.startswith('sidebar-footer')]
other = [i for i in ids if not i.startswith('sidebar-footer')]
print('## 하단 바 밖 단위 (U4 — 차이 수가 늘면 안 된다)\n')
print('| 단위 | before 행 수 | after 행 수 | 변화 | after 내용 |\n| --- | --- | --- | --- | --- |')
tb = ta = 0
for i in other:
    tb += bc[i]; ta += ac[i]
    ch = '같음' if bc[i] == ac[i] else ('늘어남' if ac[i] > bc[i] else '줄어듦')
    same = fmt(bd.get(i, [])) == fmt(ad.get(i, []))
    print(f'| {i} | {bc[i]} | {ac[i]} | {ch} | {"값까지 before 와 같다" if same else fmt(ad.get(i, [])) + " (before: " + fmt(bd.get(i, [])) + ")"} |')
print(f'| **합계** | **{tb}** | **{ta}** | {"같음" if tb==ta else ("늘어남" if ta>tb else "줄어듦")} | |\n')
print('## 하단 바 단위\n')
print('| 단위 | before 내용 | after 내용 |\n| --- | --- | --- |')
for i in foot:
    print(f'| {i} | {fmt(bd.get(i, [])) or "차이 없음"} | {fmt(ad.get(i, [])) or "차이 없음"} |')
if units_dir:
    print(f'\n## 하단 바 단위 — 같은 새 단위 정의로 잰 before 빌드 (`{os.path.relpath(units_dir)}`, 관문 미달: before 에는 묶음·svg 가 없어 선택자 0개 — 값 참고용)\n')
    ud = load(units_dir, f'sidebar-{state}-diff.json')
    print('| 단위 | before 빌드 내용 |\n| --- | --- |')
    for f in ud['findings']:
        if f['id'].startswith('sidebar-footer'):
            print(f'| {f["id"]} | {fmt([f])} |')
