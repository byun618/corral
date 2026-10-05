// LIFE-495 G4 r2 — MRU 진단(읽기 전용 관측 + CGEvent ⌘T·⌘D·⌘W + 제어 소켓 ⌃Tab 홀드). k8e-mru-moved 가 구현 빌드에서만 실패한 이유를 base 와 같은 걸음으로 대조한다.
// 결과: 두 빌드 모두 ⌘W(분할 pane 닫기) 뒤 MRU 기록 맨 앞이 화면의 pane 이 아니다 — 기존 동작(이 작업의 회귀 아님). 사용: node mru-diag.mjs (ROOT /tmp/l495n2 고정)
import { rpc } from '/Users/byun/repos/byun618/corral/.claude/worktrees/LIFE-495-tab-menu-claude/app/scripts/gui-diff/lib/corral.mjs'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
const ctl = '/tmp/l495n2/ctl.sock'
const c = (r) => rpc(ctl, r)
const ev = async (code) => (await c({ cmd: 'eval', code })).result
const pid = fs.readFileSync('/tmp/l495n2/app.pid', 'utf8').trim()
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const kp = async (code, ...mods) => { execFileSync('/tmp/l495b/activate', [pid]); await pause(120); execFileSync('/tmp/l495b/keypost', [pid, String(code), ...mods]); await pause(700) }
const focus = () => ev(`document.activeElement?.closest?.('[data-term-pane]')?.dataset.termPane ?? null`)
const sel = () => ev(`document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null`)
const tabs = await ev(`[...document.querySelectorAll('[data-main-tab]')].map((t) => t.dataset.mainTab)`)
await c({ cmd: 'click', selector: `[data-main-tab="${tabs[1]}"]` }); await pause(700)
console.log('click', await focus(), await sel())
await kp(17, 'cmd'); console.log('⌘T', await focus(), await sel())
await kp(2, 'cmd'); console.log('⌘D', await focus(), await sel())
await ev(`(() => { window.__sel = []; const mo = new MutationObserver(() => { const s = document.querySelector('[data-term-pane-box].is-selected')?.dataset.termPaneBox ?? null; const a = document.querySelector('[data-main-tab][data-active="true"]')?.dataset.mainTab ?? null; const last = window.__sel.at(-1); const key = s + '|' + a; if (last !== key) window.__sel.push(key) }); mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'data-active'] }); window.__mo = mo; return 1 })()`)
await kp(13, 'cmd'); console.log('⌘W', await focus(), await sel())
console.log('trace', JSON.stringify(await ev(`(() => { window.__mo.disconnect(); return window.__sel })()`)))
await c({ cmd: 'key', keyCode: 'Control', modifiers: ['control'], types: ['keyDown'] })
await c({ cmd: 'key', keyCode: 'Tab', modifiers: ['control'], types: ['keyDown'] })
await pause(300)
console.log('hold', JSON.stringify(await ev(`({ rows: [...document.querySelectorAll('[data-mru-row]')].map((r) => r.dataset.mruRow + (r.dataset.mruSelected === 'true' ? '*' : '')) })`)))
await c({ cmd: 'key', keyCode: 'Tab', modifiers: ['control'], types: ['keyUp'] })
await c({ cmd: 'key', keyCode: 'Control', modifiers: [], types: ['keyUp'] })
await pause(600)
console.log('after', await focus(), await sel())
