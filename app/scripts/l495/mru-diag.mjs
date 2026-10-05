// LIFE-495 G4 r2 — MRU 진단(읽기 전용 관측 + CGEvent ⌘T·⌘D·⌘W + 제어 소켓 ⌃Tab 홀드). k8e-mru-moved 가 구현 빌드에서만 실패한 이유를 base 와 같은 걸음으로 대조한다.
// 결과(r2): 두 빌드 모두 ⌘W(분할 pane 닫기) 뒤 MRU 기록 맨 앞이 화면의 pane 이 아니다 — 기존 동작(이 작업의 회귀 아님).
// fix1 R1-03 — import 는 상대경로(독립 checkout 에서도 typecheck·build 가 돈다). R1-08 — 실행 직전·동작마다 fixture 검사: 화면의 탭이 전부
// fixture 워크스페이스 것이고, 포커스·선택 pane 이 fixture 의 pane 일 때만 다음 입력을 보낸다. 어긋나면 입력 없이 exit 3.
// 사용: node mru-diag.mjs <ROOT=/tmp/l495n*> <fixture 경로(realpath)>
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { rpc } from '../gui-diff/lib/corral.mjs'

const [root, fixture] = process.argv.slice(2)
if (!root?.startsWith('/tmp/l495n')) throw new Error('ROOT 는 /tmp/l495n*')
if (!fixture?.startsWith('/private/tmp/l495nfx')) throw new Error('fixture 는 /private/tmp/l495nfx*')
const ctl = path.join(root, 'ctl.sock')
const c = (request) => rpc(ctl, request)
const ev = async (code) => (await c({ cmd: 'eval', code })).result
const pid = fs.readFileSync(path.join(root, 'app.pid'), 'utf8').trim()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const focus = () => ev(`document.activeElement?.closest?.('[data-term-pane]')?.dataset.termPane ?? null`)
const sel = () => ev(`document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null`)

async function fixtureIds() {
  const state = (await c({ cmd: 'state' })).state
  for (const repo of state.repos) for (const row of repo.worktrees) if (row.path === fixture && row.workspace) {
    return { tabs: new Set(row.workspace.tabs.map((tab) => tab.tabId)), panes: new Set(row.workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.paneId))) }
  }
  return { tabs: new Set(), panes: new Set() }
}
/** 입력 전 검사(R1-08) — 화면 탭 전부 fixture 것 + 포커스·선택 pane 이 fixture 것(포커스가 터미널 밖이면 선택 pane 만). */
async function assertOnlyFixture(step) {
  const mine = await fixtureIds()
  const dom = await ev(`[...document.querySelectorAll('[data-main-tab]')].map((tab) => tab.dataset.mainTab)`)
  const [focused, selected] = [await focus(), await sel()]
  const ok = dom.length > 0 && dom.every((id) => mine.tabs.has(id)) && (focused === null || mine.panes.has(focused)) && selected !== null && mine.panes.has(selected)
  console.log(`check ${step} ${ok ? 'ok' : 'FAIL'} tabs=${dom.length} focus=${focused} selected=${selected}`)
  if (!ok) {
    console.log('fixture 밖 대상 — 입력을 보내지 않고 멈춘다')
    process.exit(3)
  }
}
const kp = async (step, code, ...mods) => {
  await assertOnlyFixture(step)
  execFileSync('/tmp/l495b/activate', [pid])
  await pause(120)
  execFileSync('/tmp/l495b/keypost', [pid, String(code), ...mods])
  await pause(700)
}
const key = async (step, request) => {
  await assertOnlyFixture(step)
  await c(request)
}

await assertOnlyFixture('start')
const tabs = await ev(`[...document.querySelectorAll('[data-main-tab]')].map((t) => t.dataset.mainTab)`)
await c({ cmd: 'click', selector: `[data-main-tab="${tabs[1]}"]` }); await pause(700)
console.log('click', await focus(), await sel())
await kp('⌘T', 17, 'cmd'); console.log('⌘T', await focus(), await sel())
await kp('⌘D', 2, 'cmd'); console.log('⌘D', await focus(), await sel())
await ev(`(() => { window.__sel = []; const mo = new MutationObserver(() => { const s = document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null; const a = document.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? null; const last = window.__sel.at(-1); const key = s + '|' + a; if (last !== key) window.__sel.push(key) }); mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'data-active'] }); window.__mo = mo; return 1 })()`)
await kp('⌘W', 13, 'cmd'); console.log('⌘W', await focus(), await sel())
console.log('trace', JSON.stringify(await ev(`(() => { window.__mo.disconnect(); return window.__sel })()`)))
await key('⌃Tab-down', { cmd: 'key', keyCode: 'Control', modifiers: ['control'], types: ['keyDown'] })
await key('⌃Tab', { cmd: 'key', keyCode: 'Tab', modifiers: ['control'], types: ['keyDown'] })
await pause(300)
console.log('hold', JSON.stringify(await ev(`({ rows: [...document.querySelectorAll('[data-mru-row]')].map((r) => r.dataset.mruRow + (r.dataset.mruSelected === 'true' ? '*' : '')) })`)))
await c({ cmd: 'key', keyCode: 'Tab', modifiers: ['control'], types: ['keyUp'] })
await c({ cmd: 'key', keyCode: 'Control', modifiers: [], types: ['keyUp'] })
await pause(600)
console.log('after', await focus(), await sel())
