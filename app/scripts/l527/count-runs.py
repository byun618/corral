# LIFE-527 — runs.md 의 「통과/실패」 칸 값을 센다(칸 값만 — 원자료를 훑지 않는다). 기준 항목 칸 첫 낱말별 합계도.
import re, collections, sys
path = sys.argv[1]
total = collections.Counter(); per = collections.defaultdict(collections.Counter)
for line in open(path):
    if not line.startswith('| R'): continue
    cells = re.split(r'(?<!\\)\|', line.strip())[1:-1]
    verdict = cells[6].strip(); crit = cells[1].strip()
    k = '통과' if verdict.startswith('통과') else '실패' if verdict.startswith('실패') else '미확정' if verdict.startswith('미확정') else '?'
    total[k] += 1; per[crit.split(' ')[0]][k] += 1
print('합계', dict(total), '행', sum(total.values()))
for key in sorted(per): print(key, dict(per[key]))
