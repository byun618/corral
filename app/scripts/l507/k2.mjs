// LIFE-507 K2(508) 격리 시나리오 — 분할 pane 을 ⌘W 로 닫은 직후 MRU 맨 앞이 화면의 포커스 pane 인가, 그 직후 ⌃Tab 이 화면을 MRU 둘째로 옮기는가.
// 495 `mru-diag.mjs` 와 같은 걸음(탭 클릭 → ⌘T → ⌘D → ⌘W → ⌃Tab 홀드 → 놓기). 다른 탭이 MRU 에 있는 조건 = P 의 탭 t1·t2 를 먼저 클릭.
// 키는 제어 소켓 `key`(sendInputEvent — main 의 before-input-event 를 지난다). 화면 = `[data-term-pane-box].is-selected`.
// 판정 출력: `VERDICT {...}`. exit 0 = 끝까지 돌았다. 사용: node k2.mjs <app 폴더> <n>  |  node k2.mjs --native <ROOT>
import { isoUp, isoDown, nativeHandle, herdr, herdrJson, state, ev, click, until, pause } from './iso.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [app, n] = process.argv.slice(2)
if (!app || !n) throw new Error('사용: node k2.mjs <app> <n>  |  node k2.mjs --native <ROOT=/tmp/l507n*>')
const log = (...parts) => console.log(...parts)
// `--native <ROOT>` — 네이티브 회차(K6ⓑ): native-up.sh 가 띄운 corral·herdr default 에서 같은 걸음. 끄기는 native-down.sh.
const native = app === '--native'
const h = native ? nativeHandle({ root: n, log }) : await isoUp({ app, n, log })
const P = h.fixture.root
let code = 0
const screen = () => ev(h, `({ pane: document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null, tab: document.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? null, panes: [...document.querySelectorAll('[data-term-pane-box]')].map((e) => e.dataset.termPaneBox) })`)
const key = (keyCode, modifiers, types) => rpc(h.ctl, { cmd: 'key', keyCode, modifiers, ...(types ? { type: types } : {}) })
const wsP = async () => (await state(h)).repos.flatMap((repo) => repo.worktrees).find((row) => row.path === P)?.workspace ?? null
const step = async (label, run, wait = 900) => {
  await run()
  await pause(wait)
  const row = { label, screen: await screen(), herdrPanes: (await wsP())?.tabs.map((tab) => `${tab.tabId}:${tab.panes.map((pane) => pane.paneId + (pane.focused ? '*' : '')).join('|')}`) ?? [] }
  log('STEP', JSON.stringify(row))
  return row
}

let ws = null
try {
  ws = herdrJson(h, ['workspace', 'create', '--cwd', P, '--no-focus']).result.workspace.workspace_id
  herdrJson(h, ['tab', 'create', '--workspace', ws, '--cwd', P, '--no-focus'])
  await until(async () => (await wsP())?.tabs.length === 2, 'P 2 tabs', 15_000)
  await click(h, `[data-worktree="${P}"] [data-worktree-card-surface]`)
  await until(async () => (await ev(h, `document.querySelectorAll('[data-main-tab]').length`)) === 2, 'tabs in DOM', 15_000)
  await pause(600)
  await step('click t1', () => click(h, `[data-main-tab="${ws}:t1"]`))
  await step('click t2', () => click(h, `[data-main-tab="${ws}:t2"]`))
  const afterT = await step('⌘T', () => key('t', ['meta']), 1500)
  const afterD = await step('⌘D', () => key('d', ['meta']), 1500)
  await ev(h, `(() => { window.__sel = []; const mo = new MutationObserver(() => { const s = document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null; const a = document.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? null; const key = s + '|' + a; if (window.__sel.at(-1) !== key) window.__sel.push(key) }); mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'data-active'] }); window.__mo = mo; return 1 })()`)
  const afterW = await step('⌘W', () => key('w', ['meta']), 1500)
  const trace = await ev(h, `(() => { window.__mo.disconnect(); return window.__sel })()`)
  log('TRACE', JSON.stringify(trace))
  await key('Control', ['control'], 'keyDown')
  await key('Tab', ['control'], 'keyDown')
  await pause(400)
  const hold = await ev(h, `[...document.querySelectorAll('[data-mru-row]')].map((r) => r.dataset.mruRow + (r.dataset.mruSelected === 'true' ? '*' : ''))`)
  log('HOLD', JSON.stringify(hold))
  await key('Tab', ['control'], 'keyUp')
  await key('Control', [], 'keyUp')
  await pause(1000)
  const afterCommit = await screen()
  log('COMMIT', JSON.stringify(afterCommit))
  const front = hold[0]?.replace('*', '') ?? null
  const second = hold[1]?.replace('*', '') ?? null
  const verdict = {
    splitClosed: afterD.screen.panes.length === 2 && afterW.screen.panes.length === 1,
    screenAfterW: afterW.screen.pane,
    mruFront: front,
    frontIsScreen: front !== null && front === afterW.screen.pane,
    mruSecond: second,
    afterCommit: afterCommit.pane,
    moved: afterCommit.pane !== afterW.screen.pane,
    movedToSecond: afterCommit.pane === second,
    paneOfT2: (await wsP())?.tabs.find((tab) => tab.tabId === `${ws}:t2`)?.panes[0]?.paneId ?? null,
    newTabPane: afterT.screen.pane,
  }
  log('VERDICT', JSON.stringify(verdict))
} catch (error) {
  log('ERROR', String(error?.stack ?? error))
  code = 1
} finally {
  // 네이티브는 만든 워크스페이스를 닫고 끝낸다(다음 걸음이 같은 fixture 에 새로 연다 — 한 worktree 에 워크스페이스 둘이 되지 않게).
  if (native) { if (ws !== null) log('native close', JSON.stringify(herdr(h, ['workspace', 'close', ws]))); process.exit(code) }
  const left = await isoDown(h)
  if (h.corralPid !== null) { try { process.kill(h.corralPid, 0); log('corral still alive', h.corralPid); code = code || 4 } catch { /* 꺼졌다 */ } }
  if (left.length > 0) code = code || 4
}
process.exit(code)
