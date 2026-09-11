"""UAX #11 의 Wide·Fullwidth 구간을 뽑아 `src/shared/width.ts` 의 표로 찍는다.

손으로 적은 성긴 범위표가 ⌚⏰⭐ 같은 BMP wide 기호를 1칸으로 세던 자리를 닫는다
(2회차 리뷰 G4 — 과소는 글자를 자른다). 표를 고칠 일이 생기면 이 스크립트를 다시 돌린다.

    python3 scripts/l345/gen-width-table.py            # TS 블록을 표준출력에

파이썬 `unicodedata` 의 유니코드 판(16.0.0 기준)이 곧 이 표의 판이다 — 머리말에 박아 둔다.
"""

import unicodedata

ranges = []
start = None
prev = None
for cp in range(0x110000):
    if unicodedata.east_asian_width(chr(cp)) in ("W", "F"):
        if start is None:
            start = cp
        prev = cp
    elif start is not None:
        ranges.append((start, prev))
        start = None
if start is not None:
    ranges.append((start, prev))

print(f"// unicodedata {unicodedata.unidata_version} · 구간 {len(ranges)}개")
print("const WIDE_RANGES = [")
for index in range(0, len(ranges), 4):
    chunk = ranges[index : index + 4]
    body = " ".join(f"0x{a:x}, 0x{b:x}," for a, b in chunk)
    print(f"  {body}")
print("]")
