# LIFE-526 U1 — 측정 도구 캡처(PNG)의 하단 바 줄에서 글리프·아이콘 잉크 상자를 픽셀로 잰다.
# 잉크 = 줄 배경색(줄 왼쪽 끝 픽셀)과 채널 차이 합이 THRESH 넘는 픽셀. 테두리 1px 줄은 뺀다.
# 사용: python3 u1-ink.py <png> <줄 y(테두리 포함)> <줄 h> [이름]
import sys
from PIL import Image
png, y0, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
THRESH = 60
im = Image.open(png).convert('RGB')
W = im.width
bg = im.getpixel((2, y0 + h // 2))
ink = lambda p: sum(abs(a - b) for a, b in zip(p, bg)) > THRESH
cols = []
for x in range(W):
    ys = [y for y in range(y0 + 1, y0 + h) if ink(im.getpixel((x, y)))]
    cols.append(ys)
groups, cur = [], None
for x, ys in enumerate(cols):
    if ys:
        if cur and x - cur['x1'] <= 2:
            cur['x1'] = x; cur['y0'] = min(cur['y0'], min(ys)); cur['y1'] = max(cur['y1'], max(ys))
        else:
            cur = {'x0': x, 'x1': x, 'y0': min(ys), 'y1': max(ys)}; groups.append(cur)
print(f'# {sys.argv[4] if len(sys.argv) > 4 else png} — 배경 {bg} · 줄 y {y0} h {h} · 임계 {THRESH}')
for i, g in enumerate(groups):
    print(f'잉크#{i}: x {g["x0"]}..{g["x1"]} (w {g["x1"] - g["x0"] + 1}) · y {g["y0"]}..{g["y1"]} (h {g["y1"] - g["y0"] + 1})')
