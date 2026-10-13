// LIFE-590 E1ⓓ 하위 방향(격리) — 새 빌드가 쓴 **새 형식** `ui-prefs.json`(파일 탭 id·previewTabId·layoutFormat 2 + 터미널 탭 핀·색)을
// 기준 commit 빌드가 같은 userData 로 읽는다: 죽지 않고 터미널 탭 배치(순서·활성)·핀·색이 유지된다(파일 탭 항목은 무시돼도 된다).
// 기준 빌드 = `--base` 폴더(`git archive <기준> app` + node_modules 심링크 + `npm run build`). 같은 herdr 세션(g-down term 은 앱만 내린다)이라 터미널 탭 id 가 같다.
// 사용(app/ 에서, iso.sh 가 띄운 새 빌드 위에서): node scripts/l590/e1d-compat.mjs --root /tmp/l590g-* --fake /tmp/l590g-f* --repo /tmp/l590g-t/repo --base /tmp/l590-base/app --out <dir>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { checkRoot, ctl, evalJs, repoPane, sleep, until, writeJson } from './lib.mjs'

const { values } = parseArgs({ options: { root: { type: 'string' }, fake: { type: 'string' }, repo: { type: 'string' }, base: { type: 'string' }, out: { type: 'string' } } })
checkRoot(values.root)
const root = values.root
const app = process.cwd()
fs.mkdirSync(values.out, { recursive: true })
const js = (expression) => evalJs(root, expression)
const click = (selector) => until(async () => (await ctl(root, { cmd: 'click', selector })).ok === true, { timeoutMs: 10_000, everyMs: 100, label: `click ${selector}` })
const key = (keyCode, modifiers = []) => ctl(root, { cmd: 'key', keyCode, modifiers })
const rect = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`)
const rightClick = async (selector) => {
  const r = await rect(selector)
  const at = { x: Math.round(r.x + 40), y: Math.round(r.y + r.h / 2) }
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseDown', ...at, button: 'right' })
  await ctl(root, { cmd: 'raw-mouse', type: 'mouseUp', ...at, button: 'right' })
}
const tabs = () => js(`[...document.querySelectorAll('[data-main-tab]')].map((e) => ({ id: e.dataset.mainTab, active: e.dataset.active, pinned: e.dataset.tabPinned ?? null, color: e.dataset.tabColor ?? null }))`)
const shot = async (name) => {
  const result = await ctl(root, { cmd: 'shot', name }).catch(() => null)
  if (result?.ok && typeof result.file === 'string') fs.copyFileSync(result.file, path.join(values.out, `${name}.png`))
}
const prefsFile = path.join(root, 'ud', 'ui-prefs.json')

// ① 새 빌드 — 터미널 탭 둘(⌘T), 첫째 핀·둘째 색, 파일 탭 둘(고정·미리보기)
await repoPane(root, { repo: values.repo })
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
if ((await js(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await key('L', ['meta'])
await until(async () => (await js(`document.querySelectorAll('[data-explorer-row]').length`)) > 0, { label: 'rows' })
const terminalIds = async () => (await tabs()).filter((tab) => !tab.id.startsWith('file:')).map((tab) => tab.id)
const firstTerminals = await terminalIds()
await key('T', ['meta'])
await until(async () => ((await terminalIds()).length > firstTerminals.length ? true : null), { timeoutMs: 15_000, label: 'second terminal' })
await sleep(1500)
const [t1, t2] = await terminalIds()
await rightClick(`[data-main-tab="${t1}"]`)
await click(`[data-tab-menu-pin="${t1}"]`)
await until(async () => ((await tabs()).find((tab) => tab.id === t1)?.pinned === 'true' ? true : null), { label: 'pinned' })
await key('Escape')
await rightClick(`[data-main-tab="${t2}"]`)
await until(() => js(`!!document.querySelector('[data-tab-menu-colors] [data-tab-menu-color]:not([data-tab-menu-color="none"])')`), { label: 'color menu' })
const colorValue = await js(`document.querySelector('[data-tab-menu-colors] [data-tab-menu-color]:not([data-tab-menu-color="none"])').dataset.tabMenuColor`)
await click(`[data-tab-menu-color="${colorValue}"]`)
await until(async () => ((await tabs()).find((tab) => tab.id === t2)?.color !== null ? true : null), { label: 'colored' })
await key('Escape')
await ctl(root, { cmd: 'dblclick', selector: '[data-explorer-row="README.md"]' })
await until(() => js(`!!document.querySelector('[data-file-view="README.md"] [data-editor-ready]')`), { label: 'readme' })
await click('[data-explorer-row="config"]').catch(() => null)
await until(() => js(`!!document.querySelector('[data-explorer-row="config/settings.json"]')`), { label: 'config row' })
await click('[data-explorer-row="config/settings.json"]')
await until(() => js(`!!document.querySelector('[data-file-view="config/settings.json"] [data-editor-ready]')`), { label: 'json' })
// 터미널 t2 를 활성으로 두고 저장(디바운스) 대기
await click(`[data-main-tab="${t2}"]`)
await sleep(2000)
const newState = await tabs()
await shot('e1d-01-new-build')
const newPrefsText = fs.readFileSync(prefsFile, 'utf8')
fs.writeFileSync(path.join(values.out, 'ui-prefs.new-format.json'), newPrefsText)
const newPrefs = JSON.parse(newPrefsText)
const newFormat = JSON.stringify(newPrefs.groupLayouts ?? null)
const formatOk = newFormat.includes('"layoutFormat":2') && newFormat.includes('file:README.md') && newFormat.includes('previewTabId')

// ② 앱만 내리고(herdr 세션 유지) 기준 빌드로 같은 userData 를 띄운다
execFileSync('sh', ['scripts/l577/g-down.sh', root, 'term'], { stdio: 'ignore' })
await sleep(1000)
// 기준 폴더는 git 밖(`git archive`)이라 g-up 의 guard herdr 경로 계산(`git rev-parse --git-common-dir`)에 이 레포를 알려 준다 — backend 는 기준과 같다(diff 0).
const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
const baseUp = execFileSync('sh', [path.join(app, 'scripts/l577/g-up.sh'), root, values.fake], { cwd: values.base, encoding: 'utf8', env: { ...process.env, GIT_DIR: commonDir } })
fs.writeFileSync(path.join(values.out, 'base-g-up.log'), baseUp)
const basePid = Number(fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim())
const appPath = execFileSync('ps', ['-o', 'command=', '-p', String(basePid)], { encoding: 'utf8' }).trim()
await until(async () => ((await js(`document.querySelectorAll('[data-main-tab]').length`).catch(() => 0)) >= 2 ? true : null), { timeoutMs: 30_000, label: 'base tabs' })
await sleep(3000)
const baseState = await tabs()
await shot('e1d-02-base-build')
await sleep(3000)
const baseAlive = (() => {
  try {
    process.kill(basePid, 0)
    return true
  } catch {
    return false
  }
})()
const electronLogs = fs.readdirSync(root).filter((name) => /^electron-\d+\.log$/.test(name)).sort()
const baseLog = fs.readFileSync(path.join(root, electronLogs.at(-1)), 'utf8')
fs.writeFileSync(path.join(values.out, 'base-electron.log'), baseLog)
const prefsAfterBase = fs.readFileSync(prefsFile, 'utf8')
fs.writeFileSync(path.join(values.out, 'ui-prefs.after-base.json'), prefsAfterBase)

const term = (list) => list.filter((tab) => !tab.id.startsWith('file:'))
const checks = {
  'new-format-written': formatOk,
  'base-runs-from-base-dir': appPath.includes(values.base),
  'base-alive': baseAlive,
  'base-no-uncaught': !/Uncaught|unhandled|TypeError|ReferenceError/i.test(baseLog),
  'terminal-order-kept': JSON.stringify(term(baseState).map((tab) => tab.id)) === JSON.stringify(term(newState).map((tab) => tab.id)),
  'terminal-active-kept': term(baseState).find((tab) => tab.active === 'true')?.id === t2,
  'pin-kept': baseState.find((tab) => tab.id === t1)?.pinned === 'true',
  'color-kept': baseState.find((tab) => tab.id === t2)?.color === newState.find((tab) => tab.id === t2)?.color && baseState.find((tab) => tab.id === t2)?.color !== null,
  'file-tabs-ignored': baseState.every((tab) => !tab.id.startsWith('file:')),
}
const result = { root, base: values.base, basePid, appPath, t1, t2, colorValue, newState, baseState, checks }
writeJson(path.join(values.out, 'e1d-compat.json'), result)
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name)
console.log(JSON.stringify({ newState, baseState, failed }))
process.exit(failed.length === 0 ? 0 : 1)
