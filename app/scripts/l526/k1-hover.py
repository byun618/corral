# LIFE-526 K1ⓑⓒ — 측정 회차의 하단 바 버튼·아이콘 computed 값(box·color·background·radius)을 상태별·앱별로 표로 낸다.
# 사용: python3 k1-hover.py <회차 폴더> [<회차 폴더> …]
import json, sys, os
STATES = ['default', 'footer-hover-settings', 'footer-hover-help', 'footer-hover-reveal']
UNITS = ['sidebar-footer', 'sidebar-footer-settings', 'sidebar-footer-settings-icon', 'sidebar-footer-help', 'sidebar-footer-help-icon',
         'sidebar-footer-reveal', 'sidebar-footer-reveal-icon', 'sidebar-footer-refresh']
for run in sys.argv[1:]:
    print(f'## `{os.path.relpath(run)}`\n')
    print('| 상태 | 단위 | 앱 | box (x,y,w,h) | color | backgroundColor | radius | padding(T R B L) | gap |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for st in STATES:
        for app in ('orca', 'corral'):
            path = os.path.join(run, f'sidebar-{st}-{app}.json')
            if not os.path.exists(path):
                continue
            el = json.load(open(path, encoding='utf8'))['elements']
            for u in UNITS:
                e = el.get(u)
                if not e or not e.get('items'):
                    continue
                it = e['items'][0]
                b, s = it['box'], it['style']
                pad = ' '.join(s.get(k, '?') for k in ('paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'))
                print(f"| {st} | {u} | {app} | {b['x']},{b['y']},{b['w']},{b['h']} | {s.get('color')} | {s.get('backgroundColor')} | {s.get('borderTopLeftRadius')} | {pad} | {s.get('gap')} |")
    print()
