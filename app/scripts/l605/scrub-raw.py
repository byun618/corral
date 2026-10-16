#!/usr/bin/env python3
# LIFE-605 — raw 원자료에서 자격 모양 글을 지운다(가짜 자격이어도 — 킥오프 「raw 에는 이메일을 <email> 로」). 커밋 전에 회차 폴더마다 돌린다.
#   python3 -I scripts/l605/scrub-raw.py <폴더>…   → 바꾼 파일 수 · 남은 적중 수(0 이어야 exit 0)
# 지우는 것: ATATT 로 시작하는 토큰 → <token> · 이메일(@ 가 든 주소) → <email> · `Basic <base64>` → Basic <basic> · 가짜 자격의 base64(email:token) → <basic64>.
import base64, os, re, sys

FAKE = [('fixture-user@fixture.invalid', 'ATATTfixture0000000000000000000000000000jira'), ('second@fixture.invalid', 'ATATTsecond0000')]
B64 = [base64.b64encode(f'{email}:{token}'.encode()).decode() for email, token in FAKE]
RULES = [(re.compile(re.escape(value)), '<basic64>') for value in B64] + [
    (re.compile(r'Basic [A-Za-z0-9+/=]{12,}'), 'Basic <basic>'),
    (re.compile(r'ATATT[A-Za-z0-9+/=_-]*'), '<token>'),
    (re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:invalid|com|net|org|io|dev)'), '<email>'),
]
changed = 0
left = 0
for root in sys.argv[1:]:
    for folder, _, files in os.walk(root):
        for name in files:
            path = os.path.join(folder, name)
            try:
                text = open(path, encoding='utf-8').read()
            except (UnicodeDecodeError, OSError):
                continue
            out = text
            for pattern, repl in RULES:
                out = pattern.sub(repl, out)
            if out != text:
                open(path, 'w', encoding='utf-8').write(out)
                changed += 1
            left += sum(len(pattern.findall(out)) for pattern, _ in RULES[:len(B64)]) + len(re.findall(r'ATATT|@fixture\.invalid', out))
print(f'changed={changed} left={left}')
sys.exit(0 if left == 0 else 1)
