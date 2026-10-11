# LIFE-582 최종 관문 Z9 — 서버가 내는 실패 사유 코드(app input.ts) ↔ 폰 문구 표(mobile input.ts REASON·STOP_REASON·ANSWER_REASON) ↔ SURFACE.md 언급 대조.
import re, sys
srv = open('app/src/main/mobile/input.ts', encoding='utf-8').read()
mob = open('mobile/src/core/input.ts', encoding='utf-8').read()
surf = open('app/src/main/mobile/SURFACE.md', encoding='utf-8').read()
codes = set(re.findall(r"(?:settle\([^,]+,\s*'(?:failed|unconfirmed|stopped)',\s*|fail\([^,]+,\s*|stop\(|reason:\s*)'([a-z_]+)'", srv))
codes |= set(re.findall(r"\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'", srv) and [c for pair in re.findall(r"\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'", srv) for c in pair])
def table(name):
    m = re.search(r'const ' + name + r': Record<string, string> = \{(.*?)\n\}', mob, re.S)
    return set(re.findall(r'^\s*([a-z_]+):', m.group(1), re.M))
reason, stop, answer = table('REASON'), table('STOP_REASON'), table('ANSWER_REASON')
phone = reason | stop | answer | {'answer_mismatch'}
bad = 0
for c in sorted(codes):
    inPhone = c in phone
    inSurf = re.search(r'`' + c + r'`|\b' + c + r'\b', surf) is not None
    if not inPhone or not inSurf: bad += 1
    print(f"{c:22} 폰문구={'O' if inPhone else 'X'} SURFACE={'O' if inSurf else 'X'}")
print(f"서버 사유 {len(codes)} · 빠짐 {bad}")
sys.exit(1 if bad else 0)
