# LIFE-566 — 조합 중 측정(JSON)·스크린샷과 확정 뒤 측정을 맞대어 C2ⓐⓑⓒ·C3ⓐⓑⓒ 수치를 낸다. 판정 보조(빠른 확인), 최종 관문 아님.
# 사용: python3 judge.py <raw 폴더> <조합 중 이름> <확정 뒤 이름> [<스크린샷 이름>...]
import json, sys
from PIL import Image

raw, comp, after, *shots = sys.argv[1:]
m = json.load(open(f'{raw}/{comp}.json'))
a = json.load(open(f'{raw}/{after}.json'))
dpr = m['dpr']
view = m['compositionView']['rect']; text = m['compositionView']['textRange']; st = m['compositionView']['style']
cur = m['cursor'][0]['rect'] if m['cursor'] else None
after_cur = a['cursor'][0]['rect'] if a['cursor'] else None
caret_x = view['right']  # ::after 는 left:100% — 상자 오른쪽 끝에서 시작
out = {
  'dpr': dpr, 'hasFocus': m['hasFocus'], 'composing_text': m['compositionView']['text'],
  'box_left': view['left'], 'box_right': view['right'], 'glyph_right': text['right'] if text else None,
  'cursor_cell_left_during': cur['left'] if cur else None,
  'caret_x': caret_x,
  'after_commit_cursor_left': after_cur['left'] if after_cur else None,
  'C2a_caret_after_glyph': text is not None and caret_x >= text['right'],
  'C2b_caret_minus_after_cursor': (caret_x - after_cur['left']) if after_cur else None,
  'box_left_minus_cursor_left': (view['left'] - cur['left']) if cur else None,
  'box_bg': st['background-color'], 'box_fg': st['color'], 'underline': st['text-decoration-line'],
  'after_commit_active': a['compositionView']['active'],
}
for name in shots:
  im = Image.open(f'{raw}/{name}.png').convert('RGB')
  y = int((view['top'] + view['height'] / 2) * dpr)
  x0 = int(cur['left'] * dpr) if cur else int(view['left'] * dpr)
  # C2ⓒ — 상자 앞쪽(커서 칸 왼쪽 경계 ±2px)에 커서색 세로선이 있나: 그 열들의 픽셀
  front = ['%02x%02x%02x' % im.getpixel((x, y)) for x in range(x0 - int(2 * dpr), x0 + int(2 * dpr) + 1)]
  cx = int(round(caret_x * dpr))
  caret_px = ['%02x%02x%02x' % im.getpixel((x, y)) for x in range(cx - 1, cx + int(2 * dpr) + 1)]
  out[f'pixels:{name}'] = {'y': y, 'front_x0': x0 - int(2 * dpr), 'front': front, 'caret_x0': cx - 1, 'caret': caret_px}
print(json.dumps(out, indent=1, ensure_ascii=False))
