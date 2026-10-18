// LIFE-592 단계 2 — ⌘Z·⌘⇧Z 가 어디에 닿는지 격리 회차로 잰다(00-analysis A9). 제품 코드는 바꾸지 않고 잰다(구현 전 기준).
// 사용(app/ 에서, iso.sh 안): node scripts/l592/undo-probe.mjs <ROOT> <OUT.json>
// 주입은 `sendInputEvent`(제어 소켓 `key`) — OS 키 입력(CGEvent) 아님. 실제 키보드 경로(NSMenu performKeyEquivalent)는 이 회차로 못 본다(E12 몫).
// 재는 것:
//   ① 메뉴 dump — Edit ▸ Undo/Redo 의 role·가속키
//   ② 탐색기 트리 포커스에서 ⌘Z·⌘⇧Z — 렌더러 window 캡처 keydown 이 받는가 · main before-input-event(로그 input.raw)가 받는가
//   ③ 시험용 <input>(이 회차가 붙인 DOM) 에 글을 치고 ⌘Z — 리스너가 막지 않으면 글이 되돌아가는가 / 캡처 리스너가 preventDefault 하면 되돌아가는가
//      (막으면 안 되돌아간다 = 페이지 keydown 이 메뉴 role 보다 먼저 · 막아도 되돌아간다 = 메뉴 role 이 페이지와 따로 돈다)
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson } from './lib.mjs'

const [root, out] = process.argv.slice(2)
if (!/^\/tmp\/l592g-[^/]+$/.test(root ?? '') || out === undefined) throw new Error('사용: undo-probe.mjs /tmp/l592g-* OUT.json')
const result = { at: new Date().toISOString(), method: 'sendInputEvent (control socket key) — not CGEvent', steps: {} }

const logFile = path.join(root, 'ud/corral.ndjson')
const logLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
const rawInputsSince = (mark) => logLines().slice(mark).filter((line) => line.includes('"input.raw"')).map((line) => JSON.parse(line))

await until(() => evalJs(root, `!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
const menu = await ctl(root, { cmd: 'menu-dump' })
const edit = menu.menu?.find((item) => item.label === 'Edit')
result.steps.menuEdit = edit ?? null

await repoPane(root)
await sleep(1500)
// 오른쪽 패널(⌘L) 열기 — 렌더러 단축키. 이미 열렸으면 그대로.
await ctl(root, { cmd: 'resize-window', width: 1280, height: 800 }).catch(() => null)
const panelOpen = async () => (await evalJs(root, `document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) === 'open'
if (!(await panelOpen())) await ctl(root, { cmd: 'key', keyCode: 'L', modifiers: ['meta'] })
await until(panelOpen, { label: '탐색기' })
await until(() => evalJs(root, `document.querySelectorAll('[data-explorer-row]').length > 0`), { label: '탐색기 행' })

// 캡처 프로브 — window 캡처(가장 먼저). preventDefault 여부는 window.__l592block 로 켠다.
await evalJs(
  root,
  `(() => { window.__l592keys = []; window.__l592block = false; if (window.__l592probe) return true; window.__l592probe = true;
    window.addEventListener('keydown', (e) => { if (!e.metaKey) return; window.__l592keys.push({ key: e.key, code: e.code, shift: e.shiftKey, target: (e.target && e.target.getAttribute && (e.target.getAttribute('data-explorer-tree') !== null ? 'explorer-tree' : e.target.tagName)) || String(e.target), at: Date.now() }); if (window.__l592block && (e.code === 'KeyZ')) { e.preventDefault(); e.stopImmediatePropagation() } }, true); return true })()`,
)

// ② 탐색기 트리 포커스
// 터미널 pane 이 늦게 포커스를 가져갈 수 있다 — 트리가 활성 요소로 남을 때까지 다시 준다(최대 5초).
await until(async () => { await ctl(root, { cmd: 'click', selector: '[data-explorer-row="docs"]' }); await sleep(300); return evalJs(root, `document.activeElement === document.querySelector('[data-explorer-tree]')`) }, { timeoutMs: 5000, label: '트리 포커스' }).catch(() => null)
let mark = logLines().length
await ctl(root, { cmd: 'key', keyCode: 'Z', modifiers: ['meta'] })
await sleep(300)
await ctl(root, { cmd: 'key', keyCode: 'Z', modifiers: ['meta', 'shift'] })
await sleep(300)
result.steps.explorerFocus = {
  activeIsTree: await evalJs(root, `document.activeElement === document.querySelector('[data-explorer-tree]')`),
  rendererKeydowns: await evalJs(root, 'window.__l592keys'),
  mainBeforeInput: rawInputsSince(mark).map((row) => ({ type: row.type ?? row.data?.type, key: row.key ?? row.data?.key, meta: row.meta ?? row.data?.meta, shift: row.shift ?? row.data?.shift })),
  // ⌘⇧Z 는 지금 terminal.zoom(렌더러 캡처 단계에서 삼킴) — 줌 상태를 본다
  zoomed: await evalJs(root, `!!document.querySelector('[data-zoomed="true"], .is-zoomed')`),
}

// ③ 시험용 input
const typeAndUndo = async (block) => {
  await evalJs(
    root,
    `(() => { document.getElementById('l592-probe-input')?.remove(); const i = document.createElement('input'); i.id = 'l592-probe-input'; i.style.cssText = 'position:fixed;left:4px;top:4px;z-index:99999;width:120px'; document.body.append(i); i.focus(); window.__l592keys = []; window.__l592block = ${block}; return document.activeElement === i })()`,
  )
  await ctl(root, { cmd: 'type', text: 'abc' })
  await sleep(200)
  const before = await evalJs(root, `document.getElementById('l592-probe-input').value`)
  mark = logLines().length
  await ctl(root, { cmd: 'key', keyCode: 'Z', modifiers: ['meta'] })
  await sleep(400)
  const after = await evalJs(root, `document.getElementById('l592-probe-input').value`)
  const keys = await evalJs(root, 'window.__l592keys')
  return { block, before, after, undone: before !== after, rendererKeydowns: keys, mainBeforeInput: rawInputsSince(mark).length }
}
result.steps.inputNoBlock = await typeAndUndo(false)
result.steps.inputBlocked = await typeAndUndo(true)
await evalJs(root, `(() => { window.__l592block = false; document.getElementById('l592-probe-input')?.remove(); return true })()`)

const page = result.steps.inputBlocked
result.verdict = {
  rendererGetsCmdZInExplorer: (result.steps.explorerFocus.rendererKeydowns ?? []).some((row) => row.code === 'KeyZ' && !row.shift),
  rendererGetsCmdShiftZInExplorer: (result.steps.explorerFocus.rendererKeydowns ?? []).some((row) => row.code === 'KeyZ' && row.shift),
  mainSeesBeforeInput: result.steps.explorerFocus.mainBeforeInput.length > 0,
  pageKeydownBeforeMenuRole: result.steps.inputNoBlock.undone && !page.undone,
  menuRoleIndependentOfPage: page.undone,
}
writeJson(out, result)
console.log(JSON.stringify(result.verdict))
