# LIFE-527 fix2 H1 — runs.md: 판정표가 인용하는 행의 기준 라벨에 겸용 항목을 덧붙인다(행은 지우지 않는다 — fix1 R116 정정과 같은 방식)
# + fix2 회차를 R251 부터 덧붙인다(라운드를 넘겨 누적). 합계 그룹(첫 낱말)은 원래 라벨 그대로라 바뀌지 않는다.
# 실행: python3 app/scripts/l527/runs-fix2.py <runs.md> <fix2-rows.tsv>
import sys, re
path, extra = sys.argv[1], sys.argv[2]
DUAL = {  # 행 → 겸용 항목(판정표의 그 칸이 이 행을 근거로 인용한다)
  'R064': 'K2ⓑ', 'R144': 'K2ⓑ', 'R169': 'K1ⓐ', 'R048': 'K9ⓑ', 'R052': 'K5ⓔ',
  'R017': 'K2ⓓ·K3ⓐ', 'R018': 'K6ⓐ·K7ⓐ', 'R020': 'K2ⓐ·K3ⓐ·K7ⓐ', 'R039': 'K7ⓐ', 'R045': 'K8ⓓ',
}
lines = open(path).read().rstrip('\n').split('\n')
out, last = [], 0
for line in lines:
    m = re.match(r'\| (R\d{3}) \| ', line)
    if m:
        last = max(last, int(m.group(1)[1:]))
        if m.group(1) in DUAL:
            cells = re.split(r'(?<!\\)\|', line)
            if '겸용' not in cells[2]:
                cells[2] = cells[2].rstrip() + f' (겸용 {DUAL[m.group(1)]}) '
            line = '|'.join(cells)
    out.append(line)
assert last == 250, last
esc = lambda s: str(s).replace('|', '\\|')
rows = [tuple(r.split('\t')) for r in open(extra).read().split('\n') if r.strip() and not r.startswith('#')]
for i, (crit, cmd, want, got, raw, v) in enumerate(rows):
    out.append(f'| R{last + 1 + i:03d} | {esc(crit)} | {esc(cmd)} | {want} | {got} | {esc(raw)} | {esc(v)} |')
open(path, 'w').write('\n'.join(out) + '\n')
print('rows', last + len(rows))
