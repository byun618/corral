# LIFE-566 최종 관문 — C4ⓒ(줄 가운데: 조합 상자·caret 이 가리는 글자 칸 수)·C4ⓓ(마지막 열: 상자·caret 이 화면/pane 안에 있나)·C3(색) 수치.
# 사용: python3 judge-extra.py <raw 폴더> <측정 이름> <mode: mid|edge|color>
#   mid  : 커서 칸부터 오른쪽으로 칸 k 를 [커서 left + k·칸폭, +칸폭] 로 두고, 상자(불투명 배경) 와 1 CSS px 넘게 겹치는 칸 수. caret(1px 막대)은 따로 센다.
#   edge : 상자 right·caret right ≤ .xterm-screen right 이고 ≤ pane host right 인가.
#   color: 상자 배경·전경·밑줄·caret 색(DOM) — 테마 값과의 대조는 표에서.
import json, sys
raw, name, mode = sys.argv[1:]
m = json.load(open(f'{raw}/{name}.json'))
view = m['compositionView']['rect']; cur = m['cursor'][0]['rect'] if m['cursor'] else None; caret = m.get('caret')
out = {'name': name, 'mode': mode, 'dpr': m['dpr'], 'hasFocus': m['hasFocus'], 'xtermFocusClass': m.get('xtermFocusClass'), 'cursor_classes': [c['cls'] for c in m['cursor']],
       'box': view, 'caret': caret, 'composing_text': m['compositionView']['text'], 'active': m['compositionView']['active']}
fail = False
if mode == 'mid':
  w = cur['width']  # 커서 칸이 1칸 글자 위라고 본다(ASCII 줄) — 커서 span 폭 = 칸 폭
  covered = []
  for k in range(0, 8):
    lo = cur['left'] + k * w; hi = lo + w
    ov = min(hi, view['right']) - max(lo, view['left'])
    if ov > 1.0: covered.append({'k': k, 'overlap_px': round(ov, 3)})
  out['cell_width'] = w; out['covered_cells'] = covered; out['covered_count'] = len(covered)
  if caret: out['caret_over_cell_k'] = int((caret['left'] - cur['left']) // w)
elif mode == 'edge':
  sr = m['screen']['right']; hr = m['host']['right']
  out['screen_right'] = sr; out['host_right'] = hr
  out['box_right'] = view['right']; out['caret_right'] = (caret['left'] + caret['width']) if caret else None
  right = max(view['right'], out['caret_right'] or 0)
  out['inside_screen'] = right <= sr + 0.01; out['inside_host'] = right <= hr + 0.01
  fail = not (out['inside_screen'] and out['inside_host'])
elif mode == 'color':
  st = m['compositionView']['style']
  out.update({'box_bg': st['background-color'], 'box_fg': st['color'], 'underline': st['text-decoration-line'], 'caret_bg': caret['backgroundColor'] if caret else None, 'caret_width': caret['width'] if caret else None})
out['fail'] = fail
print(json.dumps(out, indent=1, ensure_ascii=False))
sys.exit(1 if fail else 0)
