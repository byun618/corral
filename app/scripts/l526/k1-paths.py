# LIFE-526 K1ⓐ — lucide-react 0.577.0 원문(Orca 198 설치본, c4 방식)의 __iconNode 와 corral SidebarIcons.tsx 컴포넌트의 svg 자식을 문자 단위로 대조한다.
# 사용: python3 k1-paths.py <lucide icons 폴더> <SidebarIcons.tsx>
import re, sys, os
icons_dir, tsx = sys.argv[1], sys.argv[2]
PAIRS = [('settings.js', 'SettingsGearIcon'), ('circle-question-mark.js', 'CircleHelpIcon'), ('crosshair.js', 'CrosshairIcon'), ('refresh-cw.js', 'RefreshCwIcon')]
src = open(tsx, encoding='utf8').read()
def lucide(name):
    text = open(os.path.join(icons_dir, name), encoding='utf8').read()
    node = text[text.index('__iconNode = [') : text.index('];', text.index('__iconNode = ['))]
    out = []
    for tag, attrs in re.findall(r'\[\s*"(\w+)",\s*\{(.*?)\}\s*\]', node, re.S):
        kv = [(k, v) for k, v in re.findall(r'(\w+):\s*"([^"]*)"', attrs) if k != 'key']
        out.append((tag, tuple(kv)))
    return out, text
def corral(fn):
    i = src.index(f'export function {fn}(')
    body = src[i : src.index('\n}\n', i)]
    inner = body[body.index('<svg') : body.index('</svg>')]
    inner = inner[inner.index('>') + 1 :]
    out = []
    for tag, attrs in re.findall(r'<(\w+)\s+([^>]*?)/>', inner):
        out.append((tag, tuple(re.findall(r'(\w+)="([^"]*)"', attrs))))
    return out
ok_all = True
print('# K1ⓐ lucide 경로 문자 단위 대조 — lucide-react 0.577.0(' + icons_dir + ') ↔ ' + tsx)
print('# lucide 의 key 속성은 React key 라 빼고, 요소 순서·태그·속성 이름·값을 그대로 견준다\n')
for js, fn in PAIRS:
    want, text = lucide(js)
    have = corral(fn)
    same = want == have
    ok_all &= same
    print(f'## {js} ↔ {fn}: {"일치" if same else "불일치"}')
    for w in want: print('  lucide', w)
    for h in have: print('  corral', h)
    print()
print('판정:', '전부 일치' if ok_all else '불일치 있음')
sys.exit(0 if ok_all else 1)
