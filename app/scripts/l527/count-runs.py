# LIFE-527 — runs.md 의 「통과/실패」 칸 값을 센다(칸 값만 — 원자료를 훑지 않는다). 기준 항목 칸 첫 낱말별 합계도.
import re, collections, sys
path = sys.argv[1]
total = collections.Counter(); per = collections.defaultdict(collections.Counter)
for line in open(path):
    if not line.startswith('| R'): continue
    cells = re.split(r'(?<!\\)\|', line.strip())[1:-1]
    verdict = cells[6].strip(); crit = cells[1].strip()
    k = '통과' if verdict.startswith('통과') else '실패' if verdict.startswith('실패') else '미확정' if verdict.startswith('미확정') else '인용' if verdict.startswith('인용') else '?'
    total[k] += 1; per[crit.split(' ')[0]][k] += 1
# 「인용」 은 다른 행의 실행을 가리킨다 — 실행 행 수에서 뺀다(fix1 F5).
print('합계', dict(total), '실행 행', sum(v for k, v in total.items() if k != '인용'), '· 인용 행', total['인용'])
for key in sorted(per): print(key, dict(per[key]))
