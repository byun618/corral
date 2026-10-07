// LIFE-507 K2(508) 격리 시나리오 — 분할 pane 을 ⌘W 로 닫은 직후 MRU 맨 앞이 화면의 포커스 pane 인가, 그 직후 ⌃Tab 이 화면을 MRU 둘째로 옮기는가.
// 495 `mru-diag.mjs` 와 같은 걸음(탭 클릭 → ⌘T → ⌘D → ⌘W → ⌃Tab 홀드 → 놓기). 다른 탭이 MRU 에 있는 조건 = P 의 탭 t1·t2 를 먼저 클릭.
// 키는 제어 소켓 `key`(sendInputEvent — main 의 before-input-event 를 지난다). 화면 = `[data-term-pane-box].is-selected`.
// 판정 출력: `VERDICT {...}`. exit 0 = 끝까지 돌았다. 사용: node k2.mjs <app 폴더> <n> [focus-other]  |  node k2.mjs --native <ROOT> [focus-other]
// `focus-other`(fix1 R1-M2) — ⌘D 뒤 `herdr tab focus <t1>` 로 herdr 포커스를 **다른 탭의 pane** 에 둔 채 ⌘W 한다. 옛 규칙(herdr 포커스 pane 승격)이면
// MRU 맨 앞이 그 다른 탭 pane 이 되는 조건 — VERDICT 의 herdrFocusAtW·oldRulePick·oldRuleDiffers 가 그 조건이 성립했는지 보인다.
import { isoUp, isoDown, nativeHandle, herdr, herdrJson, state, ev, click, until, pause } from './iso.mjs'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [app, n, variant] = process.argv.slice(2)
const focusOther = variant === 'focus-other'
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
  // focus-other: 옛 규칙이 읽는 pane.focused 는 pane_created/pane_updated 페이로드로만 갱신된다(store.ts). fixture 워크스페이스를 herdr 포커스
  // 워크스페이스로 만들어 두면 t1 의 p1 이 focused 로 실린다(R047 은 우연히, R048–R051 은 아님). 만든 워크스페이스에만 한다.
  if (focusOther) log('herdr workspace focus', JSON.stringify(herdr(h, ['workspace', 'focus', ws]).status))
  herdrJson(h, ['tab', 'create', '--workspace', ws, '--cwd', P, '--no-focus'])
  await until(async () => (await wsP())?.tabs.length === 2, 'P 2 tabs', 15_000)
  await click(h, `[data-worktree="${P}"] [data-worktree-card-surface]`)
  await until(async () => (await ev(h, `document.querySelectorAll('[data-main-tab]').length`)) === 2, 'tabs in DOM', 15_000)
  await pause(600)
  await step('click t1', () => click(h, `[data-main-tab="${ws}:t1"]`))
  await step('click t2', () => click(h, `[data-main-tab="${ws}:t2"]`))
  const afterT = await step('⌘T', () => key('t', ['meta']), 1500)
  const afterD = await step('⌘D', () => key('d', ['meta']), 1500)
  // herdr 포커스를 옮기면 corral 화면이 t1 pane 을 보이는 상태로 흔들린다(R040·R041 — 기존 동작). corral 에서 t3 탭·분할 pane 을 다시 눌러
  // 화면을 ⌘D 직후로 되돌리고, herdr 포커스가 t1 에 남았는지는 STEP 의 `*` 와 VERDICT herdrFocusAtW 로 본다.
  if (focusOther) {
    await step('herdr tab focus t1', async () => log('herdr tab focus', JSON.stringify(herdr(h, ['tab', 'focus', `${ws}:t1`]))), 1200)
    await step('click t2', () => click(h, `[data-main-tab="${ws}:t2"]`))
    await step('click t3', () => click(h, `[data-main-tab="${ws}:t3"]`))
  }
  const afterFocus = focusOther ? await step('click split pane', () => click(h, `[data-term-pane-box="${afterD.screen.pane}"]`)) : null
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
  const starred = (rows) => rows.flatMap((row) => { const [w, t, ...rest] = row.split(':'); return rest.join(':').split('|').filter((pane) => pane.endsWith('*')).map((pane) => ({ tab: `${w}:${t}`, pane: pane.replace('*', '') })) })
  const focusAtW = starred(afterW.herdrPanes)
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
    focusOther,
    screenStayedAfterFocus: afterFocus === null ? null : afterFocus.screen.pane === afterD.screen.pane,
    herdrFocusAtW: focusAtW,
    // 옛 규칙(6d1273db `panes.find((pane) => pane.focused)`)은 워크스페이스 pane 을 탭 순서로 훑어 첫 focused 를 고른다. 네이티브 herdr 는 탭마다
    // 제 포커스 pane 에 focused 를 달아(R047: t1:p1*·t3:p3*) 「다른 탭에만 있다」 로는 못 가린다 — 옛 규칙이 고를 pane 을 직접 계산한다(herdrPanes 는 탭 순서).
    oldRulePick: focusAtW[0]?.pane ?? null,
    oldRuleDiffers: (focusAtW[0]?.pane ?? null) !== afterW.screen.pane,
    oldRulePickTab: focusAtW[0]?.tab ?? null,
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
