// LIFE-593 최종 관문 — E9ⓑ 끌기 회차(592 e6) 실패 진단. 592 fixture 에서 src/l592-a.ts ↔ docs 끌기를 N 회 하며 렌더러가 받은 포인터 이벤트 수·창 blur/focus·끌기 표지를 남긴다.
// 입력은 제어 소켓 raw-mouse(592 dragRow 와 같은 방식). 사용(app/ 에서, r592/iso.sh 안): node scripts/l593/drag-diag.mjs <ROOT> <OUT.json> [N]
import fs from 'node:fs'
import path from 'node:path'
import { ctl, evalJs, sleep, until, repoPane, writeJson, giveBack, giveBackLog } from './lib.mjs'

const [root, out, nArg] = process.argv.slice(2)
const N = Number(nArg ?? '5')
const repo = path.join(root, 'repo')
const q = (js) => evalJs(root, js)
const res = { at: new Date().toISOString(), runs: [] }
const center = async (sel) => { const r = (await ctl(root, { cmd: 'rect', selector: sel })).rect; return { x: Math.round(r.left + Math.min(r.width / 2, 80)), y: Math.round(r.top + r.height / 2) } }
const mouse = (type, at) => ctl(root, { cmd: 'raw-mouse', type, x: Math.round(at.x), y: Math.round(at.y), button: 'left' })
let exitCode = 1
try {
  await until(() => q(`!!document.querySelector('.app-body')`), { timeoutMs: 30_000, label: '렌더러' })
  await giveBack()
  await repoPane(root)
  await sleep(1500)
  await ctl(root, { cmd: 'resize-window', width: 1400, height: 900 }).catch(() => null)
  if ((await q(`document.querySelector('[data-right-panel]')?.dataset.rightPanel ?? null`)) !== 'open') await ctl(root, { cmd: 'key', keyCode: 'L', modifiers: ['meta'] })
  await until(() => q(`!!document.querySelector('[data-explorer-row="src"]')`), { label: 'src 행' })
  await ctl(root, { cmd: 'click', selector: '[data-explorer-row="src"]' })
  await until(() => q(`!!document.querySelector('[data-explorer-row="src/l592-a.ts"]')`), { label: '펼침' })
  await q(`(() => { window.__dd = { ev: [] }; for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup']) document.addEventListener(t, (e) => window.__dd.ev.push([t, Math.round(e.clientX), Math.round(e.clientY), Date.now()]), true); window.addEventListener('blur', () => window.__dd.ev.push(['window-blur', 0, 0, Date.now()])); window.addEventListener('focus', () => window.__dd.ev.push(['window-focus', 0, 0, Date.now()])); return true })()`)
  for (let i = 0; i < N; i += 1) {
    const fromRel = i % 2 === 0 ? 'src/l592-a.ts' : 'docs/l592-a.ts'
    const toRel = i % 2 === 0 ? 'docs' : 'src'
    if (i % 2 === 1) await until(() => q(`!!document.querySelector('[data-explorer-row="docs/l592-a.ts"]')`), { timeoutMs: 3000, label: 'docs 행' }).catch(async () => { await ctl(root, { cmd: 'click', selector: '[data-explorer-row="docs"]' }); await sleep(400) })
    await q(`(window.__dd.ev = [], true)`)
    const from = await center(`[data-explorer-row="${fromRel}"]`)
    const to = await center(`[data-explorer-row="${toRel}"]`)
    await mouse('mouseDown', from)
    for (let s = 1; s <= 6; s += 1) { await mouse('mouseMove', { x: from.x + ((to.x - from.x) * s) / 6, y: from.y + ((to.y - from.y) * s) / 6 }); await sleep(40) }
    const marks = await q(`({ dragging: document.querySelector('.explorer-scroll.is-dragging') !== null, source: document.querySelector('.explorer-row.is-drag-source')?.dataset.explorerRow ?? null, hasFocus: document.hasFocus() })`)
    await mouse('mouseUp', to)
    await sleep(800)
    const moved = fs.existsSync(path.join(repo, i % 2 === 0 ? 'docs/l592-a.ts' : 'src/l592-a.ts'))
    const ev = await q(`window.__dd.ev`)
    const counts = ev.reduce((m, [t]) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {})
    res.runs.push({ i, fromRel, toRel, from, to, marks, moved, counts, blurs: ev.filter(([t]) => t.startsWith('window-')) })
    console.log(`# ${i} moved=${moved} dragging=${marks.dragging} hasFocus=${marks.hasFocus} ${JSON.stringify(counts)}`)
    if (!moved) break
  }
  exitCode = res.runs.every((r) => r.moved) ? 0 : 1
} catch (e) { res.error = String(e?.stack ?? e); console.error(res.error) }
finally { res.giveBack = giveBackLog; res.exitCode = exitCode; writeJson(path.resolve(out), res) }
process.exit(exitCode)
