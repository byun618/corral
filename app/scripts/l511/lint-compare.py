# LIFE-511 K8ⓐ lint 판정(코디 판정 「기준 대비 새 오류 0」) — 기준·HEAD eslint -f json 원자료를 파일·규칙·메시지 다중집합으로 견준다.
# 사용: python3 lint-compare.py <기준 원자료> <기준 app 루트> <HEAD 원자료> <HEAD app 루트> <git diff --name-status 기준..HEAD -- app 출력> <기준 run> <HEAD run>
import json, os, sys
from collections import Counter

def load(path, root):
    text = open(path).read()
    arr = json.loads(text[text.index('\n[') + 1:text.rindex(']') + 1])
    return {os.path.relpath(os.path.realpath(f['filePath']), os.path.realpath(root)): [(m.get('ruleId'), m.get('message')) for m in f['messages'] if m.get('severity') == 2] for f in arr}

base_raw, base_root, head_raw, head_root, changed_file, base_run, head_run = sys.argv[1:8]
base, head = load(base_raw, base_root), load(head_raw, head_root)
bc = {k: len(v) for k, v in base.items() if v}
hc = {k: len(v) for k, v in head.items() if v}
touched = {}
for line in open(changed_file).read().splitlines():
    parts = line.split('\t')
    status, rel = parts[0], parts[-1].removeprefix('app/')
    if not rel.endswith(('.ts', '.tsx', '.mjs', '.js', '.cjs')):
        continue
    touched[rel] = {'status': status, 'base': None if status.startswith('A') else bc.get(rel, 0), 'head': None if status == 'D' else hc.get(rel, 0)}
rb = Counter((k, r, m) for k, v in base.items() for r, m in v)
rh = Counter((k, r, m) for k, v in head.items() for r, m in v)
only_base, only_head = list((rb - rh).elements()), list((rh - rb).elements())
added_with_errors = {k: v for k, v in touched.items() if v['status'].startswith('A') and (v['head'] or 0) > 0}
grew = {k: v for k, v in touched.items() if v['base'] is not None and v['head'] is not None and v['head'] > v['base']}
deleted_had = {k: v for k, v in touched.items() if v['status'] == 'D' and (v['base'] or 0) > 0}
verdict = {
    '①원자료': {'base': {'run': base_run, 'errors': sum(bc.values()), 'filesWithErrors': len(bc), 'perFile': bc}, 'head': {'run': head_run, 'errors': sum(hc.values()), 'filesWithErrors': len(hc), 'perFile': hc}},
    '②차이(파일·규칙·메시지)': {'onlyBase': only_base, 'onlyHead': only_head, 'empty': not only_base and not only_head},
    '③손댄 파일': {'touched': touched, 'addedWithErrors': added_with_errors, 'grew': grew, 'deletedThatHadErrors': deleted_had},
}
verdict['pass'] = not only_head and not added_with_errors and not grew
print(json.dumps(verdict, ensure_ascii=False, indent=2))
