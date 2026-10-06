#!/bin/sh
# LIFE-515 K3ⓔ — ⌘⌥T(Mod+Alt+T) 충돌 원자료. 읽기만 한다.
#   ① corral ACTIONS 기본값 전부(빌드 소스에서) ② 사용자 <userData>/keybindings.json(없으면 없음) ③ 실행 중 Electron 앱 메뉴 accelerator(격리 K7 회차 menu-dump.json)
#   ④ macOS 심볼릭 단축키(키코드 17 = T, 수식 0x180000 = ⌘⌥)·전역 NSUserKeyEquivalents 에서 ⌘⌥T
# 사용(저장소 루트): sh app/scripts/l515/k3-conflicts.sh <menu-dump.json>
set -eu
MENU=$1
NODE="$HOME/.nvm/versions/node/v24.14.1/bin/node"
UD="$HOME/Library/Application Support/corral"
echo "# k3-conflicts — $(date '+%F %T') · HEAD $(git rev-parse --short HEAD)"
echo
echo "## ① corral ACTIONS 기본값 (app/src/shared/keybindings.ts)"
(cd app && npx tsx -e "import('./src/shared/keybindings.ts').then(({ ACTIONS, formatBinding, bindingConflict }) => { for (const a of ACTIONS) console.log('- ' + a.id + ' · ' + a.title + ' · ' + a.defaultBinding.map(formatBinding).join(' ')); const all = ACTIONS.flatMap((a) => a.defaultBinding.map((b) => [b, a.id])); const hits = all.filter(([b]) => b === 'Mod+Alt+T'); console.log('Mod+Alt+T 기본값 보유 액션: ' + hits.map(([, id]) => id).join(', ')); console.log('기본값끼리 충돌(bindingConflict({})): ' + (bindingConflict({}) ?? '없음')); console.log('액션 수: ' + ACTIONS.length) })")
echo
echo "## ② 사용자 userData keybindings.json (읽기만)"
if [ -f "$UD/keybindings.json" ]; then echo "있음 $(shasum -a 256 "$UD/keybindings.json" | cut -d' ' -f1)"; grep -n -i 'alt+t' "$UD/keybindings.json" || echo "Alt+T 문자열 없음"; else echo "없음 — 재정의 0, 비켜 서기(YIELDING_DEFAULTS) 발동 없음"; fi
echo
echo "## ③ 실행 중 Electron 앱 메뉴 accelerator ($MENU)"
"$NODE" -e "
const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))
const rows = []
const walk = (items, trail) => { for (const i of items || []) { const acc = i.accelerator || i.roleAccelerator; if (acc) rows.push(trail.concat(i.label).join(' › ') + ' | role ' + i.role + ' | ' + acc); walk(i.items, trail.concat(i.label)) } }
for (const top of d.menu) walk(top.items, [top.label])
for (const r of rows) console.log('- ' + r)
const norm = (v) => (v || '').toLowerCase().replace(/cmdorctrl|commandorcontrol|cmd/g, 'command').replace(/option/g, 'alt').replace(/\s/g, '')
const chord = (key) => rows.filter((r) => { const n = norm(r.split(' | ').pop()); return n.split('+').sort().join('+') === ['alt', 'command', key].sort().join('+') })
const hit = chord('t')
console.log('accelerator 있는 항목 ' + rows.length + '개 · ⌘⌥T: ' + (hit.length ? hit.join(' / ') : '없음'))
// 양성 대조 — 같은 판정기로 ⌘⌥H(Hide Others)·⌘⌥I(Toggle Developer Tools)는 잡혀야 한다.
console.log('양성 대조 ⌘⌥H: ' + (chord('h').join(' / ') || '못 잡음(판정기 고장)') + ' · ⌘⌥I: ' + (chord('i').join(' / ') || '못 잡음(판정기 고장)'))
" "$MENU"
echo
echo "## ④ macOS 심볼릭 단축키·전역 키 등가물 (읽기만, 코디 c6 재확인)"
defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys 2>/dev/null > /tmp/l515-symhot.txt || true
"$NODE" -e "
const t = require('fs').readFileSync('/tmp/l515-symhot.txt', 'utf8')
const blocks = t.split(/\n {4}(?=\d+ = )/)
const params = (b) => { const m = /parameters = +\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/.exec(b.replace(/\n/g, ' ')); return m ? m.slice(1).map(Number) : null }
const enabled = blocks.filter((b) => /enabled = 1/.test(b))
const parsed = enabled.filter((b) => params(b) !== null)
const hits = parsed.filter((b) => params(b)[1] === 17 && params(b)[2] === 1572864)
console.log('활성 항목 중 키코드 17 + 0x180000(⌘⌥): ' + (hits.length ? hits.map((b) => b.split(' = ')[0].trim()).join(', ') : '없음') + ' (전체 블록 ' + blocks.length + ' · 활성 ' + enabled.length + ' · 키 칸을 읽은 활성 ' + parsed.length + ')')
// 양성 대조 — 같은 파서가 읽은 활성 항목 몇 개를 그대로 찍는다(파서가 아무것도 못 읽어 「없음」 이 된 것이 아님을 보인다).
console.log('양성 대조(읽은 활성 항목 앞 5개 id: [ascii, keycode, modifiers]): ' + parsed.slice(0, 5).map((b) => b.split(' = ')[0].trim().replace(/[{\s]/g, '') + ':' + JSON.stringify(params(b))).join(' · '))
"
G=$(defaults read -g NSUserKeyEquivalents 2>/dev/null || echo '(없음)'); echo "NSUserKeyEquivalents(전역): $(echo "$G" | grep -c '@~t' || true)건 ⌘⌥T ('@~t')"
echo "참고: Option-Command-T 는 Finder 창 툴바 표시/숨김(Finder 앞일 때만, c2 W7) — corral 이 앞이면 무관"
