# LIFE-527 K1 — OS 창 캡처(screencapture -l)에서 신호등 세 원의 위치를 찾는다(활성·비활성 둘 다).
# 위 띠(y 2..34pt)·왼쪽(x 4..80pt) 안에서 배경(띠 x 78pt·y 3pt 픽셀)과 채널 차가 24 넘는 픽셀을 모아 x 로 이어진 덩어리 3개로 나눈다.
# 각 덩어리의 bbox(pt) 와 중심. 배율 = 캡처 px / 창 폭 pt.
# 실행: python3 traffic-lights.py <png> <창 폭 pt>
import json, sys
from PIL import Image
path, width_pt = sys.argv[1], float(sys.argv[2])
img = Image.open(path).convert('RGB')
s = img.width / width_pt
bg = img.getpixel((int(78 * s), int(3 * s)))
cols = {}
for y in range(int(2 * s), int(34 * s)):
    for x in range(int(4 * s), int(80 * s)):
        p = img.getpixel((x, y))
        if max(abs(p[i] - bg[i]) for i in range(3)) > 24:
            cols.setdefault(x, []).append(y)
blobs, cur = [], []
for x in sorted(cols):
    if cur and x != cur[-1] + 1: blobs.append(cur); cur = []
    cur.append(x)
if cur: blobs.append(cur)
out = {'path': path, 'scale': s, 'bg': bg, 'blobs': []}
for b in blobs:
    ys = [y for x in b for y in cols[x]]
    x0, x1, y0, y1 = b[0], b[-1] + 1, min(ys), max(ys) + 1
    out['blobs'].append({'x0': round(x0 / s, 2), 'w': round((x1 - x0) / s, 2), 'y0': round(y0 / s, 2), 'h': round((y1 - y0) / s, 2), 'cx': round((x0 + x1) / 2 / s, 2), 'cy': round((y0 + y1) / 2 / s, 2), 'color': img.getpixel(((x0 + x1) // 2, (y0 + y1) // 2))})
print(json.dumps(out))
