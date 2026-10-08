# LIFE-566 — 조합 중 측정(JSON)·스크린샷과 확정 뒤 측정을 맞대어 C2ⓐⓑⓒ·C3 수치와 합불을 낸다.
# 사용: python3 judge.py [--cursor #rrggbb] <raw 폴더> <조합 중 이름> <확정 뒤 이름 | -> [<스크린샷 이름>...]
#   --cursor: 테마 커서 색. 없으면 측정의 caret(::after) 배경색을 쓴다(수정본). 기준선은 caret 이 없어 반드시 준다.
#   확정 뒤 이름이 `-` 면 C2ⓑ 를 건너뛴다(기준선 양성 대조처럼 확정 뒤 측정이 없는 경우).
# 종료코드: 판정한 항목 중 하나라도 실패면 1.
#
# r1 F1 — caret x 는 가정하지 않는다: ① DOM — 측정의 `caret`(조합 상자 ::after 계산값) ② 픽셀 — 스크린샷 그 줄에서 caret 색 열을 찾는다.
#          둘 다 내고, C2ⓐⓑ 는 DOM 값으로 판정한다(없으면 픽셀 값). 둘이 0.5 device px 넘게 다르면 `caret_dom_vs_px_mismatch` 로 드러낸다.
# r1 F2 — C2ⓒ 자동 합불: 창 = 커서 칸 왼쪽 경계 ±2 CSS px 의 device 열 중 **조합 상자 왼쪽 밖**(열 < round(상자 left × dpr)).
#          그 열들의 셀 높이 픽셀 중 배경과 대비 1.5 이상(커서색·글자색 — 배경이 아닌 것)이 하나라도 있으면 실패.
#          배경은 같은 줄 화면 오른쪽 끝 근처(빈 칸)에서 뽑는다. → `C2c_strict_pass` (r1 명세 그대로)
# 최종 관문 보강 — 엄격 규칙은 앞 글자 글리프가 칸 끝까지 그려지면(밝은 테마 `y` 의 사선) 그것도 잡는다(위양성, final/fix c3-light).
#          기준 C2ⓒ 문구 "커서색 세로선" 에 맞춘 `C2c_bar_pass`: 창 열 중 셀 높이의 50% 이상이 커서색(채널 차 ≤ 48)이고 배경 대비 ≥1.5 인 열이 있으면 실패.
#          `C2c_pass` = 세로선 규칙. 둘 다 출력하고 종료코드는 세로선 규칙으로 낸다. 기준선 양성 대조는 두 규칙 모두 실패해야 한다.
import json, math, sys
from PIL import Image

args = sys.argv[1:]
cursor_hex = None
if args[0] == '--cursor':
  cursor_hex = args[1]; args = args[2:]
raw, comp, after, *shots = args
m = json.load(open(f'{raw}/{comp}.json'))
a = json.load(open(f'{raw}/{after}.json')) if after != '-' else None
dpr = m['dpr']
view = m['compositionView']['rect']; text = m['compositionView']['textRange']; st = m['compositionView']['style']
cur = m['cursor'][0]['rect'] if m['cursor'] else None
after_cur = a['cursor'][0]['rect'] if a and a['cursor'] else None
screen = m['screen']

def parse_rgb(css):
  if not css or not css.startswith('rgb'): return None
  parts = css[css.index('(') + 1:css.index(')')].split(',')
  return tuple(int(float(p)) for p in parts[:3])

def lum(c):
  def ch(v):
    v = v / 255
    return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])

def contrast(x, y):
  a1, b1 = lum(x), lum(y)
  return (max(a1, b1) + 0.05) / (min(a1, b1) + 0.05)

caret = m.get('caret')
caret_dom = caret['left'] if caret else None
caret_rgb = parse_rgb(caret['backgroundColor']) if caret else None
cursor_rgb = tuple(int(cursor_hex[i:i + 2], 16) for i in (1, 3, 5)) if cursor_hex else caret_rgb
fails = []
out = {
  'dpr': dpr, 'hasFocus': m['hasFocus'], 'xtermFocusClass': m.get('xtermFocusClass'), 'xtermClasses': m.get('xtermClasses'),
  'cursor_classes': [c['cls'] for c in m['cursor']], 'composing_text': m['compositionView']['text'],
  'box_left': view['left'], 'box_right': view['right'], 'glyph_right': text['right'] if text else None,
  'cursor_cell_left_during': cur['left'] if cur else None,
  'box_left_minus_cursor_left': (view['left'] - cur['left']) if cur else None,
  'caret_dom': caret, 'caret_x_dom': caret_dom,
  'box_bg': st['background-color'], 'box_fg': st['color'], 'underline': st['text-decoration-line'],
  'after_commit_cursor_left': after_cur['left'] if after_cur else None,
  'after_commit_active': a['compositionView']['active'] if a else None,
}

