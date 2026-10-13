// LIFE-590 최종 관문 관찰 — 합성 ⌘⇧E(explorer.show)가 터미널 포커스에서 탐색기 트리로 포커스를 옮기는가. 새 빌드·기준 빌드에 같은 탐침(F2 회귀인지 가른다).
// 대조: 트리 행을 누르면 트리 포커스 + ↓('Down') 로 선택 이동(키 경로 자체는 산다).
// 사용(app/ 에서): node scripts/l590/cmd-shift-e-probe.mjs --root /tmp/l590g-* --repo /tmp/l590g-t/repo --out <json>
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const js = (e) => evalJs(root, e)
const key = (k, m = []) => ctl(root, { cmd: 'key', keyCode: k, modifiers: m })
const state = () => js(`({ treeFocused: !!document.activeElement?.closest('[data-explorer-tree]'), active: document.activeElement?.className ?? null, selected: document.querySelector('[data-explorer-row][aria-selected="true"]')?.dataset.explorerRow ?? null, visible: document.visibilityState, hasFocus: document.hasFocus() })`)
await repoPane(root, { repo: values.repo })
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
await sleep(1000)
const out = { start: await state() }
await key('E', ['meta', 'shift'])
await sleep(1500)
out.afterCmdShiftE = await state()
await until(async () => (await ctl(root, { cmd: 'click', selector: '[data-explorer-row="src"]' })).ok === true, { label: 'click src' })
await sleep(400)
out.afterRowClick = await state()
await key('Down')
await sleep(400)
out.afterDown = await state()
out.control = out.afterRowClick.treeFocused && out.afterDown.selected !== out.afterRowClick.selected
writeJson(values.out, out)
console.log(JSON.stringify(out))
process.exit(out.control ? 0 : 1)
