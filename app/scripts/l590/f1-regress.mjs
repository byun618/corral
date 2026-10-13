// LIFE-590 E8ⓑ — F1 탐색기·오른쪽 패널·왼쪽 사이드바·설정·단축키 무회귀(격리 합성 1회). 파일 탭이 **열린 상태**에서 돈다(F2 가 끼어든 뒤에도 그대로인지).
// 사용(app/ 에서): node scripts/l590/f1-regress.mjs --root /tmp/l590g-* --repo /tmp/l590g-t/repo --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
fs.mkdirSync(values.out, { recursive: true })
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const has = (selector) => js(`!!document.querySelector(${JSON.stringify(selector)})`)
const count = (selector) => js(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const wait = (probe, label) => until(async () => ((await probe()) ? true : null), { timeoutMs: 8000, everyMs: 50, label }).then(() => true, () => false)
const checks = []
const check = (name, pass, detail) => {
  checks.push({ name, pass: pass === true, detail })
  console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${name}`)
}
const shot = async (name) => {
  const result = await ctl(root, { cmd: 'shot', name })
  if (result.ok && typeof result.file === 'string') fs.copyFileSync(result.file, path.join(values.out, `${name}.png`))
}
const tabCount = () => count('[data-main-tab]')

await repoPane(root, { repo: values.repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await count('[data-explorer-row]')) > 0, { label: 'rows' })
// 파일 탭 하나를 고정으로 열어 둔다
await ctl(root, { cmd: 'dblclick', selector: '[data-explorer-row="README.md"]' })
await until(() => has('[data-file-view="README.md"] [data-editor-ready]'), { label: 'readme' })

// ── 탐색기: 펼침·접힘·모두 접기·보기 메뉴
const childRow = '[data-explorer-row="src/sample.ts"]'
if (await has(childRow)) await click('[data-explorer-row="src"]')
await click('[data-explorer-row="src"]')
check('explorer-expand', await wait(() => has(childRow), 'expand'), null)
await click('[data-explorer-row="src"]')
check('explorer-collapse', await wait(async () => !(await has(childRow)), 'collapse'), null)
await click('[data-explorer-row="src"]')
await wait(() => has(childRow), 'expand again')
await click('[data-explorer-collapse-all]')
check('explorer-collapse-all', await wait(async () => !(await has(childRow)), 'collapse all'), null)
await click('[data-explorer-view-menu]')
check('explorer-view-menu-open', await wait(() => has('[data-explorer-view-menu-panel]'), 'view menu'), null)
await key('Escape')
check('explorer-view-menu-close', await wait(async () => !(await has('[data-explorer-view-menu-panel]')), 'view menu close'), null)
// ⌘⇧E — 행이 막 그려진 직후 보낸 합성 ⌘⇧E 는 트리로 포커스를 옮기지 못한 회차가 있었다. 1 s 뒤 보내면 새 빌드·기준 빌드 5d4855798 둘 다 옮긴다
// (`cmd-shift-e-probe.mjs` Z28·Z29 — 시점 문제, F2 회귀 아님). 여기서는 관찰로 적고, 키보드 이동은 행을 눌러 트리에 포커스를 둔 뒤 본다(F1 E2ⓙ 경로).
await key('E', ['meta', 'shift'])
await sleep(800)
check('observe-cmd-shift-e-focus (관찰, 판정 제외 — Z28·Z29)', true, { treeFocused: await js(`!!document.activeElement?.closest('[data-explorer-tree]')`) })
await click('[data-explorer-row="src"]')
await click('[data-explorer-row="src"]') // 두 번 — 펼침 상태는 그대로, 선택·트리 포커스만
check('explorer-tree-focused-by-click', await wait(() => js(`!!document.activeElement?.closest('[data-explorer-tree]')`), 'tree focus'), null)
const selectedBefore = await js(`document.querySelector('[data-explorer-row][aria-selected="true"]')?.dataset.explorerRow ?? null`)
await key('Down') // Electron keyCode 이름 — 'ArrowDown' 은 입력되지 않는다(조사 회차)
await sleep(200)
const selectedAfter = await js(`document.querySelector('[data-explorer-row][aria-selected="true"]')?.dataset.explorerRow ?? null`)
check('explorer-arrow-select', selectedAfter !== null && selectedAfter !== selectedBefore, { selectedBefore, selectedAfter })
await shot('f1-explorer')

// ── 오른쪽 패널 ⌘L
await click('[data-file-view="README.md"] [data-file-editor]')
await key('L', ['meta'])
check('right-panel-close', await wait(async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open', 'panel close'), null)
await key('L', ['meta'])
check('right-panel-open', await wait(async () => (await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open', 'panel open'), null)

// ── 왼쪽 사이드바 ⌘B
await key('B', ['meta'])
check('sidebar-collapse', await wait(() => has('.sidebar-column.is-collapsed'), 'sidebar collapse'), null)
await key('B', ['meta'])
check('sidebar-expand', await wait(async () => !(await has('.sidebar-column.is-collapsed')), 'sidebar expand'), null)

// ── 설정 ⌘, — 단축키 목록이 다 보인다 · 닫으면 파일 탭으로 돌아온다
await key(',', ['meta'])
check('settings-open', await wait(() => has('[data-settings-page]'), 'settings'), null)
const shortcutRows = await count('[data-shortcut-action]')
check('settings-shortcuts-listed', shortcutRows >= 20, { shortcutRows })
await shot('f1-settings')
await click('[data-settings-back]')
check('settings-close-back-to-file', await wait(async () => !(await has('[data-settings-page]')) && (await has('[data-file-view="README.md"]')), 'settings close'), null)

// ── 팔레트 ⌘K
await key('K', ['meta'])
check('palette-open', await wait(() => has('[data-command-palette]'), 'palette'), null)
await key('Escape')
check('palette-close', await wait(async () => !(await has('[data-command-palette]')), 'palette close'), null)

// ── 단축키: ⌘T 새 터미널 탭 → ⌘W 로 닫기(터미널 탭 활성일 때 터미널 닫기 그대로)
const before = await tabCount()
await key('T', ['meta'])
const opened = await wait(async () => (await tabCount()) === before + 1 && (await js(`!document.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab.startsWith('file:')`)), 'new terminal tab')
check('cmd-t-new-terminal-tab', opened, { before, after: await tabCount() })
await sleep(1500)
await key('W', ['meta'])
check('cmd-w-close-terminal-tab', await wait(async () => (await tabCount()) === before, 'close terminal'), { after: await tabCount() })
await key('Escape') // 합성 ⌘W 뒤 글자 입력 막힘(Q12) — 다음 실행에 남기지 않는다

writeJson(path.join(values.out, 'f1-regress.json'), { root, checks })
const failed = checks.filter((row) => !row.pass).map((row) => row.name)
console.log(JSON.stringify({ total: checks.length, failed }))
process.exit(failed.length === 0 ? 0 : 1)