for name in shots:
  im = Image.open(f'{raw}/{name}.png').convert('RGB')
  y_mid = int((view['top'] + view['height'] / 2) * dpr)
  bg = im.getpixel((int((screen['right'] - 3) * dpr), y_mid))
  res = {'bg_sample': '%02x%02x%02x' % bg}
  # ② 픽셀 caret — 상자 오른쪽 끝 −3..+4 CSS px 안에서 caret 색(없으면 배경 대비 3 이상) 열의 첫 x
  caret_px = None
  if caret_rgb is not None or caret is None:
    for x in range(int((view['right'] - 3) * dpr), int((view['right'] + 4) * dpr) + 1):
      p = im.getpixel((x, y_mid))
      hit = (max(abs(p[i] - caret_rgb[i]) for i in range(3)) <= 24) if caret_rgb else False
      if hit:
        caret_px = x / dpr
        break
  res['caret_x_px'] = caret_px
  if caret_dom is not None and caret_px is not None:
    res['caret_dom_vs_px'] = caret_px - caret_dom
    res['caret_dom_vs_px_mismatch'] = abs(caret_px - caret_dom) * dpr > 1.0
  # ③ C2ⓒ — 상자 왼쪽 밖, 커서 칸 왼쪽 ±2px
  if cur is not None:
    x_lo = math.floor((cur['left'] - 2) * dpr); x_hi = math.ceil((cur['left'] + 2) * dpr)
    box_dev = round(view['left'] * dpr)
    cols = [x for x in range(x_lo, x_hi) if x < box_dev]
    hits = []
    for x in cols:
      for y in range(int(view['top'] * dpr) + 1, int(view['bottom'] * dpr) - 1):
        p = im.getpixel((x, y))
        if contrast(p, bg) >= 1.5:
          hits.append({'x': x, 'y': y, 'px': '%02x%02x%02x' % p, 'contrast': round(contrast(p, bg), 2)})
    res['C2c_window_cols'] = cols
    res['C2c_hits'] = hits[:12]
    res['C2c_hit_count'] = len(hits)
    res['C2c_strict_pass'] = len(hits) == 0
    # 세로선 규칙 — 열마다 커서색 픽셀 비율
    ys = list(range(int(view['top'] * dpr) + 1, int(view['bottom'] * dpr) - 1))
    bars = []
    if cursor_rgb is not None:
      for x in cols:
        n = sum(1 for y in ys if max(abs(im.getpixel((x, y))[i] - cursor_rgb[i]) for i in range(3)) <= 48 and contrast(im.getpixel((x, y)), bg) >= 1.5)
        if n >= 0.5 * len(ys): bars.append({'x': x, 'cursor_px': n, 'of': len(ys)})
    res['cursor_color_used'] = '%02x%02x%02x' % cursor_rgb if cursor_rgb else None
    res['C2c_bar_cols'] = bars
    res['C2c_pass'] = (len(bars) == 0) if cursor_rgb is not None else None
    if res['C2c_pass'] is False: fails.append(f'C2c:{name}')
    if res['C2c_pass'] is None: fails.append(f'C2c-no-cursor-color:{name}')
  # 상자 테두리 안 픽셀(C3ⓐ 픽셀 대조) — 상자 오른쪽 끝 바로 안 1열(글리프가 없는 자리)
  res['box_inner_px'] = '%02x%02x%02x' % im.getpixel((int((view['right'] - 1.5) * dpr), int((view['top'] + 2) * dpr)))
  out[f'pixels:{name}'] = res

caret_x = caret_dom
if caret_x is None:
  for name in shots:
    if out[f'pixels:{name}']['caret_x_px'] is not None:
      caret_x = out[f'pixels:{name}']['caret_x_px']; break
out['caret_x_used'] = caret_x
if caret_x is not None and text is not None:
  out['C2a_pass'] = caret_x >= text['right']
  if not out['C2a_pass']: fails.append('C2a')
else:
  out['C2a_pass'] = None
if caret_x is not None and after_cur is not None:
  out['C2b_caret_minus_after_cursor'] = caret_x - after_cur['left']
  out['C2b_pass'] = abs(caret_x - after_cur['left']) <= 1.0
  if not out['C2b_pass']: fails.append('C2b')
else:
  out['C2b_pass'] = None
out['fails'] = fails
print(json.dumps(out, indent=1, ensure_ascii=False))
sys.exit(1 if fails else 0)
